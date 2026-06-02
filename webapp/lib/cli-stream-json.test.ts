import { describe, expect, it } from "vitest";
import { createClaudeStreamParser } from "./cli-stream-json";

const line = (obj: unknown) => JSON.stringify(obj) + "\n";

describe("createClaudeStreamParser", () => {
  it("emits text from content_block_delta events and prefers the result for final", () => {
    const p = createClaudeStreamParser();
    let live = "";
    live += p.push(line({ type: "system", subtype: "init" }));
    live += p.push(
      line({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }),
    );
    live += p.push(
      line({ type: "content_block_delta", delta: { type: "text_delta", text: " world" } }),
    );
    live += p.push(line({ type: "result", subtype: "success", result: "Hello world" }));
    expect(live).toBe("Hello world");
    expect(p.finalText()).toBe("Hello world");
  });

  it("falls back to concatenated deltas when no result event arrives", () => {
    const p = createClaudeStreamParser();
    p.push(line({ type: "content_block_delta", delta: { type: "text_delta", text: "abc" } }));
    p.push(line({ type: "content_block_delta", delta: { type: "text_delta", text: "def" } }));
    expect(p.finalText()).toBe("abcdef");
  });

  it("handles full assistant message blocks (non-delta mode)", () => {
    const p = createClaudeStreamParser();
    const live = p.push(
      line({
        type: "assistant",
        message: { content: [{ type: "text", text: "Answer." }] },
      }),
    );
    expect(live).toBe("Answer.");
    // result still wins for the final text
    p.push(line({ type: "result", result: "Answer." }));
    expect(p.finalText()).toBe("Answer.");
  });

  it("buffers partial lines split across chunks", () => {
    const p = createClaudeStreamParser();
    const full = line({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "split" },
    });
    const mid = Math.floor(full.length / 2);
    expect(p.push(full.slice(0, mid))).toBe(""); // incomplete line yields nothing
    const out = p.push(full.slice(mid));
    expect(out).toBe("split");
  });

  it("ignores non-JSON banner lines and blanks", () => {
    const p = createClaudeStreamParser();
    expect(p.push("not json\n\n")).toBe("");
    expect(p.push(line({ type: "content_block_delta", delta: { type: "text_delta", text: "x" } }))).toBe("x");
    expect(p.finalText()).toBe("x");
  });

  it("flushes a trailing newline-less result line on finalize", () => {
    const p = createClaudeStreamParser();
    p.push(line({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }));
    // result line without trailing newline
    p.push(JSON.stringify({ type: "result", result: "complete" }));
    expect(p.finalText()).toBe("complete");
  });
});
