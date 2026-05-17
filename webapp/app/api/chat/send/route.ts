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

async function ingestMergePassDone(): Promise<boolean> {
  try {
    const raw = await fs.readFile(
      path.join(PROJECT_ROOT, PROGRESS_STATE_PATH),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      merge_pass?: { status?: unknown };
    };
    return parsed.merge_pass?.status === "done";
  } catch {
    return false;
  }
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
       * After an ingest (or the final iteration of an ingest-loop) finishes
       * cleanly and the merge pass is "done", trigger a follow-up
       * `wiki-graphify update` via a fresh CLI invocation. Returns the note
       * to append to the assistant reply text (may be empty). Streams the
       * note and graph output back to the client as it goes.
       */
      const maybeAutoRunGraphify = async (
        lastExitCode: number,
      ): Promise<string> => {
        if (lastExitCode !== 0) return "";
        if (!cfg.graph.autoUpdateOnIngest) return "";
        if (!(await ingestMergePassDone())) return "";

        const graphCommand = "wiki-graphify update";
        await appendMessage(
          sessionPath,
          "system",
          `ingest merge pass complete; auto-running ${graphCommand}`,
        );
        const graphPrompt = buildGraphifyPrompt("update", sessionPath);
        const note =
          "\n\n---\n\n[auto graph] ingest merge pass가 완료되어 `wiki-graphify update`를 별도 CLI 호출로 실행합니다.\n";
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
          return `${note}\n\n---\n\n[auto graph result]\n${graphReply}`;
        } catch (err) {
          const graphError = errorMessage(err);
          await appendMessage(
            sessionPath,
            "system",
            `❌ 자동 그래프 업데이트 실패: ${graphError}`,
          ).catch(() => undefined);
          return (
            `${note}\n\n---\n\n[auto graph blocker]\n` +
            `ingest는 완료됐지만 자동 그래프 업데이트 호출이 실패했습니다: ${graphError}`
          );
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
            const mergeDone = await ingestMergePassDone();
            const decision = decideLoopHalt({
              exitCode: result.exitCode,
              summary,
              mergeDone,
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

          if (haltKind === "normal") {
            const graphNote = await maybeAutoRunGraphify(lastExitCode);
            if (graphNote) finalReply += graphNote;
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

          if (kind === "ingest") {
            const graphNote = await maybeAutoRunGraphify(result.exitCode);
            if (graphNote) reply += graphNote;
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
