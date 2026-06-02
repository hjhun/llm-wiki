import "server-only";

import { loadConfig } from "../config";
import { sendMessage } from "./api";

/**
 * Best-effort push notification to trusted Telegram chats when a long ingest
 * run finishes. Silent no-op unless the bot is enabled, a token is set, and
 * `notifyOnIngest` is on. Never throws (notifications must not break ingest).
 */
export async function notifyIngestComplete(summary: string): Promise<void> {
  try {
    const cfg = await loadConfig();
    const tg = cfg.telegram;
    if (!tg.enabled || !tg.notifyOnIngest || !tg.botToken) return;
    const targets = tg.allowlist.filter((c) => c.permission === "trusted");
    for (const target of targets) {
      await sendMessage(tg.botToken, {
        chatId: target.chatId,
        text: summary,
      }).catch(() => undefined);
    }
  } catch {
    // Notifications are best-effort; swallow all errors.
  }
}
