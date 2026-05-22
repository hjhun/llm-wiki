import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { runCli, type CliName, type RunResult } from "./cli";
import type { Config } from "./config";
import { buildGraphifyPrompt } from "./graph";
import {
  PROJECT_ROOT,
  WIKI_GRAPH_PATH,
} from "./paths";
import { appendMessage } from "./sessions";
import { errorMessage } from "./api";

export const PROGRESS_DASHBOARD_PATH = "wiki/.progress/ingest/DASHBOARD.md";
export const PROGRESS_STATE_PATH = "wiki/.progress/ingest/.state.json";
export const PROGRESS_STOP_PATH = "wiki/.progress/ingest/.stop";
export const PROGRESS_STOP_DIR = "wiki/.progress/ingest/stops";
export const PROGRESS_LOCK_PATH = "wiki/.progress/ingest/.lock";
export const WIKI_LOG_REL = "wiki/log.md";
export const WIKI_INDEX_REL = "wiki/index.md";

export type StateSummary = {
  total: number;
  done: number;
  in_progress: number;
  partial: number;
  pending: number;
  error: number;
  active_leaf: string | null;
  active_subchunk: { id: string; status: string } | null;
};

export type ProgressSnapshot = {
  leavesTotal: number;
  leavesDone: number;
  subChunksTotal: number;
  subChunksDone: number;
  filesTotal: number;
  bytesTotal: number;
  sourcePagesWritten: number;
  mergeDone: boolean;
  /** Count of parent dirs still queued in merge_pass.pending_parents. */
  mergePendingParents: number;
  /** Sorted POSIX paths of leaves whose status === "done". */
  doneLeaves: string[];
};

export const EMPTY_SNAPSHOT: ProgressSnapshot = {
  leavesTotal: 0,
  leavesDone: 0,
  subChunksTotal: 0,
  subChunksDone: 0,
  filesTotal: 0,
  bytesTotal: 0,
  sourcePagesWritten: 0,
  mergeDone: false,
  mergePendingParents: 0,
  doneLeaves: [],
};

export async function buildProgressReference(): Promise<string | null> {
  try {
    const abs = path.join(PROJECT_ROOT, PROGRESS_DASHBOARD_PATH);
    const head = await fs.readFile(abs, "utf8");
    const lines = head.split(/\r?\n/).slice(0, 4).join("\n").trim();
    if (!lines) return null;
    return `Progress reference (${PROGRESS_DASHBOARD_PATH}):\n${lines}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

const ENTITY_REGISTRY_MAX = 400;

/**
 * Compact reference of existing entity/concept page names from wiki/index.md.
 * Injected into ingest worker prompts so parallel, stateless workers reuse
 * canonical page names and [[wikilinks]] instead of minting near-duplicates —
 * the root cause of duplicate, poorly connected graph nodes in multi-agent
 * runs.
 */
export async function buildEntityRegistryReference(): Promise<string | null> {
  let text: string;
  try {
    text = await fs.readFile(
      path.join(PROJECT_ROOT, WIKI_INDEX_REL),
      "utf8",
    );
  } catch {
    return null;
  }
  const names: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const title = heading[1].toLowerCase();
      inSection = title.includes("entit") || title.includes("concept");
      continue;
    }
    if (!inSection) continue;
    for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const name = m[1].split("|")[0].trim();
      if (name) names.push(name);
    }
  }
  if (names.length === 0) return null;
  const unique = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  const shown = unique.slice(0, ENTITY_REGISTRY_MAX);
  const suffix =
    unique.length > ENTITY_REGISTRY_MAX
      ? ` … (+${unique.length - ENTITY_REGISTRY_MAX} more)`
      : "";
  return (
    `Existing entity/concept pages (${WIKI_INDEX_REL}) — before creating a ` +
    `new entity/concept page, reuse one of these exact names and its ` +
    `[[wikilink]] when it refers to the same target (incl. case/spacing/` +
    `language variants):\n` +
    shown.map((n) => `[[${n}]]`).join(", ") +
    suffix
  );
}

export async function readProgressSnapshot(): Promise<ProgressSnapshot> {
  try {
    const raw = await fs.readFile(
      path.join(PROJECT_ROOT, PROGRESS_STATE_PATH),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      merge_pass?: { status?: unknown; pending_parents?: unknown };
      leaves?: Record<string, unknown>;
    };
    const doneLeaves: string[] = [];
    const filePaths = new Set<string>();
    const pendingParents = parsed.merge_pass?.pending_parents;
    const snap: ProgressSnapshot = {
      leavesTotal: 0,
      leavesDone: 0,
      subChunksTotal: 0,
      subChunksDone: 0,
      filesTotal: 0,
      bytesTotal: 0,
      sourcePagesWritten: 0,
      mergeDone: parsed.merge_pass?.status === "done",
      mergePendingParents: Array.isArray(pendingParents)
        ? pendingParents.length
        : 0,
      doneLeaves,
    };
    if (parsed.leaves && typeof parsed.leaves === "object") {
      for (const [leafPath, value] of Object.entries(parsed.leaves)) {
        const leaf = (value ?? {}) as Record<string, unknown>;
        if (leaf.status !== "stale") {
          snap.leavesTotal += 1;
        }
        if (leaf.status === "done") {
          snap.leavesDone += 1;
          doneLeaves.push(leafPath);
        }
        if (Array.isArray(leaf.sub_chunks)) {
          for (const rawSc of leaf.sub_chunks) {
            const sc =
              rawSc && typeof rawSc === "object"
                ? (rawSc as Record<string, unknown>)
                : null;
            if (!sc) continue;
            snap.subChunksTotal += 1;
            if (Array.isArray(sc.files)) {
              for (const filePath of sc.files) {
                if (typeof filePath === "string" && filePath) {
                  filePaths.add(filePath);
                }
              }
            }
            if (sc.status === "done") {
              snap.subChunksDone += 1;
              if (Array.isArray(sc.source_pages_written)) {
                snap.sourcePagesWritten += sc.source_pages_written.length;
              }
            }
          }
        }
      }
    }
    doneLeaves.sort();
    snap.filesTotal = filePaths.size;
    snap.bytesTotal = await totalRelativeFileBytes(filePaths);
    return snap;
  } catch {
    return { ...EMPTY_SNAPSHOT, doneLeaves: [] };
  }
}

async function totalRelativeFileBytes(filePaths: Iterable<string>): Promise<number> {
  let total = 0;
  for (const filePath of filePaths) {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized) continue;
    const abs = path.resolve(PROJECT_ROOT, normalized);
    const root = `${PROJECT_ROOT}${path.sep}`;
    if (abs !== PROJECT_ROOT && !abs.startsWith(root)) continue;
    try {
      const st = await fs.stat(abs);
      if (st.isFile()) total += st.size;
    } catch {
      // Best-effort workload estimate; missing files simply do not count.
    }
  }
  return total;
}

export function ingestMadeProgress(
  before: ProgressSnapshot,
  after: ProgressSnapshot,
): boolean {
  return (
    after.subChunksDone > before.subChunksDone ||
    after.leavesDone > before.leavesDone ||
    after.sourcePagesWritten > before.sourcePagesWritten ||
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

export async function readIngestStateSummary(): Promise<StateSummary | null> {
  try {
    const raw = await fs.readFile(
      path.join(PROJECT_ROOT, PROGRESS_STATE_PATH),
      "utf8",
    );
    return summarizeIngestState(raw);
  } catch {
    return null;
  }
}

function sessionStopFlagAbs(sessionPath: string): string {
  const key = createHash("sha1").update(sessionPath).digest("hex");
  return path.join(PROJECT_ROOT, PROGRESS_STOP_DIR, `${key}.stop`);
}

function legacyStopFlagAbs(): string {
  return path.join(PROJECT_ROOT, PROGRESS_STOP_PATH);
}

export async function requestStopFlag(sessionPath: string): Promise<void> {
  const abs = sessionStopFlagAbs(sessionPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(
    abs,
    JSON.stringify({ sessionPath, requested_at: new Date().toISOString() }) +
      "\n",
    "utf8",
  );
}

export async function stopFlagExists(sessionPath?: string): Promise<boolean> {
  try {
    await fs.access(
      sessionPath ? sessionStopFlagAbs(sessionPath) : legacyStopFlagAbs(),
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearStopFlag(sessionPath?: string): Promise<void> {
  try {
    await fs.rm(
      sessionPath ? sessionStopFlagAbs(sessionPath) : legacyStopFlagAbs(),
      { force: true },
    );
  } catch {
    // Best-effort cleanup; the next loop run will overwrite or re-check it.
  }
}

export async function lockFileExists(): Promise<boolean> {
  try {
    await fs.access(path.join(PROJECT_ROOT, PROGRESS_LOCK_PATH));
    return true;
  } catch {
    return false;
  }
}

export type LoopDecision =
  | { halt: false }
  | {
      halt: true;
      kind: "normal" | "error" | "stopped" | "capped" | "stalled";
      reason: string;
    };

/**
 * Consecutive progress-free rounds tolerated before the loop is declared
 * stalled. A stuck `in_progress` sub-chunk or a stale `.lock` would otherwise
 * spin every remaining iteration up to `maxIterations`.
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
}): LoopDecision {
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
  // Stagnation guard: aside from error/stop/cap and the completion branch
  // above, the loop has no other exit. If several consecutive rounds advance
  // nothing — a stuck `in_progress` sub-chunk, a stale `.lock`, or a merge
  // pass that cannot proceed — spinning to maxIter is pure waste. Halt and let
  // the manager report the stall.
  if (input.idleRounds >= LOOP_STAGNATION_LIMIT) {
    return {
      halt: true,
      kind: "stalled",
      reason: `연속 ${input.idleRounds}개 라운드에서 진행이 없어 중단`,
    };
  }
  return { halt: false };
}

export function buildLoopContinuationPrompt(input: {
  sessionPath: string;
  iteration: number;
  progressRef: string | null;
  entityRegistryRef?: string | null;
}): string {
  const lines: string[] = [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md in this repository and follow .agents/skills/wiki-ingest/SKILL.md. If additional skills are needed, project .agents/skills takes priority, then ~/.agents/skills, then host-specific global skill directories such as ~/.codex/skills or ~/.claude/skills.",
    `Active session log: sessions/${input.sessionPath}`,
  ];
  if (input.progressRef) lines.push(input.progressRef);
  if (input.entityRegistryRef) lines.push(input.entityRegistryRef);
  lines.push(
    `This is /ingest-loop iteration ${input.iteration}. Pick the next pending sub-chunk from wiki/.progress/ingest/.state.json and process exactly one sub-chunk per the wiki-ingest skill, then exit. Do not loop yourself — the backend will spawn the next iteration.`,
    "",
    "===== CONVERSATION =====",
    "User: /ingest",
    "",
    "Respond now as the assistant.",
  );
  return lines.join("\n");
}

function stateLeafBelongsToSession(
  leaf: Record<string, unknown>,
  sessionPath: string,
): boolean {
  const lastSession = typeof leaf.last_session === "string" ? leaf.last_session : "";
  return lastSession === sessionPath || lastSession === `sessions/${sessionPath}`;
}

export function summarizeIngestState(
  raw: string,
  options: { sessionPath?: string } = {},
): StateSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("leaves" in parsed) ||
    typeof (parsed as { leaves: unknown }).leaves !== "object" ||
    (parsed as { leaves: unknown }).leaves == null
  ) {
    return null;
  }
  const leaves = (parsed as { leaves: Record<string, unknown> }).leaves;
  const summary: StateSummary = {
    total: 0,
    done: 0,
    in_progress: 0,
    partial: 0,
    pending: 0,
    error: 0,
    active_leaf: null,
    active_subchunk: null,
  };
  for (const [leafPath, leafValue] of Object.entries(leaves)) {
    const leaf = (leafValue ?? {}) as Record<string, unknown>;
    if (
      options.sessionPath &&
      !stateLeafBelongsToSession(leaf, options.sessionPath)
    ) {
      continue;
    }
    const status = typeof leaf.status === "string" ? leaf.status : "pending";
    // A "stale" leaf is one whose source files vanished from disk
    // (wiki-ingest §Step 1). It is not actionable work, so exclude it entirely
    // — matching readProgressSnapshot — instead of letting it fall into the
    // "pending" bucket, where it would permanently block the loop's completion
    // check.
    if (status === "stale") continue;
    summary.total += 1;
    if (status === "done") summary.done += 1;
    else if (status === "in_progress") summary.in_progress += 1;
    else if (status === "partial") summary.partial += 1;
    else if (status === "error") summary.error += 1;
    else summary.pending += 1;
    if (summary.active_leaf == null && Array.isArray(leaf.sub_chunks)) {
      for (const sc of leaf.sub_chunks as Array<Record<string, unknown>>) {
        if (sc && typeof sc === "object" && sc.status === "in_progress") {
          summary.active_leaf = leafPath;
          summary.active_subchunk = {
            id: String(sc.id ?? "?"),
            status: "in_progress",
          };
          break;
        }
      }
    }
  }
  if (options.sessionPath && summary.total === 0) return null;
  return summary;
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

type IngestLoopCliAttempt =
  | { ok: true; result: RunResult; attempts: number; durationMs: number }
  | {
      ok: false;
      kind: "error" | "stopped";
      reason: string;
      lastExitCode: number;
      attempts: number;
      durationMs: number;
    };

function retryDelayMs(backoffs: number[], attempt: number): number {
  if (backoffs.length === 0) return 0;
  return backoffs[Math.min(attempt - 1, backoffs.length - 1)] ?? 0;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted while waiting to retry"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function resultFailureSummary(result: RunResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const suffix = detail ? `: ${detail.slice(0, 500)}` : "";
  return `CLI exitCode=${result.exitCode}${suffix}`;
}

async function runCliWithIngestLoopRetries(input: {
  agent: CliName;
  prompt: string;
  cfg: Config;
  timeoutMs?: number;
  signal?: AbortSignal;
  iteration: number;
  sessionPath: string;
  onChunk?: (text: string) => void;
}): Promise<IngestLoopCliAttempt> {
  const maxAttempts = input.cfg.cli.ingestLoop.maxRetryAttempts;
  const backoffs = input.cfg.cli.ingestLoop.retryBackoffMs;
  let totalDurationMs = 0;
  let lastExitCode = 0;
  let lastFailure = "CLI 호출 실패";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await stopFlagExists(input.sessionPath)) {
      return {
        ok: false,
        kind: "stopped",
        reason: "사용자 Stop 요청",
        lastExitCode,
        attempts: attempt - 1,
        durationMs: totalDurationMs,
      };
    }

    try {
      const result = await runCli(input.agent, input.prompt, {
        safeMode: input.cfg.agent.safeMode,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        killOnAbort: input.timeoutMs != null,
        onStdout: (chunk) => {
          input.onChunk?.(chunk);
        },
      });
      totalDurationMs += result.durationMs;
      lastExitCode = result.exitCode;

      if (result.exitCode === 0) {
        return {
          ok: true,
          result,
          attempts: attempt,
          durationMs: totalDurationMs,
        };
      }

      lastFailure = resultFailureSummary(result);
    } catch (err) {
      lastExitCode = -1;
      lastFailure = `CLI 호출 실패: ${errorMessage(err)}`;
    }

    const failedSummary = await readIngestStateSummary();
    if (failedSummary && failedSummary.error > 0) {
      const reason = `sub-chunk ${failedSummary.error}건이 error 상태로 종료`;
      await appendMessage(
        input.sessionPath,
        "system",
        `❌ /ingest-loop iter ${input.iteration} 처리 오류 감지: ${reason}`,
      ).catch(() => undefined);
      return {
        ok: false,
        kind: "error",
        reason,
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }

    const exhausted = attempt >= maxAttempts;
    const prefix = `❌ /ingest-loop iter ${input.iteration} CLI 시도 ${attempt}/${maxAttempts} 실패`;
    if (exhausted) {
      const reason = `${maxAttempts}회 시도 모두 실패: ${lastFailure}`;
      await appendMessage(
        input.sessionPath,
        "system",
        `${prefix}: ${lastFailure}`,
      ).catch(() => undefined);
      input.onChunk?.(`\n\n---\n${prefix}: ${lastFailure}\n`);
      return {
        ok: false,
        kind: "error",
        reason,
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }

    const waitMs = retryDelayMs(backoffs, attempt);
    const retryNote =
      `${prefix}: ${lastFailure}\n` +
      `↻ ${Math.round(waitMs / 1000)}초 후 같은 iteration을 재시도합니다.`;
    await appendMessage(input.sessionPath, "system", retryNote).catch(
      () => undefined,
    );
    input.onChunk?.(`\n\n---\n${retryNote}\n`);

    if (await stopFlagExists(input.sessionPath)) {
      return {
        ok: false,
        kind: "stopped",
        reason: "사용자 Stop 요청",
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }
    try {
      await delay(waitMs, input.signal);
    } catch (err) {
      return {
        ok: false,
        kind: "error",
        reason: errorMessage(err),
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }
  }

  return {
    ok: false,
    kind: "error",
    reason: lastFailure,
    lastExitCode,
    attempts: maxAttempts,
    durationMs: totalDurationMs,
  };
}

export type GraphifyAction = "update";

export type MaybeAutoRunGraphifyInput = {
  cfg: Config;
  agent: CliName;
  sessionPath: string;
  signal?: AbortSignal;
  lastExitCode: number;
  before: ProgressSnapshot;
  after: ProgressSnapshot;
  mode: "incremental" | "final";
  onChunk?: (text: string) => void;
};

export type MaybeAutoRunGraphifyResult = {
  note: string;
  action: GraphifyAction | null;
  succeeded: boolean;
};

function graphIncrementalDecision(
  cfg: Config,
  snapshot: ProgressSnapshot,
): { enabled: boolean; reason: string } {
  const strategy = cfg.graph.autoUpdateStrategy;
  if (strategy === "partialAndFinal") {
    return { enabled: true, reason: "strategy=partialAndFinal" };
  }
  if (strategy === "finalOnly") {
    return { enabled: false, reason: "strategy=finalOnly" };
  }

  const thresholds = cfg.graph.partialThresholds;
  const hits = [
    snapshot.leavesTotal >= thresholds.minLeaves
      ? `leaves ${snapshot.leavesTotal} >= ${thresholds.minLeaves}`
      : null,
    snapshot.filesTotal >= thresholds.minFiles
      ? `files ${snapshot.filesTotal} >= ${thresholds.minFiles}`
      : null,
    snapshot.bytesTotal >= thresholds.minBytes
      ? `bytes ${snapshot.bytesTotal} >= ${thresholds.minBytes}`
      : null,
    snapshot.subChunksTotal >= thresholds.minSubChunks
      ? `sub-chunks ${snapshot.subChunksTotal} >= ${thresholds.minSubChunks}`
      : null,
  ].filter((hit): hit is string => hit !== null);

  if (hits.length > 0) {
    return { enabled: true, reason: `strategy=auto; ${hits.join(", ")}` };
  }
  return {
    enabled: false,
    reason:
      `strategy=auto; workload below thresholds ` +
      `(leaves=${snapshot.leavesTotal}, files=${snapshot.filesTotal}, ` +
      `bytes=${snapshot.bytesTotal}, subChunks=${snapshot.subChunksTotal})`,
  };
}

async function validateGraphifyArtifacts(
  snapshot: ProgressSnapshot,
): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(WIKI_GRAPH_PATH, "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? "`wiki/graph/graph.json`이 생성되지 않았습니다."
      : `\`wiki/graph/graph.json\`을 읽거나 파싱하지 못했습니다: ${errorMessage(err)}`;
  }
  const root =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  const nodes = Array.isArray(root?.nodes) ? root.nodes : null;
  const edges = Array.isArray(root?.edges) ? root.edges : null;
  if (!nodes || !edges) {
    return "`wiki/graph/graph.json` schema가 유효하지 않습니다: nodes/edges 배열이 필요합니다.";
  }
  if (snapshot.sourcePagesWritten > 0 && nodes.length === 0) {
    return (
      "ingest가 source page를 생성했지만 graph update 결과가 빈 그래프입니다. " +
      "대상 leaf extraction 또는 merge pass를 다시 확인해야 합니다."
    );
  }
  return null;
}

export async function maybeAutoRunGraphify(
  input: MaybeAutoRunGraphifyInput,
): Promise<MaybeAutoRunGraphifyResult> {
  const noop: MaybeAutoRunGraphifyResult = {
    note: "",
    action: null,
    succeeded: true,
  };
  if (input.lastExitCode !== 0) return noop;
  if (!input.cfg.graph.autoUpdateOnIngest) return noop;
  if (!ingestMadeProgress(input.before, input.after)) return noop;

  const mergeJustDone = input.after.mergeDone && !input.before.mergeDone;
  const justDoneLeaves = newlyDoneLeaves(input.before, input.after);

  let action: GraphifyAction;
  let leafPaths: string[] | undefined;
  let progressLabel: string;

  if (input.mode === "final") {
    action = "update";
    progressLabel = mergeJustDone
      ? "merge pass 완료 + final merge"
      : `leaves ${input.after.leavesDone}/${
          input.before.leavesDone +
          (input.after.leavesDone - input.before.leavesDone)
        } · final merge`;
  } else if (mergeJustDone) {
    action = "update";
    progressLabel = "merge pass 완료";
  } else if (justDoneLeaves.length > 0) {
    const incrementalDecision = graphIncrementalDecision(input.cfg, input.after);
    if (!incrementalDecision.enabled) {
      return {
        note:
          `\n\n---\n\n[auto graph · scoped update skipped] ` +
          `${incrementalDecision.reason}; final \`wiki-graphify update\` will handle changed leaves.\n`,
        action: null,
        succeeded: true,
      };
    }
    action = "update";
    leafPaths = justDoneLeaves;
    progressLabel =
      `leaf 완료 ${justDoneLeaves.length}건 · scoped update + full merge · ` +
      incrementalDecision.reason;
  } else {
    return noop;
  }

  const commandLabel =
    leafPaths && leafPaths.length > 0
      ? `wiki-graphify ${action} (${leafPaths.join(", ")})`
      : `wiki-graphify ${action}`;

  await appendMessage(
    input.sessionPath,
    "system",
    `ingest 진행 감지 (${progressLabel}); auto-running ${commandLabel}`,
  );
  const graphPrompt = buildGraphifyPrompt(action, input.sessionPath, {
    leafPaths,
  });
  const note = `\n\n---\n\n[auto graph · ${progressLabel}] \`${commandLabel}\`를 별도 CLI 호출로 실행합니다.\n`;
  input.onChunk?.(note);

  const graphTimeout = input.cfg.cli.timeouts.graph;
  try {
    const graphResult = await runCli(input.agent, graphPrompt, {
      safeMode: input.cfg.agent.safeMode,
      timeoutMs: graphTimeout ?? undefined,
      signal: input.signal,
      killOnAbort: input.signal ? true : graphTimeout != null,
      onStdout: (chunk) => {
        input.onChunk?.(chunk);
      },
    });
    const graphReply =
      graphResult.stdout.trim() ||
      graphResult.stderr.trim() ||
      `(그래프 업데이트가 빈 응답을 반환했습니다. exitCode=${graphResult.exitCode})`;
    if (graphResult.exitCode !== 0) {
      return {
        note:
          `${note}\n\n---\n\n[auto graph blocker · ${commandLabel}]\n` +
          `그래프 호출이 실패했습니다: exitCode=${graphResult.exitCode}\n\n${graphReply}`,
        action: null,
        succeeded: false,
      };
    }
    const validationError = await validateGraphifyArtifacts(input.after);
    if (validationError) {
      return {
        note:
          `${note}\n\n---\n\n[auto graph blocker · ${commandLabel}]\n` +
          `${validationError}\n\n${graphReply}`,
        action: null,
        succeeded: false,
      };
    }
    return {
      note: `${note}\n\n---\n\n[auto graph result · ${commandLabel}]\n${graphReply}`,
      action,
      succeeded: true,
    };
  } catch (err) {
    const graphError = errorMessage(err);
    await appendMessage(
      input.sessionPath,
      "system",
      `❌ 자동 그래프 호출 실패 (${commandLabel}): ${graphError}`,
    ).catch(() => undefined);
    return {
      note:
        `${note}\n\n---\n\n[auto graph blocker · ${commandLabel}]\n` +
        `ingest는 진행됐지만 자동 그래프 호출이 실패했습니다: ${graphError}`,
      action: null,
      succeeded: false,
    };
  }
}

export type RunIngestLoopInput = {
  cfg: Config;
  agent: CliName;
  sessionPath: string;
  /** Prompt used for the first iteration. Subsequent iterations build their own. */
  initialPrompt: string;
  /** Optional pre-built progress reference. The loop reads a fresh one for later iters. */
  progressRef?: string | null;
  /**
   * Leave an existing stop flag untouched. Auto-ingest uses this when it is
   * invoked while another ingest may own the flag, so it cannot erase a
   * user's "stop after current sub-chunk" request.
   */
  preserveStopFlag?: boolean;
  signal?: AbortSignal;
  /** Streams stdout chunks from the CLI back to the caller. */
  onChunk?: (text: string) => void;
};

export type RunIngestLoopResult = {
  finalReply: string;
  lastExitCode: number;
  totalDurationMs: number;
  iterations: number;
  haltKind: "normal" | "error" | "stopped" | "capped" | "stalled";
  haltReason: string;
  loopBefore: ProgressSnapshot;
  loopAfter: ProgressSnapshot;
  /** True when at least one sub-chunk advanced during the loop. */
  anyProgress: boolean;
};

export async function runIngestLoop(
  input: RunIngestLoopInput,
): Promise<RunIngestLoopResult> {
  const { cfg, agent, sessionPath, initialPrompt, signal, onChunk } = input;
  if (!input.preserveStopFlag) {
    await clearStopFlag(sessionPath);
  }
  const maxIter = cfg.cli.ingestLoop.maxIterations;
  await appendMessage(
    sessionPath,
    "system",
    `🔁 /ingest-loop 시작 (최대 ${maxIter} 반복).`,
  ).catch(() => undefined);

  const loopBefore = await readProgressSnapshot();
  let prevSnap: ProgressSnapshot = loopBefore;
  let lastMergedSnap: ProgressSnapshot | null = null;
  let iteration = 0;
  let idleRounds = 0;
  let lastExitCode = 0;
  let lastDurationMs = 0;
  let haltKind: "normal" | "error" | "stopped" | "capped" | "stalled" =
    "normal";
  let haltReason = "loop terminated without iterations";
  let aggregateReply = "";
  const kindTimeout = cfg.cli.timeouts["ingest-loop"];
  const progressRef =
    input.progressRef !== undefined
      ? input.progressRef
      : await buildProgressReference();

  while (true) {
    if (await stopFlagExists(sessionPath)) {
      haltKind = "stopped";
      haltReason = "사용자 Stop 요청";
      break;
    }
    if (iteration >= maxIter) {
      haltKind = "capped";
      haltReason = `최대 반복 ${maxIter}회에 도달`;
      break;
    }

    iteration += 1;
    const iterPrompt =
      iteration === 1
        ? initialPrompt
        : buildLoopContinuationPrompt({
            sessionPath,
            iteration,
            progressRef: progressRef ?? (await buildProgressReference()),
            entityRegistryRef: await buildEntityRegistryReference(),
          });

    const banner = `\n\n---\n[loop iter ${iteration}/${maxIter}]\n`;
    if (iteration > 1) {
      onChunk?.(banner);
    }

    const attempt = await runCliWithIngestLoopRetries({
      agent,
      prompt: iterPrompt,
      cfg,
      timeoutMs: kindTimeout ?? undefined,
      signal,
      iteration,
      sessionPath,
      onChunk,
    });
    lastDurationMs += attempt.durationMs;
    if (!attempt.ok) {
      lastExitCode = attempt.lastExitCode;
      haltKind = attempt.kind;
      haltReason = attempt.reason;
      break;
    }

    const result = attempt.result;
    lastExitCode = result.exitCode;
    const iterReply =
      result.stdout.trim() ||
      result.stderr.trim() ||
      `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;
    await appendMessage(sessionPath, "assistant", iterReply, agent).catch(
      () => undefined,
    );
    aggregateReply += (aggregateReply ? banner : "") + iterReply;

    const summary = await readIngestStateSummary();
    const snap = await readProgressSnapshot();
    idleRounds = ingestMadeProgress(prevSnap, snap) ? 0 : idleRounds + 1;

    if (result.exitCode === 0) {
      const incr = await maybeAutoRunGraphify({
        cfg,
        agent,
        sessionPath,
        signal,
        lastExitCode: result.exitCode,
        before: prevSnap,
        after: snap,
        mode: "incremental",
        onChunk,
      });
      if (incr.note) aggregateReply += incr.note;
      if (incr.action === "update") {
        lastMergedSnap = snap;
      }
    }
    prevSnap = snap;

    const decision = decideLoopHalt({
      exitCode: result.exitCode,
      summary,
      mergeDone: snap.mergeDone,
      mergePending: snap.mergePendingParents > 0,
      idleRounds,
      stopRequested: await stopFlagExists(sessionPath),
      iteration,
      maxIter,
    });
    if (decision.halt) {
      haltKind = decision.kind;
      haltReason = decision.reason;
      break;
    }
  }

  if (!input.preserveStopFlag) {
    await clearStopFlag(sessionPath);
  }

  let finalReply =
    aggregateReply || `(/ingest-loop 가 한 번도 실행되지 못했습니다.)`;
  finalReply += `\n\n---\n\n[/ingest-loop ${haltKind}] ${haltReason} · iterations=${iteration}`;

  const loopAfter = await readProgressSnapshot();
  if (haltKind !== "error") {
    const alreadyCoversLatest =
      lastMergedSnap !== null &&
      loopAfter.leavesDone <= lastMergedSnap.leavesDone &&
      loopAfter.mergeDone === lastMergedSnap.mergeDone;
    if (!alreadyCoversLatest) {
      const final = await maybeAutoRunGraphify({
        cfg,
        agent,
        sessionPath,
        signal,
        lastExitCode,
        before: loopBefore,
        after: loopAfter,
        mode: "final",
        onChunk,
      });
      if (final.note) finalReply += final.note;
    } else {
      finalReply += `\n\n---\n\n[auto graph] 루프 중에 full merge가 이미 실행되어 final merge는 생략합니다.`;
    }
  }

  await appendMessage(
    sessionPath,
    "system",
    `🔁 /ingest-loop 종료: ${haltReason} (iterations=${iteration}).`,
  ).catch(() => undefined);

  return {
    finalReply,
    lastExitCode,
    totalDurationMs: lastDurationMs,
    iterations: iteration,
    haltKind,
    haltReason,
    loopBefore,
    loopAfter,
    anyProgress: ingestMadeProgress(loopBefore, loopAfter),
  };
}
