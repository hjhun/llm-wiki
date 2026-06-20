import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { createChatJob, createChatJobStream } from "@/lib/chat-jobs";
import type { ChatSendEvent } from "@/lib/chat-events";
import { cleanCliText, displayChunk } from "@/lib/cli-output";
import { loadConfig } from "@/lib/config";
import { CLI_NAMES, runCli, type CliName } from "@/lib/cli";
import { resolveAgentForKind } from "@/lib/agent-roles";
import {
  appendMessage,
  buildSessionPromptContext,
  newSession,
} from "@/lib/sessions";
import {
  buildProgressReference,
  normalizeRawScope,
  runIngestLoop,
} from "@/lib/ingest-loop";
import {
  snapshotAnswerMtimes,
  sweepAnswersForSecrets,
} from "@/lib/answer-secret-sweep";
import {
  CHAT_KINDS,
  formatCancelledReply,
  formatTimedOutReply,
  initialOperationSummary,
  normalizeKind,
  operationTargetFromMessage,
  querySingleAgentPolicy,
  shorten,
  type ChatKindInput,
} from "@/lib/chat/send-helpers";
import { startProgressWatcher } from "@/lib/chat/progress-watcher";

const Body = z.object({
  sessionPath: z.string().min(1).optional(),
  message: z.string().min(1).max(20000),
  agent: z.enum(["codex", "claude", "agy", "cline"]).nullable().optional(),
  /**
   * "full" re-injects the entire session history into the prompt. The default
   * "slim" mode injects the full session while it fits under
   * config.chat.contextMaxBytes, then compacts older turns into an `이전대화`
   * block and keeps the newest config.chat.contextTurns turns verbatim.
   */
  context: z.enum(["slim", "full"]).optional(),
  /**
   * Operation hint that selects the timeout bucket in config.cli.timeouts.
   * The server still normalizes it from the message so ordinary questions
   * without `/query` follow the wiki-query flow, matching the user guide.
   * "ingest-loop" runs the backend loop that drives wiki-ingest one
   * sub-chunk at a time until the progress state reports no remaining work.
   * Code-heavy material is handled by the normal ingest flow through
   * project-local Code Wiki rules.
   */
  kind: z.enum(CHAT_KINDS).optional(),
});

// Parse an optional `raw/...` scope out of a `/ingest` or `/ingest-loop`
// message so a targeted run only walks that subtree. Mirrors the parser the
// retired multi-agent coordinator used.
function rawScopeFromMessage(message?: string | null): string | null {
  if (!message) return null;
  const m = /^\/(?:ingest-loop|ingest)(?:\s+([\s\S]+?))?\s*$/.exec(
    message.trim(),
  );
  return normalizeRawScope(m?.[1]?.trim());
}

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  const cfg = await loadConfig();
  const kind = normalizeKind(parsed.data.message, parsed.data.kind);
  // When the client does not pin an explicit agent, pick the CLI by operation
  // role: maintenance (ingest/ingest-loop/lint/preprocess/graph) vs query each
  // may override agent.default via config.agent.roles. An explicit client agent
  // always wins.
  const agent: CliName | null =
    parsed.data.agent === undefined
      ? resolveAgentForKind(cfg, kind)
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

  // Slim prompt builder — preserves full session continuity until the chat
  // context crosses the configured byte cap. After that it compacts older
  // turns into an `이전대화` block and keeps recent turns verbatim.
  const wantFull = parsed.data.context === "full";
  const contextTurns = Math.max(1, cfg.chat.contextTurns);
  const contextMaxBytes = Math.max(16 * 1024, cfg.chat.contextMaxBytes);
  let promptBody: string;
  let totalMessages = 0;
  let injectedMessages = 0;
  let compactedMessages = 0;
  let fullContextBytes = 0;
  let promptContextBytes = 0;
  try {
    const context = await buildSessionPromptContext(
      sessionPath,
      {
        recentMessages: contextTurns,
        maxBytes: contextMaxBytes,
        forceFull: wantFull,
      },
    );
    totalMessages = context.totalMessages;
    injectedMessages = context.injectedMessages;
    compactedMessages = context.compactedMessages;
    fullContextBytes = context.fullContextBytes;
    promptContextBytes = context.promptContextBytes;
    promptBody = context.body;
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }

  const contextNote =
    !wantFull && compactedMessages > 0
      ? `(Previous chat context was compacted because the full session conversation was ${fullContextBytes} bytes, over the ${contextMaxBytes} byte budget. The prompt now includes an "이전대화" compacted memory block plus the latest ${injectedMessages} of ${totalMessages} messages verbatim; compacted prompt conversation bytes=${promptContextBytes}. The complete source of truth remains sessions/${sessionPath}.)`
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
  if (contextNote) promptLines.push(contextNote);
  promptLines.push(
    "Below is the running conversation. If an `이전대화` compacted block appears, treat it as prior-session continuity memory, then continue from the latest verbatim turns. Write the assistant's next reply only — no preamble, no markdown frontmatter.",
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
    const operationTarget = operationTargetFromMessage(
      kind,
      parsed.data.message,
    );
    send({
      type: "progress",
      phase: "state",
      summary: initialOperationSummary(kind, operationTarget),
      active: operationTarget,
    });

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

    // Baseline of wiki/answers before the agent runs. The agent may save an
    // answer directly (web /query --save), bypassing the deterministic secret
    // gate the Telegram path uses; we sweep files it touched once it finishes.
    const answersBaseline = await snapshotAnswerMtimes();

    try {
      if (kind === "ingest" || kind === "ingest-loop") {
        // -------- Single warm-session ingest loop --------
        // /ingest and /ingest-loop drive the wiki-ingest skill through one
        // backend loop that keeps a single CLI session warm and lets the agent
        // batch sub-chunks per invocation (config.chunking.unitPerCall). The
        // backend loop is the outer resumption/safety net; it no longer
        // cold-respawns a fresh CLI per sub-chunk or fans out parallel worker
        // CLIs. The job AbortSignal lets a Stop request interrupt the live
        // child immediately. Ingest progress UI is driven by startProgressWatcher.
        const result = await runIngestLoop({
          cfg,
          agent,
          sessionPath,
          initialPrompt: prompt,
          operationKind: kind,
          progressRef,
          rawScope: rawScopeFromMessage(parsed.data.message),
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
        // -------- Single CLI call (chat, query, preprocess, graph, lint) --------
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
          cleanCliText(result.stdout).trim() ||
          cleanCliText(result.stderr).trim() ||
          `(에이전트가 빈 응답을 반환했습니다. exitCode=${result.exitCode})`;
        // When the user stopped the run, save only the stopped-result report
        // instead of preserving a partial CLI tail as an assistant answer.
        if (job.cancelled) {
          reply = formatCancelledReply({
            kind,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
          });
        } else if (result.timedOut) {
          reply = formatTimedOutReply({
            kind,
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
      // Fail-closed backstop: mask any high-confidence secret the agent may
      // have written into a wiki/answers file during this operation.
      try {
        const sweep = await sweepAnswersForSecrets(answersBaseline);
        if (sweep.maskedFiles.length > 0) {
          await appendMessage(
            sessionPath,
            "system",
            `🔒 저장된 답변에서 비밀정보를 자동 마스킹했습니다: ${sweep.maskedFiles.join(", ")} (wiki/lint 기록).`,
          ).catch(() => undefined);
        }
      } catch {
        /* sweep is best-effort; never fail the request because of it */
      }
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
