import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { createChatJob, createChatJobStream } from "@/lib/chat-jobs";
import type { ChatSendEvent } from "@/lib/chat-events";
import { displayChunk } from "@/lib/cli-output";
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
  summarizeIngestState,
} from "@/lib/ingest-loop";
import {
  isOrchestratedKind,
  runMultiAgentOperation,
} from "@/lib/multi-agent";

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
   * progress state reports no remaining work. Code-heavy material is handled
   * by the normal ingest flow through project-local Code Wiki rules.
   */
  kind: z
    .enum([
      "chat",
      "ingest",
      "ingest-loop",
      "preprocess",
      "query",
      "lint",
      "graph",
    ])
    .optional(),
});

const LOG_HEADING_RE =
  /^##\s+\[([^\]]+)\]\s+(ingest|preprocess|query|lint|graph)\s*\|\s*(.+?)\s*$/;

type ProgressEvent = Extract<ChatSendEvent, { type: "progress" }>;

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
  options: { sessionPath?: string } = {},
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
        const summary = summarizeIngestState(raw, {
          sessionPath: options.sessionPath,
        });
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
    if (!options.sessionPath) {
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

function shorten(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function formatCancelledReply(input: {
  kind: string;
  exitCode: number;
  durationMs: number;
}): string {
  return [
    "⛔ 사용자 Stop 요청으로 중단됨.",
    "",
    `- kind: ${input.kind}`,
    `- exitCode: ${input.exitCode}`,
    `- durationMs: ${input.durationMs}`,
    "- result: 실행 중이던 CLI 프로세스에 SIGTERM을 보냈고, 추가 에이전트 응답 생성은 건너뛰었습니다.",
  ].join("\n");
}

function querySingleAgentPolicy(): string {
  return [
    "This request is a single-agent /query operation.",
    "Follow the LLM Wiki query pattern: answer from the persistent compiled wiki, not by treating raw documents or search snippets as one-off RAG chunks.",
    "Use wiki-query: infer the user's intent, plan the investigation, read wiki/index.md first, select candidate pages, use available read-only retrieval/context tools such as wiki-search-qmd or wiki-graphify when useful, and read the evidence before answering.",
    "Do not merely return search hits, excerpts, candidate pages, or tool output. Synthesize the evidence into an answer tailored to the user's actual question, with a clear conclusion first when possible.",
    "If the question is a code/API/troubleshooting question, prioritize wiki/code pages and targeted read-only raw/ searches only when the Code Wiki is insufficient.",
    "If the question requires current external facts or a tool outside wiki-query, first check what tools are available in this CLI context and use only read-only tools. Clearly separate external facts from wiki-grounded facts and link or cite only sources that are actually necessary for the answer.",
    "Do not append a sources/references/candidate-pages section just because you inspected wiki/index.md or retrieval helpers. Mention or link wiki pages only when the answer materially relies on them and the link helps the user.",
    "Treat wiki/index.md, wiki/log.md, sessions, progress files, and candidate-page lists as internal navigation unless the user specifically asks about those files.",
    "Do not modify raw/. Only create or edit wiki/answers, wiki/index.md, or wiki/log.md when the user explicitly requested --save or clearly consents to saving the answer. If the answer contains a reusable synthesis, end with a concise save suggestion instead of writing files without consent.",
    "Because the user explicitly invoked /query, Korean Markdown is a good default for structured answers. For simple questions, answer briefly without unnecessary sections. Keep any plan summary concise and user-facing; do not expose private chain-of-thought.",
  ].join("\n");
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
  const kind = parsed.data.kind ?? "chat";

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
    "Read CLAUDE.md/AGENTS.md in this repository and follow matching skills. Skill lookup priority: project .agents/skills first, then ~/.agents/skills, then host-specific global skill directories such as ~/.codex/skills or ~/.claude/skills.",
    `Active session log: sessions/${sessionPath}`,
    "Response hygiene: do not expose internal navigation files, candidate document lists, or source/reference sections unless they are genuinely needed. Link wiki or external sources only when the answer actually relies on them and the link helps the user.",
  ];
  if (progressRef) promptLines.push(progressRef);
  if (kind === "query") promptLines.push(querySingleAgentPolicy());
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

  const job = createChatJob({ sessionPath, kind, agent });
  const send = (event: ChatSendEvent) => job.append(event);

  void (async () => {
    send({ type: "start", sessionPath });

    const kindTimeout = cfg.cli.timeouts[kind];
    const stopWatcher =
      kind === "ingest" || kind === "ingest-loop"
        ? startProgressWatcher((event) => send(event), { sessionPath })
        : () => undefined;

    const emitChunk = (text: string) => {
      const rendered = displayChunk(text);
      if (rendered) {
        send({ type: "chunk", stream: "stdout", text: rendered });
      }
    };

    try {
      if (isOrchestratedKind(kind)) {
        // -------- Multi-agent wiki operations --------
        // /ingest, /ingest-loop, and /lint are dispatched through a small
        // coordinator that starts named workers up to the configured
        // concurrency limit and then asks a manager agent to consolidate the
        // result. /query intentionally stays on the single-CLI path below for
        // lower latency and more consistent evidence handling. The job
        // AbortSignal is shared by all live worker CLIs so a Stop request
        // interrupts them immediately.
        const result = await runMultiAgentOperation({
          cfg,
          kind,
          agent,
          sessionPath,
          prompt,
          message: parsed.data.message,
          progressRef,
          signal: job.abort.signal,
          onChunk: emitChunk,
        });
        const finalReply = job.cancelled
          ? formatCancelledReply({
              kind,
              exitCode: result.lastExitCode,
              durationMs: result.totalDurationMs,
            })
          : result.finalReply;
        const finalAssistant = await appendMessage(
          sessionPath,
          "assistant",
          finalReply,
          result.assistantAgent,
        );
        send({
          type: "done",
          sessionPath,
          assistant: finalAssistant,
          exitCode: result.lastExitCode,
          durationMs: result.totalDurationMs,
        });
      } else {
        // -------- Single CLI call (chat, query, preprocess, graph) --------
        const result = await runCli(agent, prompt, {
          safeMode: cfg.agent.safeMode,
          // null in config means "no timeout for this operation kind".
          timeoutMs: kindTimeout ?? undefined,
          // Pair the child process to the job's AbortController so an HTTP
          // cancel request can SIGTERM it. killOnAbort=true (default) wires
          // the SIGTERM through. Independent of req.signal — closing the
          // streaming response must not kill the CLI.
          signal: job.abort.signal,
          onStdout: (chunk) => emitChunk(chunk),
        });
        let reply =
          result.stdout.trim() ||
          result.stderr.trim() ||
          `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;
        // When the user stopped the run, save only the stopped-result report
        // instead of preserving a partial CLI tail as an assistant answer.
        if (job.cancelled) {
          reply = formatCancelledReply({
            kind,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          });
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
    }
  })();

  const stream = createChatJobStream(job, { signal: req.signal });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
