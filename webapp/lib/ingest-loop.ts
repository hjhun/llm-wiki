import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { runCli, type CliName, type RunResult } from "./cli";
import type { Config } from "./config";
import { buildGraphifyPrompt } from "./graph";
import { PROJECT_ROOT } from "./paths";
import { appendMessage } from "./sessions";
import { errorMessage } from "./api";

export const PROGRESS_DASHBOARD_PATH = "wiki/.progress/ingest/DASHBOARD.md";
export const PROGRESS_STATE_PATH = "wiki/.progress/ingest/.state.json";
export const PROGRESS_STOP_PATH = "wiki/.progress/ingest/.stop";
export const PROGRESS_STOP_DIR = "wiki/.progress/ingest/stops";
export const PROGRESS_LOCK_PATH = "wiki/.progress/ingest/.lock";
export const WIKI_LOG_REL = "wiki/log.md";

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

export async function readProgressSnapshot(): Promise<ProgressSnapshot> {
  try {
    const raw = await fs.readFile(
      path.join(PROJECT_ROOT, PROGRESS_STATE_PATH),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      merge_pass?: { status?: unknown };
      leaves?: Record<string, unknown>;
    };
    const doneLeaves: string[] = [];
    const filePaths = new Set<string>();
    const snap: ProgressSnapshot = {
      leavesTotal: 0,
      leavesDone: 0,
      subChunksTotal: 0,
      subChunksDone: 0,
      filesTotal: 0,
      bytesTotal: 0,
      sourcePagesWritten: 0,
      mergeDone: parsed.merge_pass?.status === "done",
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
    (after.mergeDone && !before.mergeDone)
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
      kind: "normal" | "error" | "stopped" | "capped";
      reason: string;
    };

export function decideLoopHalt(input: {
  exitCode: number;
  summary: StateSummary | null;
  mergeDone: boolean;
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
  if (
    input.summary &&
    input.summary.pending === 0 &&
    input.summary.in_progress === 0 &&
    input.summary.partial === 0 &&
    input.mergeDone
  ) {
    return {
      halt: true,
      kind: "normal",
      reason: `모든 leaf 완료 + merge pass done (${input.summary.done}/${input.summary.total})`,
    };
  }
  return { halt: false };
}

export function buildLoopContinuationPrompt(input: {
  sessionPath: string;
  iteration: number;
  progressRef: string | null;
}): string {
  const lines: string[] = [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md in this repository and follow .agents/skills/wiki-ingest/SKILL.md. If additional skills are needed, project .agents/skills takes priority, then ~/.agents/skills, then host-specific global skill directories such as ~/.codex/skills or ~/.claude/skills.",
    `Active session log: sessions/${input.sessionPath}`,
  ];
  if (input.progressRef) lines.push(input.progressRef);
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
    summary.total += 1;
    const status = typeof leaf.status === "string" ? leaf.status : "pending";
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

export type GraphifyAction = "update" | "update-partial";

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
};

function graphPartialDecision(
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

export async function maybeAutoRunGraphify(
  input: MaybeAutoRunGraphifyInput,
): Promise<MaybeAutoRunGraphifyResult> {
  const noop: MaybeAutoRunGraphifyResult = { note: "", action: null };
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
    const partialDecision = graphPartialDecision(input.cfg, input.after);
    if (!partialDecision.enabled) {
      return {
        note:
          `\n\n---\n\n[auto graph · partial skipped] ` +
          `${partialDecision.reason}; final \`wiki-graphify update\` will handle changed partials.\n`,
        action: null,
      };
    }
    action = "update-partial";
    leafPaths = justDoneLeaves;
    progressLabel = `leaf 완료 ${justDoneLeaves.length}건 · partial only · ${partialDecision.reason}`;
  } else {
    return noop;
  }

  const commandLabel =
    action === "update-partial" && leafPaths && leafPaths.length > 0
      ? `wiki-graphify update-partial (${leafPaths.join(", ")})`
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
      killOnAbort: graphTimeout != null,
      onStdout: (chunk) => {
        input.onChunk?.(chunk);
      },
    });
    const graphReply =
      graphResult.stdout.trim() ||
      graphResult.stderr.trim() ||
      `(그래프 업데이트가 빈 응답을 반환했습니다. exitCode=${graphResult.exitCode})`;
    return {
      note: `${note}\n\n---\n\n[auto graph result · ${commandLabel}]\n${graphReply}`,
      action,
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
      action,
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
  haltKind: "normal" | "error" | "stopped" | "capped";
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
  let lastExitCode = 0;
  let lastDurationMs = 0;
  let haltKind: "normal" | "error" | "stopped" | "capped" = "normal";
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
      if (incr.action === "update") lastMergedSnap = snap;
    }
    prevSnap = snap;

    const decision = decideLoopHalt({
      exitCode: result.exitCode,
      summary,
      mergeDone: snap.mergeDone,
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
