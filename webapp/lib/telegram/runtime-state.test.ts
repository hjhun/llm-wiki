import { describe, expect, it } from "vitest";
import {
  noteDispatched,
  noteSkipped,
  noteThrottled,
  snapshotStats,
} from "./runtime-state";

/**
 * Rate-limit hits are tracked separately from generic skips so an operator
 * can tell "the bot is being throttled" apart from "non-text/ignored
 * traffic" in the Settings status panel. (Vitest isolates modules per test
 * file, so the in-process counters start at zero here.)
 */

describe("telegram runtime stats — throttled counter", () => {
  it("starts at zero", () => {
    expect(snapshotStats().throttled).toBe(0);
  });

  it("increments throttled independently of skipped and dispatched", () => {
    noteThrottled();
    noteThrottled();
    noteSkipped();
    noteDispatched();
    const s = snapshotStats();
    expect(s.throttled).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.dispatched).toBe(1);
  });

  it("returns a copy, not the live object", () => {
    const a = snapshotStats();
    a.throttled = 999;
    expect(snapshotStats().throttled).not.toBe(999);
  });
});
