import "server-only";

import type { PublicQueryHistoryMessage } from "../public-query";

/**
 * Per-chat conversation memory. Each chat stores up to `historyTurns`
 * (user, assistant) pairs so runPublicQuery can keep context across
 * messages. Storage is in-process only — restarts clear it. M3 keeps
 * it that way intentionally; persisting would require a more careful
 * trust review (Telegram chats are not the wiki owner).
 *
 * The LRU eviction is bounded by `MAX_TRACKED_CHATS`. When the bound is
 * reached we drop the oldest accessed chat. A misbehaving bot
 * encountering thousands of distinct users will never grow unbounded.
 */

const MAX_TRACKED_CHATS = 256;

type ChatLog = {
  messages: PublicQueryHistoryMessage[];
  lastAccess: number;
};

const store = new Map<number, ChatLog>();

function evictIfNeeded(): void {
  if (store.size <= MAX_TRACKED_CHATS) return;
  let oldestId: number | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [id, log] of store.entries()) {
    if (log.lastAccess < oldestTs) {
      oldestTs = log.lastAccess;
      oldestId = id;
    }
  }
  if (oldestId !== null) store.delete(oldestId);
}

export function readChatHistory(chatId: number): PublicQueryHistoryMessage[] {
  const log = store.get(chatId);
  if (!log) return [];
  log.lastAccess = Date.now();
  return log.messages.slice();
}

export function appendChatTurn(
  chatId: number,
  user: string,
  assistant: string,
  keepPairs: number,
): void {
  const trimmed = Math.max(0, Math.min(50, keepPairs));
  if (trimmed === 0) {
    resetChatHistory(chatId);
    return;
  }
  const log = store.get(chatId) ?? { messages: [], lastAccess: Date.now() };
  log.messages.push({ role: "user", content: user });
  log.messages.push({ role: "assistant", content: assistant });
  // Keep at most (keepPairs * 2) entries — one user + one assistant per
  // pair. We pop from the front so the most recent pair is always at
  // the end of the array.
  const cap = trimmed * 2;
  while (log.messages.length > cap) log.messages.shift();
  log.lastAccess = Date.now();
  store.set(chatId, log);
  evictIfNeeded();
}

export function resetChatHistory(chatId: number): boolean {
  return store.delete(chatId);
}

export function debugSize(): number {
  return store.size;
}
