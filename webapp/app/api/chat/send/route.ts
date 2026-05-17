import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { CLI_NAMES, runCli, type CliName } from "@/lib/cli";
import { buildGraphifyPrompt } from "@/lib/graph";
import { PROJECT_ROOT } from "@/lib/paths";
import {
  appendMessage,
  newSession,
  readSessionTail,
} from "@/lib/sessions";

const Body = z.object({
  sessionPath: z.string().min(1).optional(),
  message: z.string().min(1).max(20000),
  agent: z.enum(["codex", "claude", "gemini", "cline"]).nullable().optional(),
  /**
   * "full" re-injects the entire session history into the prompt. The default
   * "slim" mode injects only the most recent config.chat.contextTurns turns
   * plus a one-line progress dashboard reference, which keeps prompt size
   * bounded so long ingest jobs do not OOM the host CLI.
   */
  context: z.enum(["slim", "full"]).optional(),
  /**
   * Operation hint that selects the timeout bucket in config.cli.timeouts.
   * Defaults to "chat" if omitted; the client sets "ingest"/"query"/"lint"
   * when it detects a slash command so long-running ingest jobs are not
   * SIGTERM-ed at the 5-minute chat cap. "ingest-loop" runs the backend
   * loop that drives wiki-ingest one sub-chunk at a time until the
   * progress state reports no remaining work.
   */
  kind: z
    .enum(["chat", "ingest", "ingest-loop", "query", "lint", "graph"])
    .optional(),
});

const PROGRESS_DASHBOARD_PATH = "wiki/.progress/ingest/DASHBOARD.md";
const PROGRESS_STATE_PATH = "wiki/.progress/ingest/.state.json";
const PROGRESS_STOP_PATH = "wiki/.progress/ingest/.stop";
const WIKI_LOG_REL = "wiki/log.md";

async function buildProgressReference(): Promise<string | null> {
  try {
    const abs = path.join(PROJECT_ROOT, PROGRESS_DASHBOARD_PATH);
    const head = await fs.readFile(abs, "utf8");
    // Excerpt the first ~4 lines (header + progress counts) only; the table
    // body is left on disk for the LLM to open on demand.
    const lines = head.split(/\r?\n/).slice(0, 4).join("\n").trim();
    if (!lines) return null;
    return `Progress reference (${PROGRESS_DASHBOARD_PATH}):\n${lines}`;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

type StateSummary = {
  total: number;
  done: number;
  in_progress: number;
  partial: number;
  pending: number;
  error: number;
  active_leaf: string | null;
  active_subchunk: { id: string; status: string } | null;
};

type ProgressSnapshot = {
  leavesDone: number;
  subChunksDone: number;
  sourcePagesWritten: number;
  mergeDone: boolean;
  /** Sorted POSIX paths of leaves whose status === "done". */
  doneLeaves: string[];
};

const EMPTY_SNAPSHOT: ProgressSnapshot = {
  leavesDone: 0,
  subChunksDone: 0,
  sourcePagesWritten: 0,
  mergeDone: false,
  doneLeaves: [],
};

/**
 * Reads wiki/.progress/ingest/.state.json and condenses it into a single
 * snapshot used to decide whether and how the auto-graphify follow-up should
 * fire. Returns EMPTY_SNAPSHOT on any I/O or parse failure so callers can
 * treat a missing state file as "no progress yet" rather than crashing.
 */
async function readProgressSnapshot(): Promise<ProgressSnapshot> {
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

/**
 * Returns true if any sub-chunk transitioned to "done", a new leaf finished,
 * a new source page was written, or the merge pass completed between `before`
 * and `after`. Used as the "did anything happen?" gate before deciding which
 * graphify action (if any) to fire.
 */
function ingestMadeProgress(
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

/**
 * Returns leaf paths that transitioned from any non-done status to "done"
 * between `before` and `after`. The /ingest-loop driver fires
 * `wiki-graphify update-partial` on these between iterations so partial
 * graphs accumulate incrementally without paying for a merge pass per
 * leaf — the merge runs once at loop end.
 */
function newlyDoneLeaves(
  before: ProgressSnapshot,
  after: ProgressSnapshot,
): string[] {
  const prev = new Set(before.doneLeaves);
  return after.doneLeaves.filter((p) => !prev.has(p));
}

/**
 * Returns the parsed StateSummary of wiki/.progress/ingest/.state.json, or
 * null when the file is missing or unreadable. Used by the /ingest-loop
 * driver to decide whether another iteration is needed.
 */
async function readIngestStateSummary(): Promise<StateSummary | null> {
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

async function stopFlagExists(): Promise<boolean> {
  try {
    await fs.access(path.join(PROJECT_ROOT, PROGRESS_STOP_PATH));
    return true;
  } catch {
    return false;
  }
}

async function clearStopFlag(): Promise<void> {
  try {
    await fs.rm(path.join(PROJECT_ROOT, PROGRESS_STOP_PATH), { force: true });
  } catch {
    // Best-effort cleanup; the next loop run will overwrite or re-check it.
  }
}

type LoopDecision =
  | { halt: false }
  | {
      halt: true;
      kind: "normal" | "error" | "stopped" | "capped";
      reason: string;
    };

/**
 * Pure halt logic for the /ingest-loop driver. Order matters: a stop request
 * or CLI failure takes precedence over normal completion so the user always
 * sees the most specific cause. The "normal" branch requires the skill's
 * merge_pass to have transitioned to "done" — without that, the loop must
 * spawn at least one more iteration so the merge pass can run.
 */
function decideLoopHalt(input: {
  exitCode: number;
  summary: StateSummary | null;
  mergeDone: boolean;
  stopRequested: boolean;
  iteration: number;
  maxIter: number;
}): LoopDecision {
  // Failures take priority over a concurrent Stop request: if a sub-chunk
  // crashed or marked itself "error", the user should see the cause rather
  // than the (less informative) "stopped" reason.
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

/**
 * Prompt used by /ingest-loop iterations after the first. The first call
 * reuses the slim prompt built from the user's message ("/ingest-loop ...")
 * so the wiki-ingest skill sees the user's intent. From the second
 * iteration onward we send a fresh prompt that names the skill directly and
 * tells it to process exactly one sub-chunk and exit, mirroring what
 * happens when the user types `/ingest` again.
 */
function buildLoopContinuationPrompt(input: {
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

function summarizeIngestState(raw: string): StateSummary | null {
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

function formatStateSummary(s: StateSummary): string {
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

const LOG_HEADING_RE =
  /^##\s+\[([^\]]+)\]\s+(ingest|query|lint|graph)\s*\|\s*(.+?)\s*$/;

type ProgressEvent =
  | {
      type: "progress";
      phase: "state";
      summary: string;
      active: string | null;
    }
  | {
      type: "progress";
      phase: "log";
      ts: string;
      op: string;
      detail: string;
    };

/**
 * Polling watcher that exposes ingest sub-chunk progress to the chat stream.
 * Skills persist state to wiki/.progress/ingest/.state.json after every
 * sub-chunk and append a heading to wiki/log.md, so this watcher reads both
 * during runCli rather than relying on the CLI's stdout flushing behavior
 * (claude -p / codex exec frequently buffer until exit).
 *
 * Returns a disposer that stops the timer. The watcher swallows all I/O
 * errors — it must never break the main CLI stream.
 */
function startProgressWatcher(
  emit: (event: ProgressEvent) => void,
): () => void {
  const stateAbs = path.join(PROJECT_ROOT, PROGRESS_STATE_PATH);
  const logAbs = path.join(PROJECT_ROOT, WIKI_LOG_REL);
  let stopped = false;
  let lastStateMtime = 0;
  let lastSummary = "";
  let baselineLogSize: number | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const st = await fs.stat(stateAbs);
      if (st.mtimeMs !== lastStateMtime) {
        lastStateMtime = st.mtimeMs;
        const raw = await fs.readFile(stateAbs, "utf8");
        const summary = summarizeIngestState(raw);
        if (summary) {
          const line = formatStateSummary(summary);
          if (line !== lastSummary) {
            lastSummary = line;
            emit({
              type: "progress",
              phase: "state",
              summary: line,
              active: summary.active_leaf,
            });
          }
        }
      }
    } catch {
      // ENOENT or partial JSON — try again on the next tick.
    }
    try {
      const st = await fs.stat(logAbs);
      if (baselineLogSize == null) {
        baselineLogSize = st.size;
      } else if (st.size > baselineLogSize) {
        const length = st.size - baselineLogSize;
        const fh = await fs.open(logAbs, "r");
        try {
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, baselineLogSize);
          const text = buf.toString("utf8");
          const lines = text.split("\n");
          // Always drop the last element: split returns "" for a trailing
          // newline (already consumed) or the partial line we will re-read
          // on the next tick.
          const completed = lines.slice(0, -1);
          let consumedBytes = 0;
          for (const line of completed) {
            consumedBytes += Buffer.byteLength(line, "utf8") + 1;
            const m = LOG_HEADING_RE.exec(line);
            if (m) {
              emit({
                type: "progress",
                phase: "log",
                ts: m[1],
                op: m[2],
                detail: m[3],
              });
            }
          }
          baselineLogSize += consumedBytes;
        } finally {
          await fh.close();
        }
      } else if (st.size < baselineLogSize) {
        // Log was truncated/rotated; reset the baseline so we do not negative-read.
        baselineLogSize = st.size;
      }
    } catch {
      // log.md may not exist yet — that is fine.
    }
  };

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, 1500);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

const encoder = new TextEncoder();
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007|(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

function shorten(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function displayChunk(chunk: string): string {
  const text = chunk
    .replace(ANSI_RE, "")
    .replace(/\r[^\n]*/g, "")
    .replace(/\u0000/g, "");
  return text.trim().length > 0 ? text : "";
}

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  const cfg = await loadConfig();
  const agent: CliName | null =
    parsed.data.agent === undefined
      ? (cfg.agent.default as CliName | null)
      : (parsed.data.agent as CliName | null);
  if (!agent) {
    return jsonError(
      "기본 코딩 에이전트가 지정되지 않았습니다. Settings에서 골라주세요.",
      400,
    );
  }
  if (!CLI_NAMES.includes(agent)) {
    return jsonError(`unknown agent: ${agent}`, 400);
  }

  // 세션이 없으면 첫 메시지를 기준으로 새 세션 생성.
  let sessionPath = parsed.data.sessionPath;
  if (!sessionPath) {
    const subject = shorten(parsed.data.message, 60) || "untitled";
    const ref = await newSession({ subject, agent });
    sessionPath = ref.path;
  }

  // Append the user message to the session.
  try {
    await appendMessage(sessionPath, "user", parsed.data.message);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }

  // Slim prompt builder — keeps prompt size from growing linearly with turn
  // count on stateless CLI calls by injecting only the most recent
  // chat.contextTurns turns. Joining the whole session happens only when the
  // caller explicitly asks for context=full.
  const wantFull = parsed.data.context === "full";
  const contextTurns = Math.max(1, cfg.chat.contextTurns);
  let promptBody: string;
  let totalMessages = 0;
  let injectedMessages = 0;
  try {
    const tail = await readSessionTail(
      sessionPath,
      wantFull ? Number.MAX_SAFE_INTEGER : contextTurns,
    );
    totalMessages = tail.total;
    injectedMessages = tail.messages.length;
    const lines = tail.messages.map((m) => {
      const tag =
        m.role === "user"
          ? "User"
          : m.role === "assistant"
            ? `Assistant${m.agent ? ` (${m.agent})` : ""}`
            : "System";
      return `${tag} [${m.ts}]:\n${m.content}`;
    });
    promptBody = lines.join("\n\n----\n\n");
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }

  const elidedNote =
    !wantFull && totalMessages > injectedMessages
      ? `(Showing the last ${injectedMessages} of ${totalMessages} messages. Older turns live in sessions/${sessionPath}; re-read that file only if you truly need them.)`
      : null;

  const progressRef = cfg.chat.includeProgressDashboard
    ? await buildProgressReference()
    : null;

  const promptLines: string[] = [
    "You are operating an LLM Wiki repository.",
    "Read CLAUDE.md/AGENTS.md in this repository and follow the .agents/skills/ that match the user's intent.",
    `Active session log: sessions/${sessionPath}`,
  ];
  if (progressRef) promptLines.push(progressRef);
  if (elidedNote) promptLines.push(elidedNote);
  promptLines.push(
    "Below is the running conversation. Continue it by writing the assistant's next reply only — no preamble, no markdown frontmatter.",
    "",
    "===== CONVERSATION =====",
    promptBody,
    "",
    "Respond now as the assistant.",
  );
  const prompt = promptLines.join("\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        if (closed || req.signal.aborted) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };

      send({ type: "start", sessionPath });

      const kind = parsed.data.kind ?? "chat";
      const kindTimeout = cfg.cli.timeouts[kind];
      const stopWatcher = startProgressWatcher((event) => send(event));

      /**
       * Auto-graphify dispatcher. Decides between three outcomes given a
       * before/after snapshot diff and the requested mode:
       *
       * - "incremental" mode (fired after each /ingest call or each iter
       *   of /ingest-loop): if merge_pass just completed, do a full
       *   `wiki-graphify update`. Else if leaf(s) just turned done, do a
       *   cheap `wiki-graphify update-partial` for those leaves only —
       *   skips the merge pass so the loop pays it just once at the end.
       *   Otherwise (only sub-chunk progress, no leaf yet) do nothing —
       *   wait for the next leaf to land.
       *
       * - "final" mode (fired once at /ingest-loop end on non-error halt):
       *   if anything progressed in the entire loop, always do a full
       *   `wiki-graphify update` so the per-leaf partials accumulated
       *   during the loop get merged into one connected graph.json.
       *
       * Returns the note appended to the assistant reply (may be empty)
       * and streams the note + graphify output back to the client as it
       * goes.
       */
      const maybeAutoRunGraphify = async (
        lastExitCode: number,
        before: ProgressSnapshot,
        after: ProgressSnapshot,
        opts: { mode: "incremental" | "final" },
      ): Promise<{ note: string; action: "update" | "update-partial" | null }> => {
        const noop = { note: "", action: null as null };
        if (lastExitCode !== 0) return noop;
        if (!cfg.graph.autoUpdateOnIngest) return noop;
        if (!ingestMadeProgress(before, after)) return noop;

        const mergeJustDone = after.mergeDone && !before.mergeDone;
        const justDoneLeaves = newlyDoneLeaves(before, after);

        let action: "update" | "update-partial";
        let leafPaths: string[] | undefined;
        let progressLabel: string;

        if (opts.mode === "final") {
          action = "update";
          progressLabel = mergeJustDone
            ? "merge pass 완료 + final merge"
            : `leaves ${after.leavesDone}/${before.leavesDone + (after.leavesDone - before.leavesDone)} · final merge`;
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
          sessionPath,
          "system",
          `ingest 진행 감지 (${progressLabel}); auto-running ${commandLabel}`,
        );
        const graphPrompt = buildGraphifyPrompt(action, sessionPath, {
          leafPaths,
        });
        const note = `\n\n---\n\n[auto graph · ${progressLabel}] \`${commandLabel}\`를 별도 CLI 호출로 실행합니다.\n`;
        send({ type: "chunk", stream: "stdout", text: note });

        const graphTimeout = cfg.cli.timeouts.graph;
        try {
          const graphResult = await runCli(agent, graphPrompt, {
            safeMode: cfg.agent.safeMode,
            timeoutMs: graphTimeout ?? undefined,
            signal: req.signal,
            killOnAbort: graphTimeout != null,
            onStdout: (chunk) => {
              const text = displayChunk(chunk);
              if (text) {
                send({ type: "chunk", stream: "stdout", text });
              }
            },
          });
          const graphReply =
            (graphResult.stdout.trim() || graphResult.stderr.trim()) ||
            `(그래프 업데이트가 빈 응답을 반환했습니다. exitCode=${graphResult.exitCode})`;
          return {
            note: `${note}\n\n---\n\n[auto graph result · ${commandLabel}]\n${graphReply}`,
            action,
          };
        } catch (err) {
          const graphError = errorMessage(err);
          await appendMessage(
            sessionPath,
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
      };

      try {
        if (kind === "ingest-loop") {
          // -------- /ingest-loop driver --------
          // Repeatedly spawn the host CLI to process one sub-chunk at a time
          // (per the wiki-ingest skill's `unitPerCall: "one_subchunk"`
          // contract) until decideLoopHalt() reports the run is complete or
          // must stop. The skill persists progress to
          // wiki/.progress/ingest/.state.json after every sub-chunk, so the
          // loop only needs to inspect that file between iterations — no
          // sentinel parsing of stdout required.
          await clearStopFlag();
          const maxIter = cfg.cli.ingestLoop.maxIterations;
          await appendMessage(
            sessionPath,
            "system",
            `🔁 /ingest-loop 시작 (최대 ${maxIter} 반복).`,
          ).catch(() => undefined);

          // Snapshot the ingest progress before the first iteration so we can
          // tell at loop end whether ANY work landed during this /ingest-loop
          // call. The graphify follow-up below uses this baseline so partial
          // runs (capped, user-stopped) still get a graph refresh as long as
          // at least one sub-chunk completed. `prevSnap` is a rolling cursor
          // used for the mid-loop incremental graphify trigger: after each
          // iteration we diff prevSnap vs the fresh snapshot and fire
          // `wiki-graphify update-partial` on any leaves that just landed.
          const loopBefore = await readProgressSnapshot();
          let prevSnap: ProgressSnapshot = loopBefore;
          // If a mid-loop iteration triggered a full `update` (because
          // wiki-ingest's merge_pass just completed inside that iter), we
          // remember the snapshot at that point. The post-loop final fire
          // then skips itself unless additional leaves have completed since,
          // avoiding a duplicate full merge back-to-back.
          let lastMergedSnap: ProgressSnapshot | null = null;
          let iteration = 0;
          let lastExitCode = 0;
          let lastDurationMs = 0;
          let haltKind: "normal" | "error" | "stopped" | "capped" = "normal";
          let haltReason = "loop terminated without iterations";
          let aggregateReply = "";

          while (true) {
            // Check user-requested stop before spending another spawn.
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
                ? prompt
                : buildLoopContinuationPrompt({
                    sessionPath,
                    iteration,
                    progressRef: progressRef
                      ? progressRef
                      : await buildProgressReference(),
                  });

            const banner = `\n\n---\n[loop iter ${iteration}/${maxIter}]\n`;
            if (iteration > 1) {
              send({ type: "chunk", stream: "stdout", text: banner });
            }

            let result;
            try {
              result = await runCli(agent, iterPrompt, {
                safeMode: cfg.agent.safeMode,
                timeoutMs: kindTimeout ?? undefined,
                signal: req.signal,
                killOnAbort: kindTimeout != null,
                onStdout: (chunk) => {
                  const text = displayChunk(chunk);
                  if (text) {
                    send({ type: "chunk", stream: "stdout", text });
                  }
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
              (result.stdout.trim() || result.stderr.trim()) ||
              `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;
            await appendMessage(
              sessionPath,
              "assistant",
              iterReply,
              agent,
            ).catch(() => undefined);
            aggregateReply +=
              (aggregateReply ? banner : "") + iterReply;

            const summary = await readIngestStateSummary();
            const snap = await readProgressSnapshot();

            // Mid-loop incremental graphify: if a leaf just turned `done`
            // (or merge_pass just completed inside this iter, which is rare
            // but possible), fire `update-partial` for those leaves now so
            // the parts/ directory grows in lockstep with ingest. The merge
            // pass itself is normally deferred to the post-loop "final"
            // call below so we only pay for clustering once per /ingest-loop
            // run; the post-loop call skips itself if this branch already
            // did a full `update` (tracked via lastMergedSnap).
            if (result.exitCode === 0) {
              const incr = await maybeAutoRunGraphify(
                result.exitCode,
                prevSnap,
                snap,
                { mode: "incremental" },
              );
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

          await clearStopFlag();

          let finalReply =
            aggregateReply ||
            `(/ingest-loop 가 한 번도 실행되지 못했습니다.)`;
          finalReply += `\n\n---\n\n[/ingest-loop ${haltKind}] ${haltReason} · iterations=${iteration}`;

          // Final merge: one full `wiki-graphify update` at loop end
          // produces the connected graph.json + GRAPH_REPORT.md from the
          // partials accumulated during the loop. Skipped on "error" halt
          // (partial state suspect) and skipped when mid-loop already did a
          // full update and no new leaves have completed since then.
          if (haltKind !== "error") {
            const loopAfter = await readProgressSnapshot();
            const alreadyCoversLatest =
              lastMergedSnap !== null &&
              loopAfter.leavesDone <= lastMergedSnap.leavesDone &&
              loopAfter.mergeDone === lastMergedSnap.mergeDone;
            if (!alreadyCoversLatest) {
              const final = await maybeAutoRunGraphify(
                lastExitCode,
                loopBefore,
                loopAfter,
                { mode: "final" },
              );
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

          const finalAssistant = await appendMessage(
            sessionPath,
            "assistant",
            finalReply,
            agent,
          );
          send({
            type: "done",
            sessionPath,
            assistant: finalAssistant,
            exitCode: lastExitCode,
            durationMs: lastDurationMs,
          });
        } else {
          // -------- Single CLI call (chat, ingest, query, lint, graph) --------
          // For ingest, snapshot progress beforehand so the post-call
          // graphify hook can detect whether this invocation actually
          // advanced any sub-chunk. (The state-file diff is needed because
          // wiki-ingest processes exactly one sub-chunk per invocation —
          // looking only at "merge_pass.status === done" would suppress
          // graph updates for every intermediate ingest call.)
          const ingestBefore =
            kind === "ingest" ? await readProgressSnapshot() : null;
          const result = await runCli(agent, prompt, {
            safeMode: cfg.agent.safeMode,
            // null in config means "no timeout for this operation kind" —
            // pass undefined so runCli does not register a setTimeout that
            // would SIGTERM the child mid-summary.
            timeoutMs: kindTimeout ?? undefined,
            signal: req.signal,
            // When the operation is configured for infinite runtime (ingest),
            // detach the HTTP request lifecycle from the CLI. An idle browser
            // tab, WSL2/proxy idle disconnect, or Node HTTP idle timeout would
            // otherwise fire req.signal.abort mid-chunk and re-introduce the
            // SIGTERM we just disabled at the timer level. The CLI keeps
            // running, persists progress to wiki/.progress/ingest/, and writes
            // the final assistant message to the session file even if no client
            // is listening anymore.
            killOnAbort: kindTimeout != null,
            onStdout: (chunk) => {
              const text = displayChunk(chunk);
              if (text) {
                send({ type: "chunk", stream: "stdout", text });
              }
            },
          });
          let reply =
            (result.stdout.trim() || result.stderr.trim()) ||
            `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;

          if (kind === "ingest" && ingestBefore) {
            const ingestAfter = await readProgressSnapshot();
            // Single /ingest uses "incremental" mode: fires `update-partial`
            // on leaf completion (cheap, no merge), or full `update` only
            // when wiki-ingest's own merge pass just completed. Calls that
            // only advanced a sub-chunk produce no graph fire — the next
            // /ingest that closes out the leaf will pick it up.
            const incr = await maybeAutoRunGraphify(
              result.exitCode,
              ingestBefore,
              ingestAfter,
              { mode: "incremental" },
            );
            if (incr.note) reply += incr.note;
          }

          const assistantMsg = await appendMessage(
            sessionPath,
            "assistant",
            reply,
            agent,
          );
          send({
            type: "done",
            sessionPath,
            assistant: assistantMsg,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          });
        }
      } catch (err) {
        const msg = errorMessage(err);
        await appendMessage(
          sessionPath,
          "system",
          `❌ CLI 호출 실패: ${msg}`,
        ).catch(() => undefined);
        send({ type: "error", sessionPath, error: msg });
      } finally {
        stopWatcher();
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
