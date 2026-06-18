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

  it("unwraps stream_event partial deltas (--include-partial-messages)", () => {
    const p = createClaudeStreamParser();
    let live = "";
    live += p.push(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "To" } },
      }),
    );
    live += p.push(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "ken" } },
      }),
    );
    expect(live).toBe("Token");
    expect(p.finalText()).toBe("Token");
  });

  it("does not double-count: a later full assistant block is skipped after partials", () => {
    const p = createClaudeStreamParser();
    let live = "";
    live += p.push(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi " } },
      }),
    );
    live += p.push(
      line({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "there" } },
      }),
    );
    // Claude then emits the cumulative full message — must be ignored.
    live += p.push(
      line({ type: "assistant", message: { content: [{ type: "text", text: "Hi there" }] } }),
    );
    expect(live).toBe("Hi there"); // not "Hi thereHi there"
    expect(p.finalText()).toBe("Hi there");
  });

  it("flushes a trailing newline-less result line on finalize", () => {
    const p = createClaudeStreamParser();
    p.push(line({ type: "content_block_delta", delta: { type: "text_delta", text: "partial" } }));
    // result line without trailing newline
    p.push(JSON.stringify({ type: "result", result: "complete" }));
    expect(p.finalText()).toBe("complete");
  });
});

describe("claude stream-json contextTokens", () => {
  it("sums usage from the terminal result event", () => {
    const p = createClaudeStreamParser();
    p.push(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "hi" }] },
      }) + "\n",
    );
    p.push(
      JSON.stringify({
        type: "result",
        result: "hi",
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 200,
        },
      }) + "\n",
    );
    expect(p.finalText()).toBe("hi");
    expect(p.contextTokens()).toBe(5250);
  });

  it("falls back to the last assistant message usage when no result usage", () => {
    const p = createClaudeStreamParser();
    p.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "x" }],
          usage: { input_tokens: 100, output_tokens: 10 },
        },
      }) + "\n",
    );
    expect(p.contextTokens()).toBe(110);
  });

  it("returns null when no usage was seen", () => {
    const p = createClaudeStreamParser();
    p.push(JSON.stringify({ type: "result", result: "ok" }) + "\n");
    expect(p.contextTokens()).toBeNull();
  });
});
