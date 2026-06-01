import "server-only";

import { runCli, type CliName, type RunResult } from "./cli";
import type { Config } from "./config";
import type { ChatKind, ChatSendEvent } from "./chat-events";
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
  readActionableLeafPaths,
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
  id: string;
  name: string;
  glyph: string[];
  cli: CliName;
  role: string;
  detail: string;
  asciiTask: string;
  accent: string;
};

export type AgentProgressEvent = Extract<
  ChatSendEvent,
  { type: "progress"; phase: "agent" }
>;

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

const AGENT_PERSONAS = [
  { name: "Nikola Tesla", glyph: [" /\\_/\\\\", "( o.o )", " > ^ <", " /___\\~"] },
  { name: "Isaac Newton", glyph: [" /\\_/\\\\", "( -.- )", " > ^ <", " /___\\~"] },
  { name: "Albert Einstein", glyph: [" /\\_/\\\\", "( @.@ )", " > ^ <", " /___\\~"] },
  { name: "Ada Lovelace", glyph: [" /\\_/\\\\", "( ^.^ )", " > ^ <", " /___\\~"] },
  { name: "Marie Curie", glyph: [" /\\_/\\\\", "( *.* )", " > ^ <", " /___\\~"] },
  { name: "Alan Turing", glyph: [" /\\_/\\\\", "( 0.0 )", " > ^ <", " /___\\~"] },
  { name: "Grace Hopper", glyph: [" /\\_/\\\\", "( +.+ )", " > ^ <", " /___\\~"] },
  { name: "Galileo Galilei", glyph: [" /\\_/\\\\", "( =.= )", " > ^ <", " /___\\~"] },
  { name: "Katherine Johnson", glyph: [" /\\_/\\\\", "( x.x )", " > ^ <", " /___\\~"] },
  { name: "Leonardo da Vinci", glyph: [" /\\_/\\\\", "( v.v )", " > ^ <", " /___\\~"] },
  { name: "Rosalind Franklin", glyph: [" /\\_/\\\\", "( u.u )", " > ^ <", " /___\\~"] },
  { name: "Niels Bohr", glyph: [" /\\_/\\\\", "( n.n )", " > ^ <", " /___\\~"] },
  { name: "Richard Feynman", glyph: [" /\\_/\\\\", "( f.f )", " > ^ <", " /___\\~"] },
  { name: "Hypatia", glyph: [" /\\_/\\\\", "( h.h )", " > ^ <", " /___\\~"] },
  { name: "Srinivasa Ramanujan", glyph: [" /\\_/\\\\", "( r.r )", " > ^ <", " /___\\~"] },
  { name: "Emmy Noether", glyph: [" /\\_/\\\\", "( e.e )", " > ^ <", " /___\\~"] },
];

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

type MissionProfile = {
  role: string;
  detail: string;
  asciiTask: string;
};

function missionProfiles(kind: OrchestratedKind): MissionProfile[] {
  if (kind === "lint") {
    return [
      {
        role: "Evidence Scout",
        detail: "wiki pages에서 모순, 깨진 링크, stale claim 증거를 수집합니다.",
        asciiTask: "scan evidence",
      },
      {
        role: "Structure Auditor",
        detail: "frontmatter, index, orphan page, source 연결 상태를 점검합니다.",
        asciiTask: "audit structure",
      },
      {
        role: "Risk Reviewer",
        detail: "수동 검토가 필요한 개인정보, 불확실한 출처, 수정 위험을 분류합니다.",
        asciiTask: "rank risks",
      },
      {
        role: "Repair Planner",
        detail: "Coordinator가 한 번에 고칠 수 있는 항목과 보류 항목을 나눕니다.",
        asciiTask: "plan repairs",
      },
    ];
  }
  return [
    {
      role: "Source Scout",
      detail: "raw leaf와 sub-chunk를 읽고 source page coverage를 확보합니다.",
      asciiTask: "raw -> sources",
    },
    {
      role: "Code Cartographer",
      detail: "코드 leaf 상태와 graphify 후속 그래프 산출물 누락을 점검합니다.",
      asciiTask: "map code wiki",
    },
    {
      role: "Link Steward",
      detail: "entity, concept, index, log 연결이 merge pass에 맞는지 확인합니다.",
      asciiTask: "link wiki pages",
    },
    {
      role: "Merge Sentinel",
      detail: "진행 state와 누락 지표를 보고 다음 round 또는 완료 조건을 판정합니다.",
      asciiTask: "guard merge",
    },
  ];
}

function seedOffset(seed: string): number {
  let value = 0;
  for (const char of seed) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

function displayManagerName(name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.toLowerCase() === "manager") return "Coordinator";
  return trimmed;
}

function fitAsciiCell(value: string, width: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const text =
    trimmed.length > width
      ? `${trimmed.slice(0, Math.max(0, width - 1))}>`
      : trimmed;
  return text.padEnd(width, " ");
}

function buildAsciiBrief(worker: Worker): string {
  const name = fitAsciiCell(worker.name, 22);
  const role = fitAsciiCell(worker.role, 22);
  const task = fitAsciiCell(worker.asciiTask, 22);
  const handoff =
    worker.id === "manager" ? "   -> Close run" : "   -> Coordinator";
  return [
    "+------------------------+",
    `| ${name} |`,
    `| ${role} |`,
    `| ${task} |`,
    "+------------------------+",
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
      glyph: persona.glyph,
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

/**
 * Partition actionable (pending/partial/in_progress) leaves across workers as
 * disjoint round-robin buckets. A `null` actionableLeaves input (no `.state.json`
 * yet) is the bootstrap case: only worker 0 gets unrestricted scope so it can
 * enumerate; the rest receive empty assignments and will no-op exit.
 */
function partitionActionableLeaves(
  workerCount: number,
  actionableLeaves: string[] | null,
): { assignments: (string[] | null)[]; hasState: boolean } {
  if (workerCount <= 0) return { assignments: [], hasState: actionableLeaves != null };
  if (actionableLeaves == null) {
    const assignments: (string[] | null)[] = new Array(workerCount).fill([]);
    assignments[0] = null;
    return { assignments, hasState: false };
  }
  const assignments: string[][] = Array.from({ length: workerCount }, () => []);
  for (let i = 0; i < actionableLeaves.length; i += 1) {
    assignments[i % workerCount].push(actionableLeaves[i]);
  }
  return { assignments, hasState: true };
}

function buildLeafScopeReference(
  assignedLeaves: string[] | null,
  hasState: boolean,
): string {
  if (assignedLeaves === null) {
    if (!hasState) {
      return [
        "===== ASSIGNED LEAF SCOPE =====",
        "No prior wiki/.progress/ingest/.state.json exists. You are the bootstrap worker for this round:",
        "perform leaf enumeration and initial sub-chunk planning per wiki-ingest Step 1, then process at most one sub-chunk.",
        "Hold the global wiki/.progress/ingest/.lock only for the short enumeration/state-write critical section.",
      ].join("\n");
    }
    return [
      "===== ASSIGNED LEAF SCOPE =====",
      "Unrestricted: pick any pending sub-chunk or merge-pass parent under the current raw scope.",
      "Use a per-leaf lock at wiki/.progress/ingest/leaves/<sha1(leafPath)>.lock for sub-chunk work.",
      "Hold the global wiki/.progress/ingest/.lock only briefly during enumeration or state-write critical sections.",
    ].join("\n");
  }
  if (assignedLeaves.length === 0) {
    return [
      "===== ASSIGNED LEAF SCOPE =====",
      "Empty assignment: no leaves were partitioned to this worker for this round.",
      "Exit successfully without performing any ingest work. Do NOT acquire any lock, enumerate leaves, or write state.json.",
      "The Coordinator will reconcile on the next round.",
    ].join("\n");
  }
  return [
    "===== ASSIGNED LEAF SCOPE =====",
    "Process work only within these leaves this round (disjoint from other workers):",
    ...assignedLeaves.map((p) => `- ${p}`),
    "Acquire a per-leaf lock at wiki/.progress/ingest/leaves/<sha1(leafPath)>.lock before touching a leaf's sub-chunks; release it on exit.",
    "Hold the global wiki/.progress/ingest/.lock only briefly when reading/writing wiki/.progress/ingest/.state.json (treat it as a short state mutex, not a long-held run lock).",
    "Process at most one pending sub-chunk from one assigned leaf this invocation. If all assigned leaves are already done or locked by another worker, exit successfully.",
  ].join("\n");
}

function operationPolicy(kind: OrchestratedKind): string {
  if (kind === "lint") {
    return [
      "You are a read-only lint worker. Inspect the wiki for the wiki-lint categories and return findings with file paths and evidence.",
      "Do not write wiki/lint reports, do not edit wiki/index.md, and do not apply --fix. The Coordinator will consolidate and perform the single write pass.",
    ].join("\n");
  }
  if (kind === "ingest-loop") {
    return [
      "You are an ingest worker in a backend-managed loop. Follow wiki-ingest and process at most one sub-chunk or one merge-pass parent, then exit.",
      "Every non-ignored leaf must have one wiki/sources page per original raw file recorded in source_pages_written. Repair missing source pages before reporting completion.",
      "Code Wiki is part of ingest, not a separate command. During enumeration, classify leaves as prose/code/mixed/ignore and include direct-file pseudo-leaves for code files in non-leaf directories. For code or mixed leaves, write source summaries as provenance and record leaf/sub-chunk progress. Do not mirror the source tree into wiki/code/<project>/ or create one page per code file as a completion requirement; graphify materializes code knowledge in wiki/graph after ingest.",
      "If the progress state shows code-looking raw files not represented in state, treat that as the next unit of work and repair the leaf enumeration. Do not repair a done code/mixed leaf by writing wiki/code file or directory pages.",
      "A symlink located under raw/ is a valid source entry: follow it read-only even if its real target is outside the repository, preserve logical raw/... paths in state/citations, and reject only broken links or loops.",
      "Honor your ASSIGNED LEAF SCOPE strictly: only touch leaves listed in your assignment (or any pending leaf if unrestricted). Use a per-leaf lock at wiki/.progress/ingest/leaves/<sha1(leafPath)>.lock for sub-chunk work; the global wiki/.progress/ingest/.lock is only a short state-mutex for enumeration/state-write windows.",
      "If a per-leaf lock is already held by another live process, skip that leaf and try the next assigned leaf. If all assigned leaves are blocked or already done, exit successfully without writing anything.",
      "Do NOT run wiki-graphify and do NOT write anything under wiki/graph/. The backend triggers graph updates as separate invocations only after all ingest work and merge passes are complete.",
    ].join("\n");
  }
  return [
    "You are an ingest worker. Follow wiki-ingest and process exactly one sub-chunk or one merge-pass parent, then exit.",
    "Every non-ignored leaf must have one wiki/sources page per original raw file recorded in source_pages_written. Repair missing source pages before reporting completion.",
    "Code Wiki is part of ingest, not a separate command. During enumeration, classify leaves as prose/code/mixed/ignore and include direct-file pseudo-leaves for code files in non-leaf directories. For code or mixed leaves, write source summaries as provenance and record leaf/sub-chunk progress. Do not mirror the source tree into wiki/code/<project>/ or create one page per code file as a completion requirement; graphify materializes code knowledge in wiki/graph after ingest.",
    "If the progress state shows code-looking raw files not represented in state, treat that as the next unit of work and repair the leaf enumeration. Do not repair a done code/mixed leaf by writing wiki/code file or directory pages.",
    "A symlink located under raw/ is a valid source entry: follow it read-only even if its real target is outside the repository, preserve logical raw/... paths in state/citations, and reject only broken links or loops.",
    "Honor your ASSIGNED LEAF SCOPE strictly: only touch leaves listed in your assignment (or any pending leaf if unrestricted). Use a per-leaf lock at wiki/.progress/ingest/leaves/<sha1(leafPath)>.lock for sub-chunk work; the global wiki/.progress/ingest/.lock is only a short state-mutex for enumeration/state-write windows.",
    "If a per-leaf lock is already held by another live process, skip that leaf and try the next assigned leaf. If all assigned leaves are blocked or already done, exit successfully without writing anything.",
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
}): Promise<WorkerRun[]> {
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
  const isIngest = input.kind === "ingest" || input.kind === "ingest-loop";
  const actionableLeaves = isIngest
    ? await readActionableLeafPaths(input.rawScope ?? null)
    : null;
  const partition = isIngest
    ? partitionActionableLeaves(input.workers.length, actionableLeaves)
    : null;
  for (const worker of input.workers) {
    emitAgentProgress(input.onAgentProgress, worker, {
      status: "assigned",
      round: input.round,
    });
  }
  return Promise.all(
    input.workers.map(async (worker): Promise<WorkerRun> => {
      const leafScopeRef = partition
        ? buildLeafScopeReference(
            // Preserve null (bootstrap / unrestricted) — `??` would coerce
            // it to `[]` which is the "Empty assignment" no-op signal.
            worker.index in partition.assignments
              ? partition.assignments[worker.index]
              : [],
            partition.hasState,
          )
        : null;
      const prompt = wrapWorkerPrompt({
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
        });
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
    glyph: [" /\\_/\\\\", "( c.c )", " > ^ <", " /___\\~"],
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
      onAgentProgress: input.onAgentProgress,
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
          id: "qmd",
          name: "qmd",
          glyph: [" /\\_/\\\\", "( q.q )", " > ^ <", " /___\\~"],
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
          id: "auto-graph-final",
          name: "auto-graph-final",
          glyph: [" /\\_/\\\\", "( g.g )", " > ^ <", " /___\\~"],
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
      assistantAgent: displayManagerName(input.cfg.agent.orchestration.managerName),
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
