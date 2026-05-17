import fs from "node:fs/promises";
import path from "node:path";
import { runCli, type CliName } from "./cli";
import type { Config } from "./config";
import { buildGraphifyPrompt } from "./graph";
import { PROJECT_ROOT } from "./paths";
import { appendMessage } from "./sessions";
import { errorMessage } from "./api";

export const PROGRESS_DASHBOARD_PATH = "wiki/.progress/ingest/DASHBOARD.md";
export const PROGRESS_STATE_PATH = "wiki/.progress/ingest/.state.json";
export const PROGRESS_STOP_PATH = "wiki/.progress/ingest/.stop";
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
  leavesDone: number;
  subChunksDone: number;
  sourcePagesWritten: number;
  mergeDone: boolean;
  /** Sorted POSIX paths of leaves whose status === "done". */
  doneLeaves: string[];
};

export const EMPTY_SNAPSHOT: ProgressSnapshot = {
  leavesDone: 0,
  subChunksDone: 0,
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
    const snap: ProgressSnapshot = {
      leavesDone: 0,
      subChunksDone: 0,
      sourcePagesWritten: 0,
      mergeDone: parsed.merge_pass?.status === "done",
      doneLeaves,
    };
    if (parsed.leaves && typeof parsed.leaves === "object") {
      for (const [leafPath, value] of Object.entries(parsed.leaves)) {
        const leaf = (value ?? {}) as Record<string, unknown>;
        if (leaf.status === "done") {
          snap.leavesDone += 1;
          doneLeaves.push(leafPath);
        }
        if (Array.isArray(leaf.sub_chunks)) {
          for (const sc of leaf.sub_chunks as Array<Record<string, unknown>>) {
            if (sc && typeof sc === "object" && sc.status === "done") {
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
    return snap;
  } catch {
    return { ...EMPTY_SNAPSHOT, doneLeaves: [] };
  }
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

export async function stopFlagExists(): Promise<boolean> {
  try {
    await fs.access(path.join(PROJECT_ROOT, PROGRESS_STOP_PATH));
    return true;
  } catch {
    return false;
  }
}

export async function clearStopFlag(): Promise<void> {
  try {
    await fs.rm(path.join(PROJECT_ROOT, PROGRESS_STOP_PATH), { force: true });
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
    "Read CLAUDE.md/AGENTS.md in this repository and follow .agents/skills/wiki-ingest/SKILL.md.",
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

export function summarizeIngestState(raw: string): StateSummary | null {
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
    summary.total += 1;
    const leaf = (leafValue ?? {}) as Record<string, unknown>;
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
    action = "update-partial";
    leafPaths = justDoneLeaves;
    progressLabel = `leaf 완료 ${justDoneLeaves.length}건 · partial only`;
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
    await clearStopFlag();
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
    if (await stopFlagExists()) {
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

    let result;
    try {
      result = await runCli(agent, iterPrompt, {
        safeMode: cfg.agent.safeMode,
        timeoutMs: kindTimeout ?? undefined,
        signal,
        killOnAbort: kindTimeout != null,
        onStdout: (chunk) => {
          onChunk?.(chunk);
        },
      });
    } catch (err) {
      const msg = errorMessage(err);
      await appendMessage(
        sessionPath,
        "system",
        `❌ /ingest-loop iter ${iteration} 호출 실패: ${msg}`,
      ).catch(() => undefined);
      haltKind = "error";
      haltReason = `CLI 호출 실패: ${msg}`;
      break;
    }

    lastExitCode = result.exitCode;
    lastDurationMs += result.durationMs;
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
      stopRequested: await stopFlagExists(),
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
    await clearStopFlag();
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
