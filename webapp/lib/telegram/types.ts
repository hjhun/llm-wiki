import { z } from "zod";

/**
 * Minimal Telegram Bot API schemas covering the surface we touch in the
 * webhook flow. We deliberately keep these narrow — Telegram updates
 * include many union arms (callback_query, inline_query, etc.) that this
 * milestone does not handle.
 */

export const TelegramUser = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});
export type TelegramUser = z.infer<typeof TelegramUser>;

export const TelegramChat = z.object({
  id: z.number(),
  type: z.enum(["private", "group", "supergroup", "channel"]),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});
export type TelegramChat = z.infer<typeof TelegramChat>;

// We do not currently descend into reply_to_message; recording its
// presence is enough for routing. Telegram nests recursively otherwise
// and zod's `z.lazy` would force every consumer to handle the full
// tree.
export const TelegramMessage = z.object({
  message_id: z.number(),
  from: TelegramUser.optional(),
  chat: TelegramChat,
  date: z.number(),
  text: z.string().optional(),
  // We do not handle non-text messages in M2, but log the presence so
  // we can return a clear "text only" rejection.
  photo: z.array(z.unknown()).optional(),
  document: z.unknown().optional(),
  voice: z.unknown().optional(),
  sticker: z.unknown().optional(),
});
export type TelegramMessage = z.infer<typeof TelegramMessage>;

export const TelegramUpdate = z.object({
  update_id: z.number(),
  message: TelegramMessage.optional(),
  edited_message: TelegramMessage.optional(),
  channel_post: TelegramMessage.optional(),
});
export type TelegramUpdate = z.infer<typeof TelegramUpdate>;

export const TelegramSendMessageResponse = z.object({
  ok: z.boolean(),
  result: TelegramMessage.optional(),
  description: z.string().optional(),
});

export const TelegramSimpleResponse = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  description: z.string().optional(),
});

export const TelegramGetMeResponse = z.object({
  ok: z.boolean(),
  result: TelegramUser.optional(),
  description: z.string().optional(),
});

export type TelegramChatKind = "private" | "group" | "channel";

/**
 * Collapse Telegram's group/supergroup distinction down to the three kinds
 * we store in our allowlist/pending tables. Treat the supergroup case the
 * same as a regular group — the chat id is what matters for routing.
 */
export function normalizeChatKind(type: TelegramChat["type"]): TelegramChatKind {
  if (type === "private") return "private";
  if (type === "channel") return "channel";
  return "group";
}

export function describeChat(chat: TelegramChat): string {
  if (chat.title) return chat.title;
  const left = chat.first_name ?? "";
  const right = chat.last_name ?? "";
  const name = `${left} ${right}`.trim();
  if (name) return name;
  if (chat.username) return `@${chat.username}`;
  return `chat ${chat.id}`;
}
