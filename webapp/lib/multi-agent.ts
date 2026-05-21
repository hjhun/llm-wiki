import "server-only";

import { runCli, type CliName, type RunResult } from "./cli";
import type { Config } from "./config";
import type { ChatKind } from "./chat-events";
import { appendMessage } from "./sessions";
import { errorMessage } from "./api";
import {
  buildEntityRegistryReference,
  buildLoopContinuationPrompt,
  buildProgressReference,
  clearStopFlag,
  decideLoopHalt,
  ingestMadeProgress,
  maybeAutoRunGraphify,
  readIngestStateSummary,
  readProgressSnapshot,
  stopFlagExists,
  type ProgressSnapshot,
} from "./ingest-loop";

export type OrchestratedKind = Extract<
  ChatKind,
  "ingest" | "ingest-loop" | "query" | "lint"
>;

export type MultiAgentResult = {
  finalReply: string;
  lastExitCode: number;
  totalDurationMs: number;
  assistantAgent: string;
};

type Worker = {
  index: number;
  name: string;
  cli: CliName;
};

type WorkerRun = {
  worker: Worker;
  round: number;
  result: RunResult | null;
  error: string | null;
};

const ORCHESTRATED_KINDS = new Set<ChatKind>([
  "ingest",
  "ingest-loop",
  "query",
  "lint",
]);

export function isOrchestratedKind(kind: ChatKind): kind is OrchestratedKind {
  return ORCHESTRATED_KINDS.has(kind);
}

function clampAgentCount(cfg: Config): number {
  return Math.max(
    1,
    Math.min(16, cfg.agent.orchestration.maxConcurrentAgents),
  );
}

function buildWorkers(
  cfg: Config,
  managerCli: CliName,
): Worker[] {
  const cli = cfg.agent.orchestration.cli ?? managerCli;
  const count = clampAgentCount(cfg);
  const prefix = cfg.agent.orchestration.namePrefix.trim() || "agent";
  return Array.from({ length: count }, (_, index) => {
    return {
      index,
      name: `${prefix}-${index + 1}`,
      cli,
    };
  });
}

function operationPolicy(kind: OrchestratedKind): string {
  if (kind === "query") {
    return [
      "You are a read-only query worker. Use wiki-query to find candidate pages, read evidence, and draft a Markdown answer with citations unless the user explicitly requested another format.",
      "Do not create or edit wiki/answers, wiki/index.md, wiki/log.md, or any other file. If the user requested --save, describe the proposed save target for the manager.",
    ].join("\n");
  }
  if (kind === "lint") {
    return [
      "You are a read-only lint worker. Inspect the wiki for the wiki-lint categories and return findings with file paths and evidence.",
      "Do not write wiki/lint reports, do not edit wiki/index.md, and do not apply --fix. The manager will consolidate and perform the single write pass.",
    ].join("\n");
  }
  if (kind === "ingest-loop") {
    return [
      "You are an ingest worker in a backend-managed loop. Follow wiki-ingest and process at most one sub-chunk or one merge-pass parent, then exit.",
      "A symlink located under raw/ is a valid source entry: follow it read-only even if its real target is outside the repository, preserve logical raw/... paths in state/citations, and reject only broken links or loops.",
      "If wiki/.progress/ingest/.lock is held by another live process, report that you are standing by and exit successfully. The manager will launch the next round.",
      "Do NOT run wiki-graphify and do NOT write anything under wiki/graph/. The backend triggers graph updates as separate invocations after the round completes.",
    ].join("\n");
  }
  return [
    "You are an ingest worker. Follow wiki-ingest and process exactly one sub-chunk or one merge-pass parent, then exit.",
    "A symlink located under raw/ is a valid source entry: follow it read-only even if its real target is outside the repository, preserve logical raw/... paths in state/citations, and reject only broken links or loops.",
    "If wiki/.progress/ingest/.lock is held by another live process, report that you are standing by and exit successfully.",
    "Do NOT run wiki-graphify and do NOT write anything under wiki/graph/. The backend triggers graph updates as separate invocations after the round completes.",
  ].join("\n");
}

function wrapWorkerPrompt(input: {
  basePrompt: string;
  kind: OrchestratedKind;
  worker: Worker;
  round: number;
  totalWorkers: number;
  entityRegistryRef?: string | null;
}): string {
  const lines = [
    "You are operating as a named worker in an LLM Wiki multi-agent run.",
    `Worker name: ${input.worker.name}`,
    `Worker CLI: ${input.worker.cli}`,
    `Worker slot: ${input.worker.index + 1}/${input.totalWorkers}`,
    `Round: ${input.round}`,
    "A central manager agent will review all worker outputs, decide whether the operation is complete, and report to the user.",
    "The host webapp already created the active chat session. Do not create, rename, delete, or allocate any sessions/*.md file; use the Active session log supplied in the manager task.",
    operationPolicy(input.kind),
  ];
  // Round 1 only: continuation rounds already carry the registry in basePrompt.
  if (input.round === 1 && input.entityRegistryRef) {
    lines.push(input.entityRegistryRef);
  }
  lines.push("", "===== MANAGER-PROVIDED TASK =====", input.basePrompt);
  return lines.join("\n");
}

function shortOutput(run: WorkerRun, cap = 3500): string {
  if (run.error) return `ERROR: ${run.error}`;
  const result = run.result;
  if (!result) return "No result.";
  const body = result.stdout.trim() || result.stderr.trim() || "(empty output)";
  const header = `exitCode=${result.exitCode}, durationMs=${result.durationMs}`;
  const text = `${header}\n${body}`;
  return text.length > cap ? `${text.slice(0, cap)}\n...<truncated>...` : text;
}

async function runWorkerBatch(input: {
  cfg: Config;
  kind: OrchestratedKind;
  workers: Worker[];
  basePrompt: string;
  round: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}): Promise<WorkerRun[]> {
  input.onChunk?.(
    `\n\n---\n[multi-agent round ${input.round}] ${input.workers
      .map((worker) => `${worker.name}:${worker.cli}`)
      .join(", ")}\n`,
  );
  const entityRegistryRef =
    input.kind === "ingest" || input.kind === "ingest-loop"
      ? await buildEntityRegistryReference()
      : null;
  return Promise.all(
    input.workers.map(async (worker): Promise<WorkerRun> => {
      const prompt = wrapWorkerPrompt({
        basePrompt: input.basePrompt,
        kind: input.kind,
        worker,
        round: input.round,
        totalWorkers: input.workers.length,
        entityRegistryRef,
      });
      const started = Date.now();
      input.onChunk?.(`[${worker.name}] start\n`);
      try {
        const result = await runCli(worker.cli, prompt, {
          safeMode: input.cfg.agent.safeMode,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          killOnAbort: input.signal ? true : input.timeoutMs != null,
        });
        input.onChunk?.(
          `[${worker.name}] done exitCode=${result.exitCode} durationMs=${result.durationMs}\n`,
        );
        return { worker, round: input.round, result, error: null };
      } catch (err) {
        const message = errorMessage(err);
        input.onChunk?.(
          `[${worker.name}] error after ${Date.now() - started}ms: ${message}\n`,
        );
        return { worker, round: input.round, result: null, error: message };
      }
    }),
  );
}

function buildManagerPrompt(input: {
  kind: OrchestratedKind;
  managerName: string;
  sessionPath: string;
  userPrompt: string;
  runs: WorkerRun[];
  progressNote?: string | null;
}): string {
  const workerSections = input.runs.map((run) =>
    [
      `## ${run.worker.name} (${run.worker.cli}) round ${run.round}`,
      shortOutput(run),
    ].join("\n"),
  );
  const writePolicy =
    input.kind === "query"
      ? "For /query, write the final answer in Korean Markdown with citations unless the original task explicitly requested another format. Only save to wiki/answers if the user explicitly requested it."
      : input.kind === "lint"
        ? "For /lint, use worker findings as inspection input, then perform exactly one manager write pass following wiki-lint, including report/log/index updates and --fix only if requested."
        : "For ingest operations, do not re-run ingest work in this manager pass. Review progress and worker outputs, then report complete/stopped/error status clearly.";

  return [
    "You are the central manager agent for an LLM Wiki multi-agent run.",
    `Manager name: ${input.managerName}`,
    `Active session log: sessions/${input.sessionPath}`,
    "Read CLAUDE.md/AGENTS.md and follow the operation-specific wiki skills. Project .agents/skills takes priority.",
    writePolicy,
    "If a worker failed but another worker completed the needed operation, treat the run as complete with a warning. If all workers failed, report the blocker and the exact retry needed.",
    input.progressNote ? `Progress note:\n${input.progressNote}` : "",
    "",
    "===== ORIGINAL TASK =====",
    input.userPrompt,
    "",
    "===== WORKER RESULTS =====",
    workerSections.join("\n\n---\n\n"),
    "",
    "Respond now as the manager. Summarize what each named worker contributed, whether the operation is complete or needs another run, and the final user-facing result.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runManager(input: {
  cfg: Config;
  agent: CliName;
  kind: OrchestratedKind;
  sessionPath: string;
  userPrompt: string;
  runs: WorkerRun[];
  progressNote?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}): Promise<RunResult> {
  const managerName = input.cfg.agent.orchestration.managerName.trim() || "manager";
  input.onChunk?.(`\n\n---\n[${managerName}] consolidating worker results\n`);
  return runCli(
    input.agent,
    buildManagerPrompt({
      kind: input.kind,
      managerName,
      sessionPath: input.sessionPath,
      userPrompt: input.userPrompt,
      runs: input.runs,
      progressNote: input.progressNote,
    }),
    {
      safeMode: input.cfg.agent.safeMode,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      killOnAbort: input.signal ? true : input.timeoutMs != null,
      onStdout: (chunk) => input.onChunk?.(chunk),
    },
  );
}

async function runSingleRoundOperation(input: {
  cfg: Config;
  kind: OrchestratedKind;
  agent: CliName;
  sessionPath: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}): Promise<MultiAgentResult> {
  const orchestrationCli = input.cfg.agent.orchestration.cli ?? input.agent;
  const workers = buildWorkers(input.cfg, orchestrationCli);
  const ingestBefore =
    input.kind === "ingest" ? await readProgressSnapshot() : null;
  const runs = await runWorkerBatch({
    cfg: input.cfg,
    kind: input.kind,
    workers,
    basePrompt: input.prompt,
    round: 1,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onChunk: input.onChunk,
  });
  let progressNote: string | null = null;

  if (input.kind === "ingest" && ingestBefore) {
    const ingestAfter = await readProgressSnapshot();
    const progressAdvanced = ingestMadeProgress(
      ingestBefore,
      ingestAfter,
    );
    progressNote = `ingest progress advanced=${progressAdvanced}`;
    const bestExit = runs.some((run) => run.result?.exitCode === 0) ? 0 : 1;
    const graph = await maybeAutoRunGraphify({
      cfg: input.cfg,
      agent: orchestrationCli,
      sessionPath: input.sessionPath,
      lastExitCode: bestExit,
      before: ingestBefore,
      after: ingestAfter,
      mode: "incremental",
      onChunk: input.onChunk,
    });
    if (graph.note) progressNote += `\n${graph.note}`;

    if (progressAdvanced && graph.action !== "update") {
      const finalGraph = await maybeAutoRunGraphify({
        cfg: input.cfg,
        agent: orchestrationCli,
        sessionPath: input.sessionPath,
        lastExitCode: bestExit,
        before: ingestBefore,
        after: ingestAfter,
        mode: "final",
        onChunk: input.onChunk,
      });
      if (finalGraph.note) progressNote += `\n${finalGraph.note}`;
    }
  }

  const manager = await runManager({
    cfg: input.cfg,
    agent: orchestrationCli,
    kind: input.kind,
    sessionPath: input.sessionPath,
    userPrompt: input.prompt,
    runs,
    progressNote,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onChunk: input.onChunk,
  });
  const finalReply =
    manager.stdout.trim() ||
    manager.stderr.trim() ||
    `(manager returned empty output. exitCode=${manager.exitCode})`;
  const workerDuration = runs.reduce(
    (sum, run) => sum + (run.result?.durationMs ?? 0),
    0,
  );
  return {
    finalReply,
    lastExitCode: manager.exitCode,
    totalDurationMs: workerDuration + manager.durationMs,
    assistantAgent: input.cfg.agent.orchestration.managerName || "manager",
  };
}

async function runLoopOperation(input: {
  cfg: Config;
  agent: CliName;
  sessionPath: string;
  prompt: string;
  progressRef?: string | null;
  onChunk?: (text: string) => void;
}): Promise<MultiAgentResult> {
  await clearStopFlag(input.sessionPath);
  const orchestrationCli = input.cfg.agent.orchestration.cli ?? input.agent;
  const workers = buildWorkers(input.cfg, orchestrationCli);
  const maxRounds = input.cfg.cli.ingestLoop.maxIterations;
  const timeoutMs = input.cfg.cli.timeouts["ingest-loop"] ?? undefined;
  const loopBefore = await readProgressSnapshot();
  let prevSnap = loopBefore;
  let round = 0;
  let idleRounds = 0;
  let haltKind: "normal" | "error" | "stopped" | "capped" | "stalled" =
    "normal";
  let haltReason = "";
  let allRuns: WorkerRun[] = [];
  let totalDurationMs = 0;
  let lastExitCode = 0;
  let lastMergedSnap: ProgressSnapshot | null = null;
  const initialProgressRef =
    input.progressRef !== undefined
      ? input.progressRef
      : await buildProgressReference();

  await appendMessage(
    input.sessionPath,
    "system",
    `multi-agent /ingest-loop 시작 (workers=${workers.length}, maxRounds=${maxRounds}).`,
  ).catch(() => undefined);

  while (round < maxRounds) {
    if (await stopFlagExists(input.sessionPath)) {
      haltKind = "stopped";
      haltReason = "사용자 Stop 요청";
      break;
    }

    round += 1;
    const basePrompt =
      round === 1
        ? input.prompt
        : buildLoopContinuationPrompt({
            sessionPath: input.sessionPath,
            iteration: round,
            progressRef:
              initialProgressRef ?? (await buildProgressReference()),
            entityRegistryRef: await buildEntityRegistryReference(),
          });
    const runs = await runWorkerBatch({
      cfg: input.cfg,
      kind: "ingest-loop",
      workers,
      basePrompt,
      round,
      timeoutMs,
      onChunk: input.onChunk,
    });
    allRuns = allRuns.concat(runs);
    totalDurationMs += runs.reduce(
      (sum, run) => sum + (run.result?.durationMs ?? 0),
      0,
    );
    lastExitCode = runs.some((run) => run.result?.exitCode === 0) ? 0 : 1;

    const summary = await readIngestStateSummary();
    const snap = await readProgressSnapshot();
    idleRounds = ingestMadeProgress(prevSnap, snap) ? 0 : idleRounds + 1;
    const graph = await maybeAutoRunGraphify({
      cfg: input.cfg,
      agent: orchestrationCli,
      sessionPath: input.sessionPath,
      lastExitCode,
      before: prevSnap,
      after: snap,
      mode: "incremental",
      onChunk: input.onChunk,
    });
    if (graph.note) {
      allRuns.push({
        worker: {
          index: workers.length,
          name: "auto-graph",
          cli: orchestrationCli,
        },
        round,
        result: {
          stdout: graph.note,
          stderr: "",
          exitCode: graph.succeeded ? 0 : 1,
          durationMs: 0,
          stdoutTruncated: null,
          stderrTruncated: null,
        },
        error: null,
      });
    }
    if (graph.action === "update") {
      lastMergedSnap = snap;
    }
    prevSnap = snap;

    const decision = decideLoopHalt({
      exitCode: lastExitCode,
      summary,
      mergeDone: snap.mergeDone,
      mergePending: snap.mergePendingParents > 0,
      idleRounds,
      stopRequested: await stopFlagExists(input.sessionPath),
      iteration: round,
      maxIter: maxRounds,
    });
    if (decision.halt) {
      haltKind = decision.kind;
      haltReason = decision.reason;
      break;
    }
  }

  if (!haltReason && round >= maxRounds) {
    haltKind = "capped";
    haltReason = `최대 반복 ${maxRounds}회에 도달`;
  } else if (!haltReason) {
    haltReason = "loop terminated without rounds";
  }
  await clearStopFlag(input.sessionPath);

  const loopAfter = await readProgressSnapshot();
  if (haltKind !== "error") {
    const alreadyCoversLatest =
      lastMergedSnap !== null &&
      loopAfter.leavesDone <= lastMergedSnap.leavesDone &&
      loopAfter.mergeDone === lastMergedSnap.mergeDone;
    const finalGraph = alreadyCoversLatest
      ? {
          note:
            "\n\n---\n\n[auto graph] 루프 중에 full merge가 이미 실행되어 final merge는 생략합니다.",
          action: null,
          succeeded: true,
        }
      : await maybeAutoRunGraphify({
          cfg: input.cfg,
          agent: orchestrationCli,
          sessionPath: input.sessionPath,
          lastExitCode,
          before: loopBefore,
          after: loopAfter,
          mode: "final",
          onChunk: input.onChunk,
        });
    if (finalGraph.note) {
      allRuns.push({
        worker: {
          index: workers.length + 1,
          name: "auto-graph-final",
          cli: orchestrationCli,
        },
        round,
        result: {
          stdout: finalGraph.note,
          stderr: "",
          exitCode: finalGraph.succeeded ? 0 : 1,
          durationMs: 0,
          stdoutTruncated: null,
          stderrTruncated: null,
        },
        error: null,
      });
    }
  }

  const manager = await runManager({
    cfg: input.cfg,
    agent: orchestrationCli,
    kind: "ingest-loop",
    sessionPath: input.sessionPath,
    userPrompt: input.prompt,
    runs: allRuns.slice(-Math.max(workers.length * 3, 12)),
    progressNote: `[/ingest-loop ${haltKind}] ${haltReason} · rounds=${round} · progressAdvanced=${ingestMadeProgress(
      loopBefore,
      loopAfter,
    )}`,
    timeoutMs: input.cfg.cli.timeouts.chat ?? undefined,
    onChunk: input.onChunk,
  });
  totalDurationMs += manager.durationMs;
  await appendMessage(
    input.sessionPath,
    "system",
    `multi-agent /ingest-loop 종료: ${haltReason} (rounds=${round}).`,
  ).catch(() => undefined);

  return {
    finalReply:
      manager.stdout.trim() ||
      manager.stderr.trim() ||
      `(manager returned empty output. exitCode=${manager.exitCode})`,
    lastExitCode: manager.exitCode,
    totalDurationMs,
    assistantAgent: input.cfg.agent.orchestration.managerName || "manager",
  };
}

export async function runMultiAgentOperation(input: {
  cfg: Config;
  kind: OrchestratedKind;
  agent: CliName;
  sessionPath: string;
  prompt: string;
  progressRef?: string | null;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}): Promise<MultiAgentResult> {
  if (input.kind === "ingest-loop") {
    return runLoopOperation(input);
  }
  return runSingleRoundOperation({
    ...input,
    timeoutMs: input.cfg.cli.timeouts[input.kind] ?? undefined,
  });
}
