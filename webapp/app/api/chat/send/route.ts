import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { CLI_NAMES, runCli, type CliName } from "@/lib/cli";
import { PROJECT_ROOT } from "@/lib/paths";
import {
  appendMessage,
  newSession,
  readSessionTail,
} from "@/lib/sessions";
import {
  PROGRESS_STATE_PATH,
  WIKI_LOG_REL,
  buildProgressReference,
  formatStateSummary,
  maybeAutoRunGraphify,
  readProgressSnapshot,
  runIngestLoop,
  summarizeIngestState,
} from "@/lib/ingest-loop";

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

      const emitChunk = (text: string) => {
        const rendered = displayChunk(text);
        if (rendered) {
          send({ type: "chunk", stream: "stdout", text: rendered });
        }
      };

      try {
        if (kind === "ingest-loop") {
          // -------- /ingest-loop driver --------
          // Delegates to the shared runIngestLoop helper so the same engine
          // powers both manual /ingest-loop calls and the AutoIngestManager
          // background trigger. The HTTP route only adapts streaming and
          // appends the final assistant message.
          const result = await runIngestLoop({
            cfg,
            agent,
            sessionPath: sessionPath as string,
            initialPrompt: prompt,
            progressRef,
            signal: req.signal,
            onChunk: emitChunk,
          });
          const finalAssistant = await appendMessage(
            sessionPath as string,
            "assistant",
            result.finalReply,
            agent,
          );
          send({
            type: "done",
            sessionPath,
            assistant: finalAssistant,
            exitCode: result.lastExitCode,
            durationMs: result.totalDurationMs,
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
            onStdout: (chunk) => emitChunk(chunk),
          });
          let reply =
            result.stdout.trim() ||
            result.stderr.trim() ||
            `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;

          if (kind === "ingest" && ingestBefore) {
            const ingestAfter = await readProgressSnapshot();
            const incr = await maybeAutoRunGraphify({
              cfg,
              agent,
              sessionPath: sessionPath as string,
              signal: req.signal,
              lastExitCode: result.exitCode,
              before: ingestBefore,
              after: ingestAfter,
              mode: "incremental",
              onChunk: emitChunk,
            });
            if (incr.note) reply += incr.note;
          }

          const assistantMsg = await appendMessage(
            sessionPath as string,
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
          sessionPath as string,
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
