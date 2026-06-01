import "server-only";

import { loadConfig, patchLocalConfig } from "../config";
import { runPublicQuery } from "../public-query";
import { sendMessage } from "./api";
import { classifyIncoming, type RouterAction } from "./router";
import {
  noteDispatched,
  noteError,
  noteRejected,
  noteSkipped,
} from "./runtime-state";
import { splitForTelegram } from "./splitter";
import {
  describeChat,
  normalizeChatKind,
  type TelegramMessage,
  type TelegramUpdate,
} from "./types";

const MAX_PENDING_ENTRIES = 50;

/**
 * Add a chat to the pending allowlist (config.telegram.pending) the first
 * time we see it. Caller is expected to gate this on
 * `RouterAction.recordPending === true`.
 */
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
  // Trim from the front so an attacker can't flood pending forever.
  while (next.length > MAX_PENDING_ENTRIES) next.shift();
  await patchLocalConfig({ telegram: { ...tg, pending: next } });
}

async function send(token: string, chatId: number, text: string): Promise<void> {
  const cfg = await loadConfig();
  const chunks = splitForTelegram(text, cfg.telegram.replyMaxChars);
  for (const chunk of chunks) {
    try {
      await sendMessage(token, { chatId, text: chunk.text });
    } catch (err) {
      noteError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
}

async function handleAction(
  token: string,
  msg: TelegramMessage,
  action: RouterAction,
): Promise<void> {
  switch (action.kind) {
    case "ignore":
      noteSkipped();
      return;
    case "static-help":
    case "whoami":
      await send(token, action.chatId, action.text);
      noteDispatched();
      return;
    case "non-text":
      await send(token, action.chatId, action.text);
      noteSkipped();
      return;
    case "reject":
      if (action.recordPending) {
        try {
          await recordPending(msg);
        } catch (err) {
          // Pending registration failure is not fatal; still send rejection.
          noteError(err instanceof Error ? err.message : String(err));
        }
      }
      await send(token, action.chatId, action.text);
      noteRejected();
      return;
    case "query": {
      const result = await runPublicQuery(action.question, [], undefined);
      const sources =
        result.sources.length > 0
          ? `\n\n출처: ${result.sources
              .slice(0, 5)
              .map((s) => s.title || s.path)
              .join(", ")}`
          : "";
      await send(token, action.chatId, `${result.answer}${sources}`);
      noteDispatched();
      return;
    }
    default: {
      // exhaustiveness guard
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
    await handleAction(tg.botToken, msg, action);
  } catch (err) {
    noteError(err instanceof Error ? err.message : String(err));
  }
}
