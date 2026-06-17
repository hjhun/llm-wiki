import "server-only";

import {
  cliSupportsResume,
  runCli,
  type CliName,
  type RunResult,
  type SessionOption,
} from "./cli";
import type { Config } from "./config";
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
  decideIngestLoopFinalize,
  ingestActivitySignature,
  ingestMadeProgress,
  ingestStateFileExists,
  maybeAutoRunGraphify,
  readActionableLeafPaths,
  readIngestStateSummary,
  readProgressSnapshot,
  stopFlagExists,
} from "./ingest-loop";

import type {
  AgentProgressEvent,
  MultiAgentResult,
  OrchestratedKind,
  Worker,
  WorkerRun,
} from "./multi-agent/types";
import { delay, retryDelayMs } from "./ingest/cli-retry";
import {
  finalMaintenanceSkippedNote,
  ingestFinalMaintenanceDecision,
} from "./ingest/graphify-decision";
import { bootstrapIngestProgress } from "./ingest/bootstrap";
import { runPostMergeMiniLint } from "./post-merge-lint";
import {
  clampAgentCount,
  displayManagerName,
  fitAsciiCell,
  buildWorkerDeltaPrompt,
  buildDeterministicIngestLoopReply,
  ingestWorkComplete,
  isOrchestratedKind,
  missionProfiles,
  operationPolicy,
  rawScopeFromMessage,
  seedOffset,
  shouldUseDeterministicIngestLoopReply,
  shouldResumeWorker,
  summarizeWorkerFailures,
} from "./multi-agent/util";
import {
  buildLeafScopeReference,
  partitionActionableLeaves,
  workerHasWorkThisRound,
} from "./multi-agent/partition";
import { tryDrainScopedMergeParent } from "./ingest/merge-drain";

// Re-export the public surface that moved into ./multi-agent/* so existing
// `@/lib/multi-agent` importers keep working unchanged.
export { isOrchestratedKind };
export type { OrchestratedKind, MultiAgentResult, AgentProgressEvent };

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

// CLIO's mascot is a set of slightly-open concentric rings (see
// `RingMascot` in components/agent-panel/AgentMascot.tsx). Each agent card
// renders that mascot in ASCII via `ringGlyph`: an outer and inner ring drawn
// around a per-persona core mark, with a deliberate gap in the top arc so the
// loop reads as a hand-drawn open ring rather than a closed circle. Personas
// only carry the single core character that distinguishes them.
const AGENT_PERSONAS = [
  { name: "Nikola Tesla", core: "o" },
  { name: "Isaac Newton", core: "-" },
  { name: "Albert Einstein", core: "@" },
  { name: "Ada Lovelace", core: "^" },
  { name: "Marie Curie", core: "*" },
  { name: "Alan Turing", core: "0" },
  { name: "Grace Hopper", core: "+" },
  { name: "Galileo Galilei", core: "=" },
  { name: "Katherine Johnson", core: "x" },
  { name: "Leonardo da Vinci", core: "v" },
  { name: "Rosalind Franklin", core: "u" },
  { name: "Niels Bohr", core: "n" },
  { name: "Richard Feynman", core: "f" },
  { name: "Hypatia", core: "h" },
  { name: "Srinivasa Ramanujan", core: "r" },
  { name: "Emmy Noether", core: "e" },
];

/**
 * Renders CLIO's ring mascot as a rounded Unicode box framing a bullseye
 * (`◎`, itself a pair of concentric circles, echoing the web UI mascot) and a
 * single per-persona `core` character. Drawn with box-drawing glyphs so it
 * stays crisp in the monospace `<pre>` agent card; the border widths are kept
 * in sync with the content row so the frame lines up.
 */
function ringGlyph(core: string): string[] {
  const c = (core || "o").slice(0, 1);
  return ["╭─────╮", `│ ◎ ${c} │`, "╰─────╯"];
}

const AGENT_ACCENTS = [
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef476f",
  "#6366f1",
  "#14b8a6",
  "#f97316",
  "#8b5cf6",
];

function buildAsciiBrief(worker: Worker): string {
  const name = fitAsciiCell(worker.name, 22);
  const role = fitAsciiCell(worker.role, 22);
  const task = fitAsciiCell(worker.asciiTask, 22);
  // Inner width is the 22-char cell plus the single padding space on each side.
  const border = "─".repeat(24);
  const handoff =
    worker.id === "manager" ? "   -> Close run" : "   -> Coordinator";
  return [
    `╭${border}╮`,
    `│ ${name} │`,
    `│ ${role} │`,
    `│ ${task} │`,
    `╰${border}╯`,
    ...worker.glyph,
    handoff,
  ].join("\n");
}

function buildWorkers(
  cfg: Config,
  managerCli: CliName,
  options: { count?: number; kind: OrchestratedKind },
): Worker[] {
  const cli = cfg.agent.orchestration.cli ?? managerCli;
  const count = options.count ?? clampAgentCount(cfg);
  const seed = cfg.agent.orchestration.namePrefix.trim() || "clio";
  const offset = seedOffset(`${seed}:${options.kind}`);
  const profiles = missionProfiles(options.kind);
  return Array.from({ length: count }, (_, index) => {
    const persona = AGENT_PERSONAS[(offset + index) % AGENT_PERSONAS.length];
    const profile = profiles[index % profiles.length];
    return {
      index,
      id: `worker-${index + 1}`,
      name: persona.name,
      glyph: ringGlyph(persona.core),
      cli,
      role: profile.role,
      detail: profile.detail,
      asciiTask: profile.asciiTask,
      accent: AGENT_ACCENTS[(offset + index) % AGENT_ACCENTS.length],
    };
  });
}

function emitAgentProgress(
  emit: ((event: AgentProgressEvent) => void) | undefined,
  worker: Worker,
  input: {
    status: AgentProgressEvent["status"];
    round: number;
    detail?: string;
    durationMs?: number;
  },
) {
  emit?.({
    type: "progress",
    phase: "agent",
    agentId: worker.id,
    name: worker.name,
    role: worker.role,
    detail: input.detail ?? worker.detail,
    ascii: buildAsciiBrief(worker),
    status: input.status,
    cli: worker.cli,
    round: input.round,
    durationMs: input.durationMs,
    accent: worker.accent,
  });
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
  leafScopeRef?: string | null;
}): string {
  const lines = [
    "You are operating as a named worker in an LLM Wiki multi-agent run.",
    `Worker persona: ${input.worker.name}`,
    `Worker CLI: ${input.worker.cli}`,
    `Worker slot: ${input.worker.index + 1}/${input.totalWorkers}`,
    `Mission focus: ${input.worker.role} — ${input.worker.detail}`,
    `Round: ${input.round}`,
    "A central Supervisor / Coordinator agent will receive worker handoffs, decide whether the operation is complete, close the run, and report to the user.",
    "The host webapp already created the active chat session. Do not create, rename, delete, or allocate any sessions/*.md file; use the Active session log supplied in the manager task.",
    operationPolicy(input.kind),
  ];
  // Inject on every round for fresh (non-resumed) workers. The loop's
  // continuation basePrompt no longer carries these refs (they were duplicated
  // there and dead weight for resumed workers), so wrapWorkerPrompt is now the
  // single source of the registry/status refs for the workers that need them.
  if (input.entityRegistryRef) {
    lines.push(input.entityRegistryRef);
  }
  if (input.sourcePageStatusRef) {
    lines.push(input.sourcePageStatusRef);
  }
  if (input.codeWikiStatusRef) {
    lines.push(input.codeWikiStatusRef);
  }
  if (input.leafScopeRef) {
    lines.push(input.leafScopeRef);
  }
  lines.push("", "===== COORDINATOR-PROVIDED TASK =====", input.basePrompt);
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
  onAgentProgress?: (event: AgentProgressEvent) => void;
  rawScope?: string | null;
  /**
   * Per-worker resumed CLI session ids, keyed by worker id, persisted across
   * rounds by the loop driver. Present only when session resume is enabled;
   * absent for single-round operations. Mutated in place as runs report ids.
   */
  sessions?: Map<string, string | null>;
}): Promise<WorkerRun[]> {
  const isIngest = input.kind === "ingest" || input.kind === "ingest-loop";
  if (isIngest) {
    await bootstrapIngestProgress({
      cfg: input.cfg,
      rawScope: input.rawScope,
    });
  }
  const actionableLeaves = isIngest
    ? await readActionableLeafPaths(input.rawScope ?? null)
    : null;
  const partition = isIngest
    ? partitionActionableLeaves(input.workers.length, actionableLeaves)
    : null;
  // Distinct from `partition.hasState` (does an actionable-leaf list exist):
  // this tells the bootstrap worker whether a `.state.json` is already on disk,
  // so its prompt never falsely claims the file is missing.
  const stateFileExists = isIngest ? await ingestStateFileExists() : false;
  // Per-round dynamic worker count. A worker whose partition bucket is an empty
  // array has no leaves to process this round (more workers than actionable
  // leaves, or the bootstrap round where only the enumerator runs); skip it
  // instead of spawning a CLI that would immediately no-op exit. A null bucket
  // (unrestricted / bootstrap enumerator) still runs, and worker 0 is never
  // empty, so the active set is never empty. Non-ingest kinds have no partition
  // and never skip.
  const assignmentFor = (worker: Worker): string[] | null =>
    partition
      ? worker.index in partition.assignments
        ? partition.assignments[worker.index]
        : []
      : null;
  // Whether this worker will resume its own CLI conversation (compact delta
  // prompt) rather than receive the full wrapped prompt this round.
  const resumingFor = (worker: Worker): boolean =>
    shouldResumeWorker({
      hasSessionTracking: input.sessions != null,
      cliSupportsResume: cliSupportsResume(worker.cli),
      round: input.round,
      priorSessionId: input.sessions?.get(worker.id) ?? null,
    });
  const activeWorkers: Worker[] = [];
  for (const worker of input.workers) {
    if (!workerHasWorkThisRound(assignmentFor(worker))) {
      emitAgentProgress(input.onAgentProgress, worker, {
        status: "done",
        round: input.round,
        detail:
          "이번 라운드에 배정된 leaf가 없어 idle 처리했습니다 (CLI 미실행).",
        durationMs: 0,
      });
      continue;
    }
    emitAgentProgress(input.onAgentProgress, worker, {
      status: "assigned",
      round: input.round,
    });
    activeWorkers.push(worker);
  }
  // Only fresh (non-resumed) workers consume the registry/status refs via
  // wrapWorkerPrompt; resumed workers get a compact delta prompt that omits
  // them. When every active worker resumes (the steady state of a healthy
  // loop), skip building these refs entirely — they would just be discarded.
  const needRefs = isIngest && activeWorkers.some((w) => !resumingFor(w));
  const entityRegistryRef = needRefs ? await buildEntityRegistryReference() : null;
  const codeWikiStatusRef = needRefs
    ? await buildCodeWikiStatusReference({ rawScope: input.rawScope })
    : null;
  const sourcePageStatusRef = needRefs
    ? await buildSourcePageStatusReference({ rawScope: input.rawScope })
    : null;
  return Promise.all(
    activeWorkers.map(async (worker): Promise<WorkerRun> => {
      const leafScopeRef = partition
        ? buildLeafScopeReference(
            assignmentFor(worker),
            partition.hasState,
            stateFileExists,
          )
        : null;
      // Resume this worker's own CLI conversation when the loop tracks
      // sessions, the CLI supports resume-by-id, and a prior id exists. The
      // first round (or a failed earlier capture) starts/assigns a session and
      // uses the full prompt; later rounds resume with a compact delta.
      const canResume =
        input.sessions != null && cliSupportsResume(worker.cli);
      const priorId = input.sessions?.get(worker.id) ?? null;
      const resuming = shouldResumeWorker({
        hasSessionTracking: input.sessions != null,
        cliSupportsResume: cliSupportsResume(worker.cli),
        round: input.round,
        priorSessionId: priorId,
      });
      const prompt = resuming
        ? buildWorkerDeltaPrompt({
            workerName: worker.name,
            round: input.round,
            leafScopeRef,
          })
        : wrapWorkerPrompt({
            basePrompt: input.basePrompt,
            kind: input.kind,
            worker,
            round: input.round,
            totalWorkers: input.workers.length,
            entityRegistryRef,
            sourcePageStatusRef,
            codeWikiStatusRef,
            leafScopeRef,
          });
      const session: SessionOption | undefined = canResume
        ? resuming
          ? { id: priorId as string, resume: true }
          : {}
        : undefined;
      const started = Date.now();
      emitAgentProgress(input.onAgentProgress, worker, {
        status: "running",
        round: input.round,
      });
      try {
        const result = await runCli(worker.cli, prompt, {
          safeMode: input.cfg.agent.safeMode,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          killOnAbort: input.signal ? true : input.timeoutMs != null,
          session,
        });
        // Thread the resolved id forward. Keep the prior id if this run
        // reported none (e.g. codex capture failed) so a later round can retry.
        if (canResume) {
          input.sessions?.set(worker.id, result.sessionId ?? priorId);
        }
        emitAgentProgress(input.onAgentProgress, worker, {
          status: result.exitCode === 0 ? "done" : "error",
          round: input.round,
          detail:
            result.exitCode === 0
              ? `${worker.role} mission complete. Handoff queued for Coordinator review.`
              : `${worker.role} 임무가 exitCode=${result.exitCode}로 종료되었습니다.`,
          durationMs: result.durationMs,
        });
        return { worker, round: input.round, result, error: null };
      } catch (err) {
        const message = errorMessage(err);
        emitAgentProgress(input.onAgentProgress, worker, {
          status: "error",
          round: input.round,
          detail: message,
          durationMs: Date.now() - started,
        });
        return { worker, round: input.round, result: null, error: message };
      }
    }),
  );
}

/**
 * Run one loop round's worker batch with whole-batch retries. A round is
 * considered failed only when **every** active worker exits non-zero (the same
 * `lastExitCode` rule the loop already used); a partial success advances the
 * loop and lets the next round repartition the failed leaves. On total failure
 * the batch is re-run after a backoff, up to `maxAttempts`, so a transient
 * outage (rate limit, brief OOM) no longer kills the whole `/ingest-loop` the
 * way it did before — matching the resilience the single-agent `runIngestLoop`
 * already had via `runCliWithIngestLoopRetries`. Stop requests and aborts cut
 * the retries short. Only the final attempt's runs are returned so the manager
 * summary is not polluted with discarded failed attempts.
 */
async function runWorkerBatchWithRetries(
  batchInput: Parameters<typeof runWorkerBatch>[0],
  retry: {
    maxAttempts: number;
    backoffs: number[];
    sessionPath: string;
    signal?: AbortSignal;
    onChunk?: (text: string) => void;
  },
): Promise<{ runs: WorkerRun[]; durationMs: number; exitCode: number }> {
  const maxAttempts = Math.max(1, retry.maxAttempts);
  let runs: WorkerRun[] = [];
  let durationMs = 0;
  let attempt = 0;
  while (true) {
    attempt += 1;
    runs = await runWorkerBatch(batchInput);
    durationMs += runs.reduce((sum, run) => sum + (run.result?.durationMs ?? 0), 0);
    const exitCode = runs.some((run) => run.result?.exitCode === 0) ? 0 : 1;
    if (exitCode === 0 || attempt >= maxAttempts) {
      return { runs, durationMs, exitCode };
    }
    if (
      signalAborted(retry.signal) ||
      (await stopFlagExists(retry.sessionPath))
    ) {
      return { runs, durationMs, exitCode };
    }
    const waitMs = retryDelayMs(retry.backoffs, attempt);
    const note =
      `\n\n---\n[ingest-loop] round ${batchInput.round} worker batch 전원 실패 ` +
      `(시도 ${attempt}/${maxAttempts}). ${Math.round(waitMs / 1000)}초 후 같은 라운드를 재시도합니다.\n`;
    retry.onChunk?.(note);
    await appendMessage(retry.sessionPath, "system", note.trim()).catch(
      () => undefined,
    );
    try {
      await delay(waitMs, retry.signal);
    } catch {
      // Aborted while waiting — surface the failed exit and let the caller halt.
      return { runs, durationMs, exitCode };
    }
  }
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
      ? "For /lint, use worker findings as inspection input, then perform exactly one Coordinator write pass following wiki-lint, including report/log/index updates and --fix only if requested."
      : "For ingest operations, do not re-run ingest work in this Coordinator pass. Review progress and worker outputs, and do not call the run complete when done leaves still lack source_pages_written coverage or code-looking raw files are still missing from ingest state. Do not require wiki/code file pages for completion; graphify runs after ingest.";

  return [
    "You are the central Supervisor / Coordinator agent for an LLM Wiki multi-agent run.",
    `Coordinator name: ${input.managerName}`,
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
    "Respond now as the Coordinator. Summarize what each named worker handed off, whether the operation is complete or needs another run, and the final user-facing result.",
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
  onAgentProgress?: (event: AgentProgressEvent) => void;
}): Promise<RunResult> {
  const managerName = displayManagerName(
    input.cfg.agent.orchestration.managerName,
  );
  const managerWorker: Worker = {
    index: input.runs.length,
    id: "manager",
    name: managerName,
    glyph: ringGlyph("c"),
    cli: input.agent,
    role: "Supervisor / Coordinator",
    detail: "Worker handoffs를 받아 최종 판단을 내리고 실행을 종료합니다.",
    asciiTask: "receive & close",
    accent: "#64748b",
  };
  input.onAgentProgress?.({
    type: "progress",
    phase: "agent",
    agentId: "manager",
    name: managerName,
    role: managerWorker.role,
    detail: managerWorker.detail,
    ascii: buildAsciiBrief(managerWorker),
    status: "consolidating",
    cli: input.agent,
    round: Math.max(...input.runs.map((run) => run.round), 1),
    accent: "#64748b",
  });
  const started = Date.now();
  const result = await runCli(
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
  input.onAgentProgress?.({
    type: "progress",
    phase: "agent",
    agentId: "manager",
    name: managerName,
    role: managerWorker.role,
    detail:
      result.exitCode === 0
        ? "Coordinator received every handoff, delivered the final response, and closed the run."
        : `Coordinator pass가 exitCode=${result.exitCode}로 종료되었습니다.`,
    ascii: buildAsciiBrief(managerWorker),
    status: result.exitCode === 0 ? "done" : "error",
    cli: input.agent,
    round: Math.max(...input.runs.map((run) => run.round), 1),
    durationMs: Date.now() - started,
    accent: "#64748b",
  });
  return result;
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
  onAgentProgress?: (event: AgentProgressEvent) => void;
}): Promise<MultiAgentResult> {
  const orchestrationCli = input.cfg.agent.orchestration.cli ?? input.agent;
  const rawScope = rawScopeFromMessage(input.message);
  const workers = buildWorkers(input.cfg, orchestrationCli, {
    kind: input.kind,
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
    onAgentProgress: input.onAgentProgress,
    rawScope,
  });
  const workerDuration = runs.reduce(
    (sum, run) => sum + (run.result?.durationMs ?? 0),
    0,
  );
  if (signalAborted(input.signal)) {
    return cancellationResult({
      kind: input.kind,
      assistantAgent: displayManagerName(input.cfg.agent.orchestration.managerName),
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
      const finalMaintenance = ingestFinalMaintenanceDecision(
        input.cfg,
        ingestAfter,
      );
      if (finalMaintenance.enabled) {
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
      } else {
        const note = finalMaintenanceSkippedNote(finalMaintenance.reason);
        input.onChunk?.(note);
        progressNote += `\n${note}`;
      }
    } else if (progressAdvanced) {
      progressNote +=
        "\n[auto graph] multi-agent ingest still has pending work; " +
        "wiki-graphify update will run after all leaves and merge passes complete.";
    }
  }
  if (signalAborted(input.signal)) {
    return cancellationResult({
      kind: input.kind,
      assistantAgent: displayManagerName(input.cfg.agent.orchestration.managerName),
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
    onAgentProgress: input.onAgentProgress,
  });
  const finalReply =
    manager.stdout.trim() ||
    manager.stderr.trim() ||
    `(manager returned empty output. exitCode=${manager.exitCode})`;
  return {
    finalReply,
    lastExitCode: manager.exitCode,
    totalDurationMs: workerDuration + manager.durationMs,
    assistantAgent: displayManagerName(input.cfg.agent.orchestration.managerName),
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
  onAgentProgress?: (event: AgentProgressEvent) => void;
}): Promise<MultiAgentResult> {
  await clearStopFlag(input.sessionPath);
  const orchestrationCli = input.cfg.agent.orchestration.cli ?? input.agent;
  const rawScope = rawScopeFromMessage(input.message);
  const workers = buildWorkers(input.cfg, orchestrationCli, {
    kind: "ingest-loop",
  });
  // Per-worker resumed CLI session ids, persisted across loop rounds. Undefined
  // disables resume entirely (config off) so every worker uses the legacy
  // fresh-process + full-prompt path.
  const sessions = input.cfg.cli.ingestLoop.resumeSessions
    ? new Map<string, string | null>()
    : undefined;
  const maxRounds = input.cfg.cli.ingestLoop.maxIterations;
  const stagnationLimit = input.cfg.cli.ingestLoop.maxStagnantRounds;
  const timeoutMs = input.cfg.cli.timeouts["ingest-loop"] ?? undefined;
  const loopBefore = await readProgressSnapshot({ rawScope });
  let round = 0;
  let idleRounds = 0;
  // Cumulative count of worker-rounds that failed while the loop continued
  // (one worker succeeding keeps the round alive). Surfaced to the manager so a
  // crashed worker is never silently masked by a sibling's success.
  let failedWorkerRounds = 0;
  let haltKind:
    | "normal"
    | "error"
    | "stopped"
    | "capped"
    | "stalled"
    | "empty" = "normal";
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
    `multi-agent /ingest-loop 시작 (workers=${workers.length}, Ralph 루프 · 연속 무진행 ${stagnationLimit}회 시 중단, 안전 상한 ${maxRounds}).`,
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
            // Entity/source/code refs are injected per worker by
            // wrapWorkerPrompt (fresh workers) or deliberately omitted (resumed
            // workers' delta prompt). Embedding them in the shared continuation
            // basePrompt duplicated them in fresh round>1 prompts and was dead
            // weight for resumed workers, who ignore basePrompt entirely.
            entityRegistryRef: null,
            sourcePageStatusRef: null,
            codeWikiStatusRef: null,
            rawScope,
          });
    const activityBefore = await ingestActivitySignature();
    const batch = await runWorkerBatchWithRetries(
      {
        cfg: input.cfg,
        kind: "ingest-loop",
        workers,
        basePrompt,
        round,
        timeoutMs,
        signal: input.signal,
        onChunk: input.onChunk,
        onAgentProgress: input.onAgentProgress,
        rawScope,
        sessions,
      },
      {
        maxAttempts: input.cfg.cli.ingestLoop.maxRetryAttempts,
        backoffs: input.cfg.cli.ingestLoop.retryBackoffMs,
        sessionPath: input.sessionPath,
        signal: input.signal,
        onChunk: input.onChunk,
      },
    );
    const runs = batch.runs;
    allRuns = allRuns.concat(runs);
    totalDurationMs += batch.durationMs;
    lastExitCode = batch.exitCode;
    // Surface partial failures: when some workers failed but at least one
    // succeeded, the loop continues (failed leaves are repartitioned next
    // round), so without this the dead workers are invisible to the user.
    const failures = summarizeWorkerFailures(runs);
    if (failures.failed > 0 && failures.failed < failures.total) {
      failedWorkerRounds += failures.failed;
      await appendMessage(
        input.sessionPath,
        "system",
        `⚠️ round ${round}: 워커 ${failures.failed}/${failures.total}명 실패 ` +
          `(${failures.failedNames.join(", ")}). 다른 워커가 성공하여 루프는 계속됩니다.`,
      ).catch(() => undefined);
    }
    if (signalAborted(input.signal)) {
      haltKind = "stopped";
      haltReason = "사용자 Stop 요청";
      break;
    }

    const summary = await readIngestStateSummary({ rawScope });
    const activityAfter = await ingestActivitySignature();
    idleRounds = activityBefore !== activityAfter ? 0 : idleRounds + 1;

    if (lastExitCode !== 0) {
      haltKind = "error";
      haltReason = `CLI exitCode=${lastExitCode}`;
      break;
    }
    if (summary && summary.error > 0) {
      haltKind = "error";
      haltReason = `sub-chunk ${summary.error}건이 error 상태로 종료`;
      break;
    }
    if (summary && summary.total === 0) {
      haltKind = "empty";
      haltReason = rawScope
        ? `지정한 스코프 ${rawScope}에 ingest할 파일이 없습니다. raw/ 아래에 해당 경로(또는 raw/ 하위의 승인된 심볼릭 링크)가 존재하는지 확인하세요.`
        : "raw/ 아래에 ingest할 파일이 없습니다.";
      break;
    }
    if (
      summary &&
      summary.pending === 0 &&
      summary.in_progress === 0 &&
      summary.partial === 0
    ) {
      haltKind = "normal";
      haltReason =
        `source generation complete (${summary.done}/${summary.total}); ` +
        "running final validation";
      break;
    }
    if (idleRounds >= stagnationLimit) {
      haltKind = "stalled";
      haltReason = `연속 ${idleRounds}개 라운드에서 진행이 없어 중단`;
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

  let loopAfter = await readProgressSnapshot({ rawScope });
  for (let i = 0; i < maxRounds && loopAfter.mergePendingParents > 0; i += 1) {
    const drain = await tryDrainScopedMergeParent({
      rawScope,
      signal: input.signal,
    });
    if (drain.note) input.onChunk?.(`\n\n---\n\n${drain.note}`);
    if (!drain.drained) break;
    totalDurationMs += drain.durationMs;
    allRuns.push({
      worker: {
        index: workers.length,
        id: "backend-merge",
        name: "backend-merge",
        glyph: ringGlyph("m"),
        cli: orchestrationCli,
        role: "Scoped Merge Drain",
        detail: "완료된 scoped merge parent를 deterministic backend 처리로 정리합니다.",
        asciiTask: "drain merge",
        accent: "#2563eb",
      },
      round,
      result: {
        stdout: drain.note ?? "",
        stderr: "",
        exitCode: 0,
        durationMs: drain.durationMs,
        stdoutTruncated: null,
        stderrTruncated: null,
        sessionId: null,
      },
      error: null,
    });
    loopAfter = await readProgressSnapshot({ rawScope });
  }
  if (haltKind === "normal" && ingestWorkComplete(loopAfter)) {
    const summary = await readIngestStateSummary({ rawScope });
    haltReason = loopAfter.mergeDone
      ? `모든 leaf 완료 + merge pass done (${summary?.done ?? loopAfter.leavesDone}/${summary?.total ?? loopAfter.leavesTotal})`
      : `모든 leaf 완료 · 남은 merge 작업 없음 (${summary?.done ?? loopAfter.leavesDone}/${summary?.total ?? loopAfter.leavesTotal})`;
  }
  for (
    let attempt = 0;
    haltKind === "normal" &&
    !ingestWorkComplete(loopAfter) &&
    attempt < input.cfg.cli.ingestLoop.maxRetryAttempts;
    attempt += 1
  ) {
    round += 1;
    const repairPrompt = buildLoopContinuationPrompt({
      sessionPath: input.sessionPath,
      iteration: round,
      progressRef: await buildProgressReference(),
      entityRegistryRef: null,
      sourcePageStatusRef: null,
      codeWikiStatusRef: null,
      rawScope,
    });
    input.onChunk?.(
      `\n\n---\n\n[final validation] remaining ingest issues detected; running repair round ${attempt + 1}/${input.cfg.cli.ingestLoop.maxRetryAttempts}.\n`,
    );
    const repairBatch = await runWorkerBatchWithRetries(
      {
        cfg: input.cfg,
        kind: "ingest-loop",
        workers,
        basePrompt: repairPrompt,
        round,
        timeoutMs,
        signal: input.signal,
        onChunk: input.onChunk,
        onAgentProgress: input.onAgentProgress,
        rawScope,
        sessions,
      },
      {
        maxAttempts: input.cfg.cli.ingestLoop.maxRetryAttempts,
        backoffs: input.cfg.cli.ingestLoop.retryBackoffMs,
        sessionPath: input.sessionPath,
        signal: input.signal,
        onChunk: input.onChunk,
      },
    );
    allRuns = allRuns.concat(repairBatch.runs);
    totalDurationMs += repairBatch.durationMs;
    lastExitCode = repairBatch.exitCode;
    const failures = summarizeWorkerFailures(repairBatch.runs);
    if (failures.failed > 0 && failures.failed < failures.total) {
      failedWorkerRounds += failures.failed;
      await appendMessage(
        input.sessionPath,
        "system",
        `⚠️ final validation repair round ${attempt + 1}: 워커 ` +
          `${failures.failed}/${failures.total}명 실패 ` +
          `(${failures.failedNames.join(", ")}).`,
      ).catch(() => undefined);
    }
    if (lastExitCode !== 0) {
      haltKind = "error";
      haltReason = `final validation repair CLI exitCode=${lastExitCode}`;
      break;
    }
    loopAfter = await readProgressSnapshot({ rawScope });
    for (
      let i = 0;
      i < maxRounds && loopAfter.mergePendingParents > 0;
      i += 1
    ) {
      const drain = await tryDrainScopedMergeParent({
        rawScope,
        signal: input.signal,
      });
      if (drain.note) input.onChunk?.(`\n\n---\n\n${drain.note}`);
      if (!drain.drained) break;
      totalDurationMs += drain.durationMs;
      allRuns.push({
        worker: {
          index: workers.length,
          id: "backend-merge",
          name: "backend-merge",
          glyph: ringGlyph("m"),
          cli: orchestrationCli,
          role: "Scoped Merge Drain",
          detail: "완료된 scoped merge parent를 deterministic backend 처리로 정리합니다.",
          asciiTask: "drain merge",
          accent: "#2563eb",
        },
        round,
        result: {
          stdout: drain.note ?? "",
          stderr: "",
          exitCode: 0,
          durationMs: drain.durationMs,
          stdoutTruncated: null,
          stderrTruncated: null,
          sessionId: null,
        },
        error: null,
      });
      loopAfter = await readProgressSnapshot({ rawScope });
    }
  }
  if (haltKind === "normal" && !ingestWorkComplete(loopAfter)) {
    haltKind = "stalled";
    haltReason =
      "final validation found remaining ingest issues after repair attempts " +
      `(source leaves=${loopAfter.sourcePagesMissing}, ` +
      `code leaf progress=${loopAfter.codeLeavesMissingOutputs}, ` +
      `untracked code files=${loopAfter.codeFilePagesMissing}, ` +
      `legacy code directories=${loopAfter.codeDirectoryIndexesMissing}, ` +
      `merge parents=${loopAfter.mergePendingParents})`;
  } else if (haltKind === "normal" && ingestWorkComplete(loopAfter)) {
    const summary = await readIngestStateSummary({ rawScope });
    haltReason = loopAfter.mergeDone
      ? `모든 leaf 완료 + merge pass done (${summary?.done ?? loopAfter.leavesDone}/${summary?.total ?? loopAfter.leavesTotal})`
      : `모든 leaf 완료 · 남은 merge 작업 없음 (${summary?.done ?? loopAfter.leavesDone}/${summary?.total ?? loopAfter.leavesTotal})`;
  }
  const finalMaintenance = ingestFinalMaintenanceDecision(input.cfg, loopAfter);
  // Shared loop-exit finalization gating (see decideIngestLoopFinalize). The
  // multi-agent driver never runs graphify incrementally, so the whole block
  // is gated on full completion; the single-agent driver uses the same helper
  // with driver:"single".
  const finalize = decideIngestLoopFinalize({
    driver: "multi",
    haltKind,
    aborted: signalAborted(input.signal),
    progressed: ingestMadeProgress(loopBefore, loopAfter),
    workComplete: ingestWorkComplete(loopAfter),
    graphAlreadyCoversLatest: false,
    finalMaintenanceEnabled: finalMaintenance.enabled,
  });
  if (
    !finalMaintenance.enabled &&
    haltKind !== "error" &&
    ingestWorkComplete(loopAfter) &&
    ingestMadeProgress(loopBefore, loopAfter)
  ) {
    input.onChunk?.(finalMaintenanceSkippedNote(finalMaintenance.reason));
  }
  if (finalize.runQmd) {
    const qmd = await maybeRefreshQmdIndex({
      cfg: input.cfg,
      signal: input.signal,
      onChunk: input.onChunk,
    });
    if (qmd.note) {
      allRuns.push({
        worker: {
          index: workers.length,
          id: "qmd",
          name: "qmd",
          glyph: ringGlyph("q"),
          cli: orchestrationCli,
          role: "Search Index Refresh",
          detail: "qmd 검색 인덱스를 최신 wiki 상태로 갱신합니다.",
          asciiTask: "refresh search",
          accent: "#0f766e",
        },
        round,
        result: {
          stdout: qmd.note,
          stderr: "",
          exitCode: qmd.ok ? 0 : 1,
          durationMs: 0,
          stdoutTruncated: null,
          stderrTruncated: null,
          sessionId: null,
        },
        error: null,
      });
    }
  }
  if (finalize.runGraph) {
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
          id: "auto-graph-final",
          name: "auto-graph-final",
          glyph: ringGlyph("g"),
          cli: orchestrationCli,
          role: "Graph Sync",
          detail: "최종 ingest 결과를 knowledge graph에 반영합니다.",
          asciiTask: "sync graph",
          accent: "#7c3aed",
        },
        round,
        result: {
          stdout: finalGraph.note,
          stderr: "",
          exitCode: finalGraph.succeeded ? 0 : 1,
          durationMs: 0,
          stdoutTruncated: null,
          stderrTruncated: null,
          sessionId: null,
        },
        error: null,
      });
    }
  }
  // Closing mini-lint for runs that completed without ever flipping mergeDone
  // (single-leaf scopes, already-merged state), which the per-round transition
  // check above never fires for.
  if (finalize.runLint) {
    const lint = await runPostMergeMiniLint({ signal: input.signal });
    if (lint.note) input.onChunk?.(lint.note);
  }

  if (signalAborted(input.signal)) {
    await appendMessage(
      input.sessionPath,
      "system",
      `multi-agent /ingest-loop 중단: ${haltReason} (rounds=${round}).`,
    ).catch(() => undefined);
    return cancellationResult({
      kind: "ingest-loop",
      assistantAgent: displayManagerName(input.cfg.agent.orchestration.managerName),
      durationMs: totalDurationMs,
      exitCode: lastExitCode,
    });
  }

  const completedWithoutManager = shouldUseDeterministicIngestLoopReply({
    haltKind,
    workComplete: ingestWorkComplete(loopAfter),
    failedWorkerRounds,
    lastExitCode,
  });
  if (completedWithoutManager) {
    await appendMessage(
      input.sessionPath,
      "system",
      `multi-agent /ingest-loop 종료: ${haltReason} (rounds=${round}, manager=skipped).`,
    ).catch(() => undefined);
    return {
      finalReply: buildDeterministicIngestLoopReply({
        haltKind,
        haltReason,
        rounds: round,
        rawScope,
        snapshot: loopAfter,
        runs: allRuns.slice(-Math.max(workers.length * 3, 12)),
        totalDurationMs,
      }),
      lastExitCode,
      totalDurationMs,
      assistantAgent: displayManagerName(input.cfg.agent.orchestration.managerName),
    };
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
    )}${failedWorkerRounds > 0 ? ` · failedWorkerRounds=${failedWorkerRounds}` : ""}`,
    timeoutMs: input.cfg.cli.timeouts.chat ?? undefined,
    onChunk: input.onChunk,
    onAgentProgress: input.onAgentProgress,
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
    assistantAgent: displayManagerName(input.cfg.agent.orchestration.managerName),
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
  onAgentProgress?: (event: AgentProgressEvent) => void;
}): Promise<MultiAgentResult> {
  if (input.kind === "ingest-loop") {
    return runLoopOperation(input);
  }
  return runSingleRoundOperation({
    ...input,
    timeoutMs: input.cfg.cli.timeouts[input.kind] ?? undefined,
  });
}
