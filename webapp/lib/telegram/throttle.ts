import "server-only";

/**
 * Per-chat rate limiter. Uses a sliding-window approach: each chat
 * keeps the timestamps of the most recent allowed messages, and a new
 * message is allowed only if fewer than `MAX_PER_WINDOW` have arrived
 * in the last `WINDOW_MS`.
 *
 * Bot API rate limits are global at ~30 messages per second per bot
 * and 1 message per second per chat. The per-chat limit here is the
 * cheap guard that protects /query — runPublicQuery is the expensive
 * call and we never want a single chat to monopolise it.
 *
 * Memory bound matches history: we drop the oldest tracked chat once
 * the map grows past `MAX_TRACKED_CHATS`.
 */

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const MAX_TRACKED_CHATS = 512;

const buckets = new Map<number, number[]>();

function evictIfNeeded(): void {
  if (buckets.size <= MAX_TRACKED_CHATS) return;
  let oldestId: number | null = null;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [id, ts] of buckets.entries()) {
    const recent = ts[ts.length - 1] ?? 0;
    if (recent < oldestTs) {
      oldestTs = recent;
      oldestId = id;
    }
  }
  if (oldestId !== null) buckets.delete(oldestId);
}

export type ThrottleDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export function consume(chatId: number, now: number = Date.now()): ThrottleDecision {
  const bucket = buckets.get(chatId) ?? [];
  // Drop timestamps that fall outside the window.
  const cutoff = now - WINDOW_MS;
  while (bucket.length > 0 && bucket[0]! <= cutoff) bucket.shift();
  if (bucket.length >= MAX_PER_WINDOW) {
    const oldest = bucket[0]!;
    const retryAfterMs = Math.max(0, WINDOW_MS - (now - oldest));
    buckets.set(chatId, bucket);
    return { allowed: false, retryAfterMs };
  }
  bucket.push(now);
  buckets.set(chatId, bucket);
  evictIfNeeded();
  return { allowed: true };
}

export function reset(chatId: number): void {
  buckets.delete(chatId);
}

export const RATE_LIMIT_WINDOW_MS = WINDOW_MS;
export const RATE_LIMIT_MAX_PER_WINDOW = MAX_PER_WINDOW;
