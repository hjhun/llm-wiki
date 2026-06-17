/**
 * Pure helpers for the multi-agent orchestrator: kind classification, worker
 * count clamping, deterministic persona seeding, ASCII cell fitting, manager
 * name display, raw-scope parsing, ingest-completion check, and the per-kind
 * mission profiles and operation policy text. No side effects — extracted from
 * multi-agent.ts so they can be unit-tested directly.
 */

import type { Config } from "../config";
import type { ChatKind } from "../chat-events";
import { normalizeRawScope, type ProgressSnapshot } from "../ingest-loop";
import type { MissionProfile, OrchestratedKind, WorkerRun } from "./types";

const ORCHESTRATED_KINDS = new Set<ChatKind>(["ingest", "ingest-loop", "lint"]);

export function isOrchestratedKind(kind: ChatKind): kind is OrchestratedKind {
  return ORCHESTRATED_KINDS.has(kind);
}

export function clampAgentCount(cfg: Config): number {
  return Math.max(1, Math.min(16, cfg.agent.orchestration.maxConcurrentAgents));
}

export function seedOffset(seed: string): number {
  let value = 0;
  for (const char of seed) value = (value * 31 + char.charCodeAt(0)) >>> 0;
  return value;
}

export function displayManagerName(name?: string | null): string {
  const trimmed = name?.trim();
  if (!trimmed || trimmed.toLowerCase() === "manager") return "Coordinator";
  return trimmed;
}

export function fitAsciiCell(value: string, width: number): string {
  const trimmed = value.replace(/\s+/g, " ").trim();
  const text =
    trimmed.length > width
      ? `${trimmed.slice(0, Math.max(0, width - 1))}>`
      : trimmed;
  return text.padEnd(width, " ");
}

export function rawScopeFromMessage(message?: string | null): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  const match = /^\/(?:ingest-loop|ingest)(?:\s+([\s\S]+?))?\s*$/.exec(trimmed);
  const target = match?.[1]?.trim();
  return normalizeRawScope(target);
}

export function ingestWorkComplete(snapshot: ProgressSnapshot): boolean {
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

export function shouldUseDeterministicIngestLoopReply(input: {
  haltKind: string;
  workComplete: boolean;
  failedWorkerRounds: number;
  lastExitCode: number;
}): boolean {
  return (
    input.haltKind === "normal" &&
    input.workComplete &&
    input.failedWorkerRounds === 0 &&
    input.lastExitCode === 0
  );
}

export function buildDeterministicIngestLoopReply(input: {
  haltKind: string;
  haltReason: string;
  rounds: number;
  rawScope: string | null;
  snapshot: ProgressSnapshot;
  runs: WorkerRun[];
  totalDurationMs: number;
}): string {
  const scope = input.rawScope ?? "raw/";
  const durationSeconds = Math.max(0, input.totalDurationMs / 1000);
  const successfulRuns = input.runs
    .filter((run) => run.error == null && (run.result?.exitCode ?? 0) === 0)
    .slice(-5);
  const failedRuns = input.runs
    .filter((run) => run.error != null || (run.result?.exitCode ?? 0) !== 0)
    .slice(-5);

  const lines = [
    `[/ingest-loop ${input.haltKind}] ${input.haltReason}`,
    "",
    `- Scope: \`${scope}\``,
    `- Rounds: ${input.rounds}`,
    `- Duration: ${durationSeconds.toFixed(1)}s`,
    `- Leaves: ${input.snapshot.leavesDone}/${input.snapshot.leavesTotal}`,
    `- Source pages: ${input.snapshot.sourcePagesWritten}/${input.snapshot.filesTotal}`,
    `- Pending merge parents: ${input.snapshot.mergePendingParents}`,
  ];

  if (successfulRuns.length > 0) {
    lines.push("", "Recent completed steps:");
    for (const run of successfulRuns) {
      const duration = run.result?.durationMs;
      const durationText =
        typeof duration === "number" && Number.isFinite(duration)
          ? `, ${Math.max(0, duration / 1000).toFixed(1)}s`
          : "";
      lines.push(`- Round ${run.round}: ${run.worker.name}${durationText}`);
    }
  }

  if (failedRuns.length > 0) {
    lines.push("", "Recent failed steps:");
    for (const run of failedRuns) {
      const exitCode = run.result?.exitCode;
      const reason =
        run.error ?? (typeof exitCode === "number" ? `exitCode=${exitCode}` : "failed");
      lines.push(`- Round ${run.round}: ${run.worker.name} (${reason})`);
    }
  }

  return lines.join("\n");
}

export function missionProfiles(kind: OrchestratedKind): MissionProfile[] {
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

export function operationPolicy(kind: OrchestratedKind): string {
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
      "Honor your ASSIGNED LEAF SCOPE strictly: only touch leaves listed in your assignment (or any pending leaf if unrestricted). Use a per-leaf lock at progress/ingest/leaves/<sha1(leafPath)>.lock for sub-chunk work; the global progress/ingest/.lock is only a short state-mutex for enumeration/state-write windows.",
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
    "Honor your ASSIGNED LEAF SCOPE strictly: only touch leaves listed in your assignment (or any pending leaf if unrestricted). Use a per-leaf lock at progress/ingest/leaves/<sha1(leafPath)>.lock for sub-chunk work; the global progress/ingest/.lock is only a short state-mutex for enumeration/state-write windows.",
    "If a per-leaf lock is already held by another live process, skip that leaf and try the next assigned leaf. If all assigned leaves are blocked or already done, exit successfully without writing anything.",
    "Do NOT run wiki-graphify and do NOT write anything under wiki/graph/. The backend triggers graph updates as separate invocations only after all ingest work and merge passes are complete.",
  ].join("\n");
}

export type WorkerFailureSummary = {
  /** Active workers that ran this round (failed + succeeded). */
  total: number;
  /** Workers that errored or exited non-zero. */
  failed: number;
  /** Persona names of the failed workers, for surfacing to the user. */
  failedNames: string[];
};

/**
 * Summarize how many active workers failed in a round. A round is not halted
 * as long as one worker succeeds (the loop repartitions the failed leaves next
 * round), so a crashed worker is otherwise invisible. Surfacing this count in
 * the session log and the manager progress note tells the user a worker died
 * even though the loop kept going — the partial-failure masking gap. A run
 * counts as failed when it threw (`error`) or its CLI exited non-zero.
 */
export function summarizeWorkerFailures(runs: WorkerRun[]): WorkerFailureSummary {
  const failedNames: string[] = [];
  for (const run of runs) {
    const failed = run.error != null || (run.result?.exitCode ?? 0) !== 0;
    if (failed) failedNames.push(run.worker.name);
  }
  return { total: runs.length, failed: failedNames.length, failedNames };
}

/**
 * Whether a loop worker should resume its own CLI conversation this round
 * instead of starting fresh with the full prompt. True only when session
 * tracking is active, the CLI can resume by id, this is not the first round,
 * and a prior session id was captured.
 */
export function shouldResumeWorker(input: {
  hasSessionTracking: boolean;
  cliSupportsResume: boolean;
  round: number;
  priorSessionId: string | null;
}): boolean {
  return (
    input.hasSessionTracking &&
    input.cliSupportsResume &&
    input.round > 1 &&
    input.priorSessionId != null
  );
}

/**
 * Compact continuation prompt for a worker resuming its OWN host CLI
 * conversation. Operating instructions, skills, policy, persona, and the
 * session log were established earlier in the same conversation and are
 * deliberately not repeated — that is the point of resume. Only per-round
 * dynamics are sent: the freshly partitioned leaf scope and an instruction to
 * re-read the latest on-disk state (which other workers may have advanced)
 * before acting. The durable source of truth stays on disk (wiki +
 * progress files).
 */
export function buildWorkerDeltaPrompt(input: {
  workerName: string;
  round: number;
  leafScopeRef?: string | null;
}): string {
  const lines = [
    `You are continuing as worker ${input.workerName} in this resumed session — /ingest-loop round ${input.round}.`,
    "Your earlier operating instructions, the wiki-ingest skill, the operation policy, your persona, and the active session log from THIS same conversation still apply. Do not reload or restate them.",
    "Other workers may have advanced shared state since your last turn, so before writing, re-read the latest on disk yourself: progress/ingest/.state.json plus the entity registry and any source pages you would touch. Act on that current state, not on what you remember.",
  ];
  if (input.leafScopeRef) lines.push(input.leafScopeRef);
  lines.push(
    "Process at most one pending sub-chunk from your assigned leaves this round per the wiki-ingest one-sub-chunk rule, then exit. If every assigned leaf is already done or locked by another worker, exit successfully without writing. The Coordinator consolidates after the loop — do not loop yourself.",
  );
  return lines.join("\n");
}
