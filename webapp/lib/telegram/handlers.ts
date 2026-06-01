import "server-only";

import { loadConfig, patchLocalConfig } from "../config";
import { runPublicQuery } from "../public-query";
import { sendMessage } from "./api";
import { appendChatTurn, readChatHistory, resetChatHistory } from "./history";
import { classifyIncoming, type RouterAction } from "./router";
import {
  noteDispatched,
  noteError,
  noteRejected,
  noteSkipped,
} from "./runtime-state";
import { appendTelegramSessionLog } from "./session-log";
import { splitForTelegram } from "./splitter";
import {
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
  consume,
} from "./throttle";
import {
  describeChat,
  normalizeChatKind,
  type TelegramMessage,
  type TelegramUpdate,
} from "./types";

const MAX_PENDING_ENTRIES = 50;

async function recordPending(msg: TelegramMessage): Promise<void> {
  const cfg = await loadConfig();
  const tg = cfg.telegram;
  if (tg.allowlist.some((entry) => entry.chatId === msg.chat.id)) return;
  if (tg.pending.some((entry) => entry.chatId === msg.chat.id)) return;
  const next = [...tg.pending];
  next.push({
    chatId: msg.chat.id,
    kind: normalizeChatKind(msg.chat.type),
    label: describeChat(msg.chat).slice(0, 80),
    firstSeenAt: new Date().toISOString(),
    lastMessagePreview: (msg.text ?? "(non-text)").slice(0, 120),
  });
  while (next.length > MAX_PENDING_ENTRIES) next.shift();
  await patchLocalConfig({ telegram: { ...tg, pending: next } });
}

async function send(
  token: string,
  chatId: number,
  text: string,
  replyMaxChars: number,
): Promise<void> {
  const chunks = splitForTelegram(text, replyMaxChars);
  for (const chunk of chunks) {
    try {
      await sendMessage(token, { chatId, text: chunk.text });
    } catch (err) {
      noteError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

function fmtChatMeta(msg: TelegramMessage) {
  const joinedName = [msg.from?.first_name, msg.from?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const fromUserName =
    msg.from?.username ?? (joinedName.length > 0 ? joinedName : null);
  return {
    chatId: msg.chat.id,
    chatKind: normalizeChatKind(msg.chat.type),
    chatLabel: describeChat(msg.chat),
    fromUserId: msg.from?.id ?? null,
    fromUserName,
  } as const;
}

async function handleAction(
  token: string,
  cfgReplyMaxChars: number,
  cfgHistoryTurns: number,
  msg: TelegramMessage,
  action: RouterAction,
): Promise<void> {
  const meta = fmtChatMeta(msg);
  const rawMessage = msg.text ?? "";

  switch (action.kind) {
    case "ignore":
      noteSkipped();
      return;

    case "static-help":
      await send(token, action.chatId, action.text, cfgReplyMaxChars);
      noteDispatched();
      await appendTelegramSessionLog({
        ...meta,
        kind: "static",
        rawMessage,
        answer: action.text,
        ok: true,
      }).catch((err) => noteError(`session-log: ${err}`));
      return;

    case "whoami":
      await send(token, action.chatId, action.text, cfgReplyMaxChars);
      noteDispatched();
      await appendTelegramSessionLog({
        ...meta,
        kind: "static",
        rawMessage,
        answer: action.text,
        ok: true,
      }).catch((err) => noteError(`session-log: ${err}`));
      return;

    case "reset": {
      const had = resetChatHistory(action.chatId);
      const text = had
        ? "이 chat의 대화 컨텍스트를 초기화했습니다."
        : "초기화할 컨텍스트가 없습니다.";
      await send(token, action.chatId, text, cfgReplyMaxChars);
      noteDispatched();
      await appendTelegramSessionLog({
        ...meta,
        kind: "static",
        rawMessage,
        answer: text,
        ok: true,
      }).catch((err) => noteError(`session-log: ${err}`));
      return;
    }

    case "non-text":
      await send(token, action.chatId, action.text, cfgReplyMaxChars);
      noteSkipped();
      await appendTelegramSessionLog({
        ...meta,
        kind: "non-text",
        rawMessage,
        answer: action.text,
        ok: true,
      }).catch((err) => noteError(`session-log: ${err}`));
      return;

    case "reject":
      if (action.recordPending) {
        try {
          await recordPending(msg);
        } catch (err) {
          noteError(err instanceof Error ? err.message : String(err));
        }
      }
      await send(token, action.chatId, action.text, cfgReplyMaxChars);
      noteRejected();
      await appendTelegramSessionLog({
        ...meta,
        kind: "reject",
        rawMessage,
        answer: action.text,
        ok: true,
      }).catch((err) => noteError(`session-log: ${err}`));
      return;

    case "query": {
      const throttle = consume(action.chatId);
      if (!throttle.allowed) {
        const retrySec = Math.ceil(throttle.retryAfterMs / 1000);
        const text =
          `요청이 너무 빠릅니다. ${RATE_LIMIT_MAX_PER_WINDOW}건/` +
          `${Math.round(RATE_LIMIT_WINDOW_MS / 1000)}초 한도에 도달했습니다. ` +
          `${retrySec}초 뒤에 다시 시도해주세요.`;
        await send(token, action.chatId, text, cfgReplyMaxChars);
        noteSkipped();
        await appendTelegramSessionLog({
          ...meta,
          kind: "throttled",
          rawMessage,
          question: action.question,
          answer: text,
          ok: false,
          error: "rate-limit",
        }).catch((err) => noteError(`session-log: ${err}`));
        return;
      }

      const history = readChatHistory(action.chatId);
      const started = Date.now();
      let result:
        | Awaited<ReturnType<typeof runPublicQuery>>
        | null = null;
      let error: string | null = null;
      try {
        result = await runPublicQuery(action.question, history, undefined);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (!result || error) {
        const text =
          "답변을 만들지 못했습니다." +
          (error ? ` 오류: ${error.slice(0, 200)}` : "");
        await send(token, action.chatId, text, cfgReplyMaxChars);
        noteError(error ?? "query failed");
        await appendTelegramSessionLog({
          ...meta,
          kind: "query",
          rawMessage,
          question: action.question,
          ok: false,
          error: error ?? "unknown",
          durationMs: Date.now() - started,
        }).catch((err) => noteError(`session-log: ${err}`));
        return;
      }

      const sourcesLine =
        result.sources.length > 0
          ? `\n\n출처: ${result.sources
              .slice(0, 5)
              .map((s) => s.title || s.path)
              .join(", ")}`
          : "";
      const replyBody = `${result.answer}${sourcesLine}`;
      await send(token, action.chatId, replyBody, cfgReplyMaxChars);
      // Persist the turn so the next message keeps context.
      appendChatTurn(
        action.chatId,
        action.question,
        result.answer,
        cfgHistoryTurns,
      );
      noteDispatched();
      await appendTelegramSessionLog({
        ...meta,
        kind: "query",
        rawMessage,
        question: action.question,
        answer: result.answer,
        sources: result.sources,
        agent: result.agent,
        durationMs: result.durationMs,
        ok: true,
      }).catch((err) => noteError(`session-log: ${err}`));
      return;
    }

    default: {
      const never: never = action;
      void never;
      return;
    }
  }
}

export async function dispatchUpdate(update: TelegramUpdate): Promise<void> {
  const cfg = await loadConfig();
  const tg = cfg.telegram;
  if (!tg.enabled) {
    noteSkipped();
    return;
  }
  if (!tg.botToken) {
    noteError("update received but botToken is missing");
    return;
  }
  const msg = update.message ?? update.edited_message ?? update.channel_post;
  if (!msg) {
    noteSkipped();
    return;
  }
  const action = classifyIncoming(tg, msg);
  try {
    await handleAction(
      tg.botToken,
      tg.replyMaxChars,
      tg.historyTurns,
      msg,
      action,
    );
  } catch (err) {
    noteError(err instanceof Error ? err.message : String(err));
  }
}
