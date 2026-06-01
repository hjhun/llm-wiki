// Synthetic example source for the CLIO mini-wiki snapshot.
// A standalone per-key sliding-window rate limiter — no imports — so the
// Code Wiki source summary has something concrete to point at.

export type Decision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

const buckets = new Map<string, number[]>();

/**
 * Allow a call for `key` only if fewer than MAX_PER_WINDOW calls have landed
 * in the last WINDOW_MS. Timestamps older than the window are dropped on each
 * call, so memory per key stays bounded by MAX_PER_WINDOW.
 */
export function consume(key: string, now: number = Date.now()): Decision {
  const bucket = buckets.get(key) ?? [];
  const cutoff = now - WINDOW_MS;
  while (bucket.length > 0 && bucket[0]! <= cutoff) bucket.shift();
  if (bucket.length >= MAX_PER_WINDOW) {
    const retryAfterMs = Math.max(0, WINDOW_MS - (now - bucket[0]!));
    buckets.set(key, bucket);
    return { allowed: false, retryAfterMs };
  }
  bucket.push(now);
  buckets.set(key, bucket);
  return { allowed: true };
}

export function reset(key: string): void {
  buckets.delete(key);
}
