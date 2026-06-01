import type { Config } from "../config";
import { describeChat, normalizeChatKind, type TelegramMessage } from "./types";

/**
 * Build the @mention prefix(es) the router should recognise for the bot.
 * Telegram delivers commands as `/help@botusername` and free text with
 * embedded `@botusername` mentions; both need to be stripped before the
 * payload reaches runPublicQuery.
 */
function botMentionRegex(botUsername: string): RegExp {
  // Escape characters that have special meaning inside a regex group.
  const safe = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${safe}\\b`, "gi");
}

function stripBotMention(text: string, botUsername: string | null): string {
  if (!botUsername) return text;
  return text.replace(botMentionRegex(botUsername), "").trim();
}

/**
 * Decide what to do with an incoming Telegram message. The router never
 * touches Telegram directly — it just classifies. The webhook handler
 * acts on the action.
 */

export type RouterAction =
  | { kind: "ignore"; reason: string }
  | { kind: "static-help"; chatId: number; text: string }
  | { kind: "whoami"; chatId: number; text: string }
  | { kind: "reset"; chatId: number }
  | { kind: "reject"; chatId: number; text: string; recordPending: boolean }
  | { kind: "non-text"; chatId: number; text: string }
  | {
      kind: "query";
      chatId: number;
      messageId: number;
      question: string;
      permission: "query" | "trusted";
      /** trusted chats can opt in to writing the answer back to the wiki. */
      saveToWiki: boolean;
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
    "/reset - 이 chat의 대화 컨텍스트 초기화 (승인된 chat만)",
    "/query --save <질문> - 답변을 wiki/answers/ 에 저장 (trusted 권한)",
  ].join("\n");
}

export function classifyIncoming(
  cfg: Config["telegram"],
  msg: TelegramMessage,
  botUsername: string | null = null,
): RouterAction {
  const chatId = msg.chat.id;
  const chatKind = normalizeChatKind(msg.chat.type);
  const rawText = msg.text?.trim() ?? "";

  // Group/channel gating: by default the bot only reacts when explicitly
  // mentioned (`@botusername …`) or addressed via a slash command. This
  // is the standard "the bot lives in this group but doesn't speak unless
  // spoken to" UX. Private chats keep responding to all text.
  let text = rawText;
  if (chatKind !== "private") {
    const mentioned =
      botUsername != null && botMentionRegex(botUsername).test(rawText);
    const slashCommand = rawText.startsWith("/");
    if (!mentioned && !slashCommand) {
      return { kind: "ignore", reason: "group message without mention" };
    }
    // Always strip the bot mention. Slash commands sent in groups carry
    // a `@botusername` suffix (e.g. `/help@cliobot`) that Telegram
    // appends automatically; the downstream router branches don't
    // expect that suffix.
    text = stripBotMention(rawText, botUsername);
    if (text.length === 0) {
      return {
        kind: "static-help",
        chatId,
        text: staticHelpText(),
      };
    }
  }

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

  // /reset clears the per-chat conversation history we feed into
  // runPublicQuery. The handler is responsible for the actual delete;
  // the router just classifies.
  if (text === "/reset") {
    return { kind: "reset", chatId };
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
          text: "사용법: /query <질문>  (또는 /query --save <질문>)",
        };
      }
      question = rest;
    } else {
      return {
        kind: "static-help",
        chatId,
        text: `명령어 \`/${command}\`는 지원되지 않습니다.\n${staticHelpText()}`,
      };
    }
  }

  // Recognise `--save` as a leading flag on either /query --save … or a
  // bare `--save …` from a trusted chat. The flag triggers a wiki write
  // after the answer is generated.
  let saveToWiki = false;
  const saveMatch = /^--save\s+/i.exec(question);
  if (saveMatch) {
    saveToWiki = true;
    question = question.slice(saveMatch[0].length).trim();
  }
  if (saveToWiki && approved.permission !== "trusted") {
    return {
      kind: "static-help",
      chatId,
      text: "--save 는 trusted 권한이 부여된 chat에서만 사용할 수 있습니다.",
    };
  }
  if (saveToWiki && !question) {
    return {
      kind: "static-help",
      chatId,
      text: "사용법: /query --save <질문>",
    };
  }

  return {
    kind: "query",
    chatId,
    messageId: msg.message_id,
    question,
    permission: approved.permission,
    saveToWiki,
  };
}
