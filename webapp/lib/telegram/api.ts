import "server-only";

import {
  TelegramGetMeResponse,
  TelegramSendMessageResponse,
  TelegramSimpleResponse,
  type TelegramUser,
} from "./types";

const API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 8_000;

function fmtBotPath(token: string, method: string): string {
  return `${API_BASE}/bot${encodeURIComponent(token)}/${method}`;
}

async function call(
  token: string,
  method: string,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const res = await fetch(fmtBotPath(token, method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  return data;
}

export async function getMe(token: string): Promise<TelegramUser> {
  const raw = await call(token, "getMe", {});
  const parsed = TelegramGetMeResponse.safeParse(raw);
  if (!parsed.success || !parsed.data.ok || !parsed.data.result) {
    throw new Error(
      parsed.success
        ? parsed.data.description ?? "getMe failed"
        : "Unexpected getMe response",
    );
  }
  return parsed.data.result;
}

export type SetWebhookInput = {
  url: string;
  secretToken: string;
  allowedUpdates?: string[];
  dropPendingUpdates?: boolean;
};

export async function setWebhook(
  token: string,
  input: SetWebhookInput,
): Promise<void> {
  const raw = await call(token, "setWebhook", {
    url: input.url,
    secret_token: input.secretToken,
    allowed_updates: input.allowedUpdates ?? ["message"],
    drop_pending_updates: input.dropPendingUpdates ?? true,
  });
  const parsed = TelegramSimpleResponse.safeParse(raw);
  if (!parsed.success || !parsed.data.ok) {
    throw new Error(
      parsed.success
        ? parsed.data.description ?? "setWebhook failed"
        : "Unexpected setWebhook response",
    );
  }
}

export async function deleteWebhook(token: string): Promise<void> {
  const raw = await call(token, "deleteWebhook", {
    drop_pending_updates: true,
  });
  const parsed = TelegramSimpleResponse.safeParse(raw);
  if (!parsed.success || !parsed.data.ok) {
    throw new Error(
      parsed.success
        ? parsed.data.description ?? "deleteWebhook failed"
        : "Unexpected deleteWebhook response",
    );
  }
}

export async function getWebhookInfo(token: string): Promise<{
  url: string;
  hasCustomCertificate?: boolean;
  pendingUpdateCount?: number;
  lastErrorDate?: number;
  lastErrorMessage?: string;
}> {
  const raw = await call(token, "getWebhookInfo", {});
  const parsed = TelegramSimpleResponse.safeParse(raw);
  if (!parsed.success || !parsed.data.ok) {
    throw new Error(
      parsed.success
        ? parsed.data.description ?? "getWebhookInfo failed"
        : "Unexpected getWebhookInfo response",
    );
  }
  const result = parsed.data.result as Record<string, unknown> | undefined;
  return {
    url: typeof result?.url === "string" ? result.url : "",
    hasCustomCertificate:
      typeof result?.has_custom_certificate === "boolean"
        ? result.has_custom_certificate
        : undefined,
    pendingUpdateCount:
      typeof result?.pending_update_count === "number"
        ? result.pending_update_count
        : undefined,
    lastErrorDate:
      typeof result?.last_error_date === "number"
        ? result.last_error_date
        : undefined,
    lastErrorMessage:
      typeof result?.last_error_message === "string"
        ? result.last_error_message
        : undefined,
  };
}

export type SendMessageInput = {
  chatId: number;
  text: string;
  parseMode?: "MarkdownV2" | "HTML" | null;
  replyToMessageId?: number;
  disableNotification?: boolean;
};

export async function sendMessage(
  token: string,
  input: SendMessageInput,
): Promise<void> {
  const raw = await call(token, "sendMessage", {
    chat_id: input.chatId,
    text: input.text,
    ...(input.parseMode ? { parse_mode: input.parseMode } : {}),
    ...(input.replyToMessageId
      ? { reply_to_message_id: input.replyToMessageId }
      : {}),
    ...(input.disableNotification
      ? { disable_notification: true }
      : {}),
  });
  const parsed = TelegramSendMessageResponse.safeParse(raw);
  if (!parsed.success || !parsed.data.ok) {
    throw new Error(
      parsed.success
        ? parsed.data.description ?? "sendMessage failed"
        : "Unexpected sendMessage response",
    );
  }
}
