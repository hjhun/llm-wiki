import { afterEach, describe, expect, it } from "vitest";
import {
  consume,
  reset,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_MS,
} from "./throttle";

/**
 * The throttle is the cheap guard that stops a single chat from
 * monopolising the expensive runPublicQuery call. `consume` takes an
 * explicit `now` so the sliding window is fully testable without timers.
 */

const CHAT = 4242;

afterEach(() => reset(CHAT));

describe("consume — sliding window", () => {
  it("allows up to MAX_PER_WINDOW messages, then blocks", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_MAX_PER_WINDOW; i += 1) {
      expect(consume(CHAT, t0 + i).allowed).toBe(true);
    }
    const blocked = consume(CHAT, t0 + RATE_LIMIT_MAX_PER_WINDOW);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) {
      expect(blocked.retryAfterMs).toBeGreaterThan(0);
      expect(blocked.retryAfterMs).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS);
    }
  });

  it("frees a slot once the oldest timestamp ages out of the window", () => {
    const t0 = 2_000_000;
    for (let i = 0; i < RATE_LIMIT_MAX_PER_WINDOW; i += 1) {
      consume(CHAT, t0 + i);
    }
    expect(consume(CHAT, t0 + 1).allowed).toBe(false);
    // Advance just past the window relative to the first timestamp.
    const later = t0 + RATE_LIMIT_WINDOW_MS + 1;
    expect(consume(CHAT, later).allowed).toBe(true);
  });

  it("tracks chats independently", () => {
    const t0 = 3_000_000;
    for (let i = 0; i < RATE_LIMIT_MAX_PER_WINDOW; i += 1) consume(CHAT, t0 + i);
    expect(consume(CHAT, t0 + 10).allowed).toBe(false);
    // A different chat starts with a fresh bucket.
    expect(consume(CHAT + 1, t0 + 10).allowed).toBe(true);
    reset(CHAT + 1);
  });
});
