import { describe, expect, it } from "vitest";
import { splitForTelegram } from "./splitter";

/**
 * Telegram caps sendMessage at 4096 chars. The splitter must never emit a
 * chunk over the limit, must page-mark multi-chunk output, and must not
 * lose content.
 */

describe("splitForTelegram", () => {
  it("returns a single unmarked chunk when the text fits", () => {
    const chunks = splitForTelegram("short answer");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("short answer");
    expect(chunks[0].total).toBe(1);
  });

  it("handles empty input gracefully", () => {
    const chunks = splitForTelegram("   ");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("(empty response)");
  });

  it("splits long text into multiple page-marked chunks within the cap", () => {
    const para = "x".repeat(300);
    const text = Array.from({ length: 20 }, () => para).join("\n\n");
    const chunks = splitForTelegram(text, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000);
      expect(c.text).toMatch(/\(\d+\/\d+\)$/);
      expect(c.total).toBe(chunks.length);
    }
  });

  it("hard-cuts a single oversized line with no boundaries", () => {
    const chunks = splitForTelegram("y".repeat(5000), 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1000);
    }
  });

  it("preserves all non-whitespace content across chunks", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
    const chunks = splitForTelegram(text, 200);
    const joined = chunks.map((c) => c.text).join("\n");
    for (let i = 0; i < 40; i += 1) {
      expect(joined).toContain(`line-${i}`);
    }
  });
});
