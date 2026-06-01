import "server-only";

import { getMe } from "./api";

/**
 * In-process cache for the bot's `@username`. We need it on every group
 * message to decide whether the bot was mentioned. Refreshing through
 * getMe on every webhook would burn an extra API round-trip; caching it
 * once and invalidating on token change is enough.
 *
 * Use `invalidate()` whenever the saved bot token changes (token rotate
 * or clear) so the next dispatch refetches against the new bot.
 */

type CacheEntry = {
  token: string;
  username: string | null;
  fetchedAt: number;
};

let cache: CacheEntry | null = null;

export function invalidate(): void {
  cache = null;
}

export async function getBotUsername(token: string): Promise<string | null> {
  if (cache && cache.token === token) return cache.username;
  try {
    const me = await getMe(token);
    cache = {
      token,
      username: me.username ?? null,
      fetchedAt: Date.now(),
    };
    return cache.username;
  } catch {
    // Cache a `null` username for a short while so a misconfigured token
    // does not hammer Telegram on every webhook. We still record the
    // current token so the next token rotation refreshes immediately.
    cache = { token, username: null, fetchedAt: Date.now() };
    return null;
  }
}
