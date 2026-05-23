import "server-only";

import { runCli, type CliName, type RunResult } from "./cli";
import type { Config } from "./config";
import type { ChatKind } from "./chat-events";
import { appendMessage } from "./sessions";
import { errorMessage } from "./api";
import { maybeRefreshQmdIndex } from "./qmd";
import {
  buildEntityRegistryReference,
  buildCodeWikiStatusReference,
  buildSourcePageStatusReference,
  buildLoopContinuationPrompt,
  buildProgressReference,
  clearStopFlag,
  decideLoopHalt,
  ingestMadeProgress,
  maybeAutoRunGraphify,
  normalizeRawScope,
  readIngestStateSummary,
  readProgressSnapshot,
  stopFlagExists,
  type ProgressSnapshot,
} from "./ingest-loop";

export type OrchestratedKind = Extract<
  ChatKind,
  "ingest" | "ingest-loop" | "lint"
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
  "lint",
]);

export function isOrchestratedKind(kind: ChatKind): kind is OrchestratedKind {
  return ORCHESTRATED_KINDS.has(kind);
}

function signalAborted(signal?: AbortSignal): boolean {
  return signal?.aborted ?? false;
}

function cancellationResult(input: {
  kind: OrchestratedKind;
  assistantAgent: string;
  durationMs: number;
  exitCode?: number;
}): MultiAgentResult {
  return {
    finalReply: `사용자 Stop 요청으로 ${input.kind} 작업이 중단되었습니다.`,
    lastExitCode: input.exitCode ?? -1,
    totalDurationMs: input.durationMs,
    assistantAgent: input.assistantAgent,
  };
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
  options: { count?: number } = {},
): Worker[] {
  const cli = cfg.agent.orchestration.cli ?? managerCli;
  const count = options.count ?? clampAgentCount(cfg);
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
  if (kind === "lint") {
    return [
      "You are a read-only lint worker. Inspect the wiki for the wiki-lint categories and return findings with file paths and evidence.",
      "Do not write wiki/lint reports, do not edit wiki/index.md, and do not apply --fix. The manager will consolidate and perform the single write pass.",
    ].join("\n");
  }
  if (kind === "ingest-loop") {
    return [
      "You are an ingest worker in a backend-managed loop. Follow wiki-ingest and process at most one sub-chunk or one merge-pass parent, then exit.",
      "Every non-ignored leaf must have one wiki/sources page per original raw file recorded in source_pages_written. Repair missing source pages before reporting completion.",
      "Code Wiki is part of ingest, not a separate command. During enumeration, classify leaves as prose/code/mixed/ignore. For code or mixed leaves, run scripts/code-index.mjs when applicable, mirror the source tree under wiki/code/<project>/, create one index.md per represented source directory with directory in tags, create one wiki/code/<project>/<relative-file-path>.md page per code file with file in tags, and record those paths in code_outputs.",
      "If the progress state shows a done code/mixed leaf with missing valid wiki/code outputs, missing file-level Code Wiki pages, or missing directory index pages, treat that as the next unit of work and repair the Code Wiki outputs before reporting that ingest is complete.",
      "A symlink located under raw/ is a valid source entry: follow it read-only even if its real target is outside the repository, preserve logical raw/... paths in state/citations, and reject only broken links or loops.",
      "If wiki/.progress/ingest/.lock is held by another live process, report that you are standing by and exit successfully. The manager will launch the next round.",
      "Do NOT run wiki-graphify and do NOT write anything under wiki/graph/. The backend triggers graph updates as separate invocations only after all ingest work and merge passes are complete.",
    ].join("\n");
  }
  return [
    "You are an ingest worker. Follow wiki-ingest and process exactly one sub-chunk or one merge-pass parent, then exit.",
    "Every non-ignored leaf must have one wiki/sources page per original raw file recorded in source_pages_written. Repair missing source pages before reporting completion.",
    "Code Wiki is part of ingest, not a separate command. During enumeration, classify leaves as prose/code/mixed/ignore. For code or mixed leaves, run scripts/code-index.mjs when applicable, mirror the source tree under wiki/code/<project>/, create one index.md per represented source directory with directory in tags, create one wiki/code/<project>/<relative-file-path>.md page per code file with file in tags, and record those paths in code_outputs.",
    "If the progress state shows a done code/mixed leaf with missing valid wiki/code outputs, missing file-level Code Wiki pages, or missing directory index pages, treat that as the next unit of work and repair the Code Wiki outputs before reporting that ingest is complete.",
    "A symlink located under raw/ is a valid source entry: follow it read-only even if its real target is outside the repository, preserve logical raw/... paths in state/citations, and reject only broken links or loops.",
    "If wiki/.progress/ingest/.lock is held by another live process, report that you are standing by and exit successfully.",
    "Do NOT run wiki-graphify and do NOT write anything under wiki/graph/. The backend triggers graph updates as separate invocations only after all ingest work and merge passes are complete.",
  ].join("\n");
}

function wrapWorkerPrompt(input: {
  basePrompt: string;
  kind: OrchestratedKind;
  worker: Worker;
  round: number;
  totalWorkers: number;
  entityRegistryRef?: string | null;
  sourcePageStatusRef?: string | null;
  codeWikiStatusRef?: string | null;
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
  if (input.sourcePageStatusRef) {
    lines.push(input.sourcePageStatusRef);
  }
  if (input.codeWikiStatusRef) {
    lines.push(input.codeWikiStatusRef);
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
  rawScope?: string | null;
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
  const codeWikiStatusRef =
    input.kind === "ingest" || input.kind === "ingest-loop"
      ? await buildCodeWikiStatusReference({ rawScope: input.rawScope })
      : null;
  const sourcePageStatusRef =
    input.kind === "ingest" || input.kind === "ingest-loop"
      ? await buildSourcePageStatusReference({ rawScope: input.rawScope })
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
        sourcePageStatusRef,
        codeWikiStatusRef,
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
    input.kind === "lint"
      ? "For /lint, use worker findings as inspection input, then perform exactly one manager write pass following wiki-lint, including report/log/index updates and --fix only if requested."
      : "For ingest operations, do not re-run ingest work in this manager pass. Review progress and worker outputs, and do not call the run complete when done leaves still lack source_pages_written coverage or detected code/mixed leaves still lack valid wiki/code file pages recorded in code_outputs.";

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

function ingestWorkComplete(snapshot: ProgressSnapshot): boolean {
  return (
    snapshot.leavesTotal > 0 &&
    snapshot.leavesDone === snapshot.leavesTotal &&
    snapshot.mergePendingParents === 0 &&
    snapshot.sourcePagesMissing === 0 &&
    snapshot.codeLeavesMissingOutputs === 0 &&
    snapshot.codeFilePagesMissing === 0 &&
    snapshot.codeDirectoryIndexesMissing === 0
  );
}

function rawScopeFromMessage(message?: string | null): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  const match = /^\/(?:ingest-loop|ingest)(?:\s+([\s\S]+?))?\s*$/.exec(trimmed);
  const target = match?.[1]?.trim();
  return normalizeRawScope(target);
}

async function runSingleRoundOperation(input: {
  cfg: Config;
  kind: OrchestratedKind;
  agent: CliName;
  sessionPath: string;
  prompt: string;
  message?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}): Promise<MultiAgentResult> {
  const orchestrationCli = input.cfg.agent.orchestration.cli ?? input.agent;
  const rawScope = rawScopeFromMessage(input.message);
  const workers = buildWorkers(input.cfg, orchestrationCli, {
    count: input.kind === "ingest" ? 1 : undefined,
  });
  const ingestBefore =
    input.kind === "ingest" ? await readProgressSnapshot({ rawScope }) : null;
  const runs = await runWorkerBatch({
    cfg: input.cfg,
    kind: input.kind,
    workers,
    basePrompt: input.prompt,
    round: 1,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    onChunk: input.onChunk,
    rawScope,
  });
  const workerDuration = runs.reduce(
    (sum, run) => sum + (run.result?.durationMs ?? 0),
    0,
  );
  if (signalAborted(input.signal)) {
    return cancellationResult({
      kind: input.kind,
      assistantAgent: input.cfg.agent.orchestration.managerName || "manager",
      durationMs: workerDuration,
      exitCode: runs.find((run) => run.result)?.result?.exitCode ?? -1,
    });
  }
  let progressNote: string | null = null;

  if (input.kind === "ingest" && ingestBefore) {
    const ingestAfter = await readProgressSnapshot({ rawScope });
    const progressAdvanced = ingestMadeProgress(
      ingestBefore,
      ingestAfter,
    );
    progressNote = `ingest progress advanced=${progressAdvanced}`;
    const bestExit = runs.some((run) => run.result?.exitCode === 0) ? 0 : 1;
    if (progressAdvanced && ingestWorkComplete(ingestAfter)) {
      const qmd = await maybeRefreshQmdIndex({
        cfg: input.cfg,
        signal: input.signal,
        onChunk: input.onChunk,
      });
      if (qmd.note) progressNote += `\n${qmd.note}`;
      const finalGraph = await maybeAutoRunGraphify({
        cfg: input.cfg,
        agent: orchestrationCli,
        sessionPath: input.sessionPath,
        signal: input.signal,
        lastExitCode: bestExit,
        before: ingestBefore,
        after: ingestAfter,
        mode: "final",
        onChunk: input.onChunk,
      });
      if (finalGraph.note) progressNote += `\n${finalGraph.note}`;
    } else if (progressAdvanced) {
      progressNote +=
        "\n[auto graph] multi-agent ingest still has pending work; " +
        "wiki-graphify update will run after all leaves and merge passes complete.";
    }
  }
  if (signalAborted(input.signal)) {
    return cancellationResult({
      kind: input.kind,
      assistantAgent: input.cfg.agent.orchestration.managerName || "manager",
      durationMs: workerDuration,
      exitCode: runs.find((run) => run.result)?.result?.exitCode ?? -1,
    });
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
  message?: string;
  progressRef?: string | null;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}): Promise<MultiAgentResult> {
  await clearStopFlag(input.sessionPath);
  const orchestrationCli = input.cfg.agent.orchestration.cli ?? input.agent;
  const rawScope = rawScopeFromMessage(input.message);
  const workers = buildWorkers(input.cfg, orchestrationCli);
  const maxRounds = input.cfg.cli.ingestLoop.maxIterations;
  const timeoutMs = input.cfg.cli.timeouts["ingest-loop"] ?? undefined;
  const loopBefore = await readProgressSnapshot({ rawScope });
  let prevSnap = loopBefore;
  let round = 0;
  let idleRounds = 0;
  let haltKind: "normal" | "error" | "stopped" | "capped" | "stalled" =
    "normal";
  let haltReason = "";
  let allRuns: WorkerRun[] = [];
  let totalDurationMs = 0;
  let lastExitCode = 0;
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
    if (
      signalAborted(input.signal) ||
      (await stopFlagExists(input.sessionPath))
    ) {
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
            sourcePageStatusRef: await buildSourcePageStatusReference({
              rawScope,
            }),
            codeWikiStatusRef: await buildCodeWikiStatusReference({ rawScope }),
            rawScope,
          });
    const runs = await runWorkerBatch({
      cfg: input.cfg,
      kind: "ingest-loop",
      workers,
      basePrompt,
      round,
      timeoutMs,
      signal: input.signal,
      onChunk: input.onChunk,
      rawScope,
    });
    allRuns = allRuns.concat(runs);
    totalDurationMs += runs.reduce(
      (sum, run) => sum + (run.result?.durationMs ?? 0),
      0,
    );
    lastExitCode = runs.some((run) => run.result?.exitCode === 0) ? 0 : 1;
    if (signalAborted(input.signal)) {
      haltKind = "stopped";
      haltReason = "사용자 Stop 요청";
      break;
    }

    const summary = await readIngestStateSummary({ rawScope });
    const snap = await readProgressSnapshot({ rawScope });
    idleRounds = ingestMadeProgress(prevSnap, snap) ? 0 : idleRounds + 1;
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
      sourcePagesMissing: snap.sourcePagesMissing,
      codeLeavesMissingOutputs: snap.codeLeavesMissingOutputs,
      codeFilePagesMissing: snap.codeFilePagesMissing,
      codeDirectoryIndexesMissing: snap.codeDirectoryIndexesMissing,
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

  const loopAfter = await readProgressSnapshot({ rawScope });
  if (
    !signalAborted(input.signal) &&
    haltKind !== "error" &&
    ingestWorkComplete(loopAfter)
  ) {
    const qmd = await maybeRefreshQmdIndex({
      cfg: input.cfg,
      signal: input.signal,
      onChunk: input.onChunk,
    });
    if (qmd.note) {
      allRuns.push({
        worker: {
          index: workers.length,
          name: "qmd",
          cli: orchestrationCli,
        },
        round,
        result: {
          stdout: qmd.note,
          stderr: "",
          exitCode: qmd.ok ? 0 : 1,
          durationMs: 0,
          stdoutTruncated: null,
          stderrTruncated: null,
        },
        error: null,
      });
    }
    const finalGraph = await maybeAutoRunGraphify({
      cfg: input.cfg,
      agent: orchestrationCli,
      sessionPath: input.sessionPath,
      signal: input.signal,
      lastExitCode,
      before: loopBefore,
      after: loopAfter,
      mode: "final",
      onChunk: input.onChunk,
    });
    if (finalGraph.note) {
      allRuns.push({
        worker: {
          index: workers.length,
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

  if (signalAborted(input.signal)) {
    await appendMessage(
      input.sessionPath,
      "system",
      `multi-agent /ingest-loop 중단: ${haltReason} (rounds=${round}).`,
    ).catch(() => undefined);
    return cancellationResult({
      kind: "ingest-loop",
      assistantAgent: input.cfg.agent.orchestration.managerName || "manager",
      durationMs: totalDurationMs,
      exitCode: lastExitCode,
    });
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
  message?: string;
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
