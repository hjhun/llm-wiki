import type { Config } from "../config";
import { describeChat, normalizeChatKind, type TelegramMessage } from "./types";

/**
 * Decide what to do with an incoming Telegram message. The router never
 * touches Telegram directly — it just classifies. The webhook handler
 * acts on the action.
 */

export type RouterAction =
  | { kind: "ignore"; reason: string }
  | { kind: "static-help"; chatId: number; text: string }
  | { kind: "whoami"; chatId: number; text: string }
  | { kind: "reject"; chatId: number; text: string; recordPending: boolean }
  | { kind: "non-text"; chatId: number; text: string }
  | {
      kind: "query";
      chatId: number;
      messageId: number;
      question: string;
      permission: "query" | "trusted";
    };

function isApproved(cfg: Config["telegram"], chatId: number) {
  return cfg.allowlist.find((entry) => entry.chatId === chatId) ?? null;
}

function pendingAlready(cfg: Config["telegram"], chatId: number) {
  return cfg.pending.some((entry) => entry.chatId === chatId);
}

function staticHelpText(): string {
  return [
    "CLIO bot",
    "",
    "이 봇은 위키 기반 질의 응답을 제공합니다. 평문으로 질문을 보내시면 wiki에서 답을 찾아 회신합니다.",
    "",
    "지원 명령:",
    "/start - 안내 메시지",
    "/help - 이 도움말",
    "/whoami - 이 chat의 ID 표시 (관리자 승인 신청용)",
  ].join("\n");
}

export function classifyIncoming(
  cfg: Config["telegram"],
  msg: TelegramMessage,
): RouterAction {
  const chatId = msg.chat.id;
  const chatKind = normalizeChatKind(msg.chat.type);
  const text = msg.text?.trim() ?? "";

  // Non-text payload (photo/voice/etc.) — accept enough to ack but don't
  // try to ingest in M2.
  if (!text) {
    return {
      kind: "non-text",
      chatId,
      text: "이 봇은 현재 텍스트 메시지만 처리합니다.",
    };
  }

  // Telegram built-in entry points work even before approval. We rely on
  // them so a new user can ask the bot to print their chat id.
  if (text === "/start") {
    return {
      kind: "static-help",
      chatId,
      text: staticHelpText(),
    };
  }
  if (text === "/help") {
    return { kind: "static-help", chatId, text: staticHelpText() };
  }
  if (text === "/whoami") {
    return {
      kind: "whoami",
      chatId,
      text: `chat id: ${chatId}\nkind: ${chatKind}\nname: ${describeChat(msg.chat)}`,
    };
  }

  const approved = isApproved(cfg, chatId);
  if (!approved) {
    return {
      kind: "reject",
      chatId,
      text: cfg.rejectionMessage,
      recordPending: !pendingAlready(cfg, chatId),
    };
  }

  // Strip a leading "/query" or unknown leading slash so the user can be
  // verbose without it leaking into the question text.
  let question = text;
  const slashMatch = /^\/([a-z][a-z0-9_-]*)(\s+(.*))?$/is.exec(text);
  if (slashMatch) {
    const command = slashMatch[1].toLowerCase();
    const rest = (slashMatch[3] ?? "").trim();
    if (command === "query") {
      if (!rest) {
        return {
          kind: "static-help",
          chatId,
          text: "사용법: /query <질문>",
        };
      }
      question = rest;
    } else {
      // M2 only handles /query and the static commands above.
      return {
        kind: "static-help",
        chatId,
        text: `명령어 \`/${command}\`는 지원되지 않습니다.\n${staticHelpText()}`,
      };
    }
  }

  return {
    kind: "query",
    chatId,
    messageId: msg.message_id,
    question,
    permission: approved.permission,
  };
}
