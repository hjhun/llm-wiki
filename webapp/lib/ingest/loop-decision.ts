/**
 * Pure decision logic for the ingest loop driver: when to halt, how to detect
 * progress between rounds, and how to render the per-iteration continuation
 * prompt and state summary. No filesystem, no CLI, no timers — every input is
 * passed in, so the loop's control flow is fully unit-testable.
 *
 * Extracted verbatim from ingest-loop.ts, which re-exports these names so
 * existing `@/lib/ingest-loop` imports are unaffected.
 */

import { normalizeRawScope } from "./scope";
import type { ProgressSnapshot, StateSummary } from "./types";

export function ingestMadeProgress(
  before: ProgressSnapshot,
  after: ProgressSnapshot,
): boolean {
  return (
    after.subChunksDone > before.subChunksDone ||
    after.leavesDone > before.leavesDone ||
    after.sourcePagesWritten > before.sourcePagesWritten ||
    after.sourcePagesMissing < before.sourcePagesMissing ||
    after.codeOutputsWritten > before.codeOutputsWritten ||
    after.codeLeavesMissingOutputs < before.codeLeavesMissingOutputs ||
    after.codeFilePagesMissing < before.codeFilePagesMissing ||
    after.codeDirectoryIndexesMissing < before.codeDirectoryIndexesMissing ||
    (after.mergeDone && !before.mergeDone) ||
    // A merge pass drained a parent from merge_pass.pending_parents — real
    // progress even though no sub-chunk or leaf counter moved.
    after.mergePendingParents < before.mergePendingParents
  );
}

export function newlyDoneLeaves(
  before: ProgressSnapshot,
  after: ProgressSnapshot,
): string[] {
  const prev = new Set(before.doneLeaves);
  return after.doneLeaves.filter((p) => !prev.has(p));
}

/**
 * Whether an ingest round did anything worth resetting the stagnation counter.
 *
 * `ingestMadeProgress` only sees "done"-style counters (sub-chunks/leaves done,
 * source pages written, missing-output counts dropping, merge done/pending).
 * Plenty of legitimate rounds advance real work without moving any of those:
 * enumeration discovering new pending leaves, entity/concept/map/index page
 * synthesis during the merge pass, and partial sub-chunk advancement that does
 * not yet flip a sub-chunk to `done`. Those rounds were miscounted as idle, so
 * the loop gave up (`stalled` / incomplete) after only LOOP_STAGNATION_LIMIT
 * rounds while actionable work still remained.
 *
 * `activityBefore`/`activityAfter` are opaque liveness fingerprints of the
 * ingest state for the round (see `ingestActivitySignature`): if they differ,
 * the worker mutated `.state.json` or appended to `wiki/log.md`, i.e. it did a
 * real unit of work this round even when no completion counter moved. A truly
 * frozen worker (stale `.lock`, stuck `in_progress`) leaves both untouched, so
 * the stagnation guard still fires after the limit.
 */
export function ingestRoundAdvanced(input: {
  before: ProgressSnapshot;
  after: ProgressSnapshot;
  activityBefore: string;
  activityAfter: string;
}): boolean {
  return (
    ingestMadeProgress(input.before, input.after) ||
    input.activityBefore !== input.activityAfter
  );
}

export type LoopDecision =
  | { halt: false }
  | {
      halt: true;
      kind: "normal" | "error" | "stopped" | "capped" | "stalled" | "empty";
      reason: string;
    };

/**
 * Default number of consecutive progress-free rounds tolerated before the loop
 * is declared stalled. A stuck `in_progress` sub-chunk or a stale `.lock` would
 * otherwise spin every remaining iteration up to `maxIterations`. Callers may
 * override this with a configured `stagnationLimit`
 * (`cli.ingestLoop.maxStagnantRounds`); this constant is the fallback.
 */
export const LOOP_STAGNATION_LIMIT = 3;

export function decideLoopHalt(input: {
  exitCode: number;
  summary: StateSummary | null;
  mergeDone: boolean;
  mergePending: boolean;
  idleRounds: number;
  stopRequested: boolean;
  iteration: number;
  maxIter: number;
  /**
   * Consecutive progress-free rounds tolerated before halting as `stalled`.
   * Defaults to `LOOP_STAGNATION_LIMIT` when omitted.
   */
  stagnationLimit?: number;
  sourcePagesMissing?: number;
  codeLeavesMissingOutputs?: number;
  codeFilePagesMissing?: number;
  codeDirectoryIndexesMissing?: number;
  rawScope?: string | null;
}): LoopDecision {
  const stagnationLimit = input.stagnationLimit ?? LOOP_STAGNATION_LIMIT;
  if (input.exitCode !== 0) {
    return {
      halt: true,
      kind: "error",
      reason: `CLI exitCode=${input.exitCode}`,
    };
  }
  if (input.summary && input.summary.error > 0) {
    return {
      halt: true,
      kind: "error",
      reason: `sub-chunk ${input.summary.error}건이 error 상태로 종료`,
    };
  }
  if (input.stopRequested) {
    return { halt: true, kind: "stopped", reason: "사용자 Stop 요청" };
  }
  if (input.iteration >= input.maxIter) {
    return {
      halt: true,
      kind: "capped",
      reason: `최대 반복 ${input.maxIter}회에 도달`,
    };
  }
  // Nothing to ingest: a round ran but enumerated no leaf within scope
  // (`total` counts done leaves too, so genuine completion has total > 0).
  // Without this branch the empty case falls into the completion branch below
  // and is misreported as "모든 leaf 완료 (0/0)", hiding that the scope matched
  // no source files at all — the exact confusion a wrong or non-existent
  // /ingest-loop path produces. Halt explicitly with an actionable reason
  // instead of spinning idle rounds into a generic "stalled".
  if (input.summary && input.summary.total === 0) {
    const scope = normalizeRawScope(input.rawScope);
    return {
      halt: true,
      kind: "empty",
      reason: scope
        ? `지정한 스코프 ${scope}에 ingest할 파일이 없습니다. raw/ 아래에 해당 경로(또는 raw/ 하위의 승인된 심볼릭 링크)가 존재하는지 확인하세요.`
        : `raw/ 아래에 ingest할 파일이 없습니다.`,
    };
  }
  // Completion: every leaf is done and no merge work is outstanding.
  // This must NOT gate on `mergeDone` alone. `merge_pass.status` only flips to
  // "done" after a merge pass drains `pending_parents`; a run with no parent to
  // merge (single leaf, already-ingested scope, empty raw/) leaves the status
  // at "idle" forever. Gating on `mergeDone` then makes the loop spin to
  // maxIter even though every worker already reports the work complete.
  if (
    input.summary &&
    input.summary.pending === 0 &&
    input.summary.in_progress === 0 &&
    input.summary.partial === 0 &&
    (input.sourcePagesMissing ?? 0) === 0 &&
    (input.codeLeavesMissingOutputs ?? 0) === 0 &&
    (input.codeFilePagesMissing ?? 0) === 0 &&
    (input.codeDirectoryIndexesMissing ?? 0) === 0 &&
    (input.mergeDone || !input.mergePending)
  ) {
    return {
      halt: true,
      kind: "normal",
      reason: input.mergeDone
        ? `모든 leaf 완료 + merge pass done (${input.summary.done}/${input.summary.total})`
        : `모든 leaf 완료 · 남은 merge 작업 없음 (${input.summary.done}/${input.summary.total})`,
    };
  }
  if (
    input.idleRounds >= stagnationLimit &&
    ((input.sourcePagesMissing ?? 0) > 0 ||
      (input.codeLeavesMissingOutputs ?? 0) > 0 ||
      (input.codeFilePagesMissing ?? 0) > 0 ||
      (input.codeDirectoryIndexesMissing ?? 0) > 0)
  ) {
    return {
      halt: true,
      kind: "stalled",
      reason:
        `ingest 산출물 누락 ` +
        `(source leaves=${input.sourcePagesMissing ?? 0}, ` +
        `code leaf progress=${input.codeLeavesMissingOutputs ?? 0}, ` +
        `untracked code files=${input.codeFilePagesMissing ?? 0}, ` +
        `legacy code directories=${input.codeDirectoryIndexesMissing ?? 0})이 ` +
        `연속 ${input.idleRounds}개 라운드에서 해결되지 않아 중단`,
    };
  }
  // Stagnation guard: aside from error/stop/cap and the completion branch
  // above, the loop has no other exit. If several consecutive rounds advance
  // nothing — a stuck `in_progress` sub-chunk, a stale `.lock`, or a merge
  // pass that cannot proceed — spinning to maxIter is pure waste. Halt and let
  // the manager report the stall.
  if (input.idleRounds >= stagnationLimit) {
    return {
      halt: true,
      kind: "stalled",
      reason: `연속 ${input.idleRounds}개 라운드에서 진행이 없어 중단`,
    };
  }
  return { halt: false };
}

/** Note appended when the final graphify merge is skipped as redundant. */
export const FINAL_GRAPH_SKIPPED_NOTE =
  "\n\n---\n\n[auto graph] 루프 중에 full merge가 이미 실행되어 final merge는 생략합니다.";

export type IngestLoopHaltKind =
  | "normal"
  | "error"
  | "stopped"
  | "capped"
  | "stalled"
  | "empty";

export type IngestLoopFinalizePlan = {
  /** Refresh the qmd search index. */
  runQmd: boolean;
  /** Run the final `wiki-graphify update` merge. */
  runGraph: boolean;
  /** The final graph merge was skipped because the loop already merged it. */
  graphSkipped: boolean;
  /** Run the closing deterministic post-merge mini-lint. */
  runLint: boolean;
};

/**
 * Decide which loop-exit finalization steps run (qmd refresh, final graphify
 * merge, closing mini-lint). This sequence was previously inlined and copy
 * pasted in both the single-agent (`runIngestLoop`) and multi-agent
 * (`runLoopOperation`) drivers, and it drifted — the multi-agent path silently
 * dropped the post-merge mini-lint. Centralizing the gating here keeps the two
 * drivers honest and makes the *intended* divergence explicit via `driver`:
 *
 * - `single` ran graphify incrementally between rounds, so it gates qmd/lint on
 *   "did anything change" (`progressed`) and skips the final merge when the last
 *   incremental merge already covers the latest state (`graphAlreadyCoversLatest`).
 * - `multi` never runs incremental graphify, so it gates the whole block on
 *   full completion (`workComplete`) plus not-aborted, and always runs the final
 *   merge.
 *
 * Output sinks still differ (string reply vs synthetic worker runs), so each
 * driver consumes this plan and performs its own side effects; only the
 * what-runs-when decision is shared.
 */
export function decideIngestLoopFinalize(input: {
  driver: "single" | "multi";
  haltKind: IngestLoopHaltKind;
  aborted: boolean;
  progressed: boolean;
  workComplete: boolean;
  graphAlreadyCoversLatest: boolean;
  finalMaintenanceEnabled?: boolean;
}): IngestLoopFinalizePlan {
  const finalMaintenanceEnabled = input.finalMaintenanceEnabled ?? true;
  if (input.driver === "single") {
    const active = input.haltKind !== "error";
    return {
      runQmd: active && input.progressed && finalMaintenanceEnabled,
      runGraph:
        active && !input.graphAlreadyCoversLatest && finalMaintenanceEnabled,
      graphSkipped: active && input.graphAlreadyCoversLatest,
      runLint:
        active &&
        input.haltKind === "normal" &&
        input.progressed &&
        finalMaintenanceEnabled,
    };
  }
  const block =
    !input.aborted && input.haltKind !== "error" && input.workComplete;
  return {
    runQmd: block && finalMaintenanceEnabled,
    runGraph: block && finalMaintenanceEnabled,
    graphSkipped: false,
    runLint:
      block &&
      input.haltKind === "normal" &&
      input.progressed &&
      finalMaintenanceEnabled,
  };
}

export function buildLoopContinuationPrompt(input: {
  sessionPath: string;
  iteration: number;
  progressRef: string | null;
  entityRegistryRef?: string | null;
  sourcePageStatusRef?: string | null;
  codeWikiStatusRef?: string | null;
  rawScope?: string | null;
}): string {
  const rawScope = normalizeRawScope(input.rawScope);
  const lines: string[] = [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md in this repository and follow .agents/skills/wiki-ingest/SKILL.md. If additional skills are needed, project .agents/skills takes priority, then ~/.agents/skills, then host-specific global skill directories such as ~/.codex/skills or ~/.claude/skills.",
    `Active session log: sessions/${input.sessionPath}`,
  ];
  if (rawScope) {
    lines.push(
      `Original /ingest-loop target scope: ${rawScope}. Continue processing exactly this scope; do not pick pending leaves outside it unless the merge parent is needed for this scope.`,
    );
  }
  if (input.progressRef) lines.push(input.progressRef);
  if (input.entityRegistryRef) lines.push(input.entityRegistryRef);
  if (input.sourcePageStatusRef) lines.push(input.sourcePageStatusRef);
  if (input.codeWikiStatusRef) lines.push(input.codeWikiStatusRef);
  lines.push(
    `This is /ingest-loop iteration ${input.iteration}. Pick the next pending sub-chunk, merge-pass parent, or missing direct-file pseudo-leaf enumeration from wiki/.progress/ingest/.state.json${rawScope ? ` within ${rawScope}` : ""} and process exactly one unit per the wiki-ingest skill, then exit. Do not loop yourself — the backend will spawn the next iteration. For code/mixed leaves, do not create mirrored wiki/code file pages as a repair task; graphify runs separately after ingest progress is complete.`,
    "",
    "===== CONVERSATION =====",
    rawScope ? `User: /ingest-loop ${rawScope}` : "User: /ingest",
    "",
    "Respond now as the assistant.",
  );
  return lines.join("\n");
}

export function formatStateSummary(s: StateSummary): string {
  const counts =
    `leaves ${s.done}/${s.total} done` +
    (s.in_progress ? ` · ${s.in_progress} in_progress` : "") +
    (s.partial ? ` · ${s.partial} partial` : "") +
    (s.pending ? ` · ${s.pending} pending` : "") +
    (s.error ? ` · ${s.error} error` : "");
  if (s.active_leaf) {
    const sc = s.active_subchunk
      ? ` (sub-chunk ${s.active_subchunk.id} ${s.active_subchunk.status})`
      : "";
    return `${counts} · ${s.active_leaf}${sc}`;
  }
  return counts;
}
