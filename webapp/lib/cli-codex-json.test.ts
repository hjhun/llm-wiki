import { describe, expect, it } from "vitest";
import { createCodexJsonParser } from "./cli-codex-json";

// Mirrors the real `codex exec --json` event stream observed on codex-cli 0.139.
const STREAM = [
  '{"type":"thread.started","thread_id":"019ed3ec-90eb-7a00-ad00-8db2745dec9b"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":17245,"output_tokens":19}}',
].join("\n");

describe("createCodexJsonParser", () => {
  it("captures the thread id and agent message text", () => {
    const p = createCodexJsonParser();
    p.push(STREAM + "\n");
    expect(p.threadId()).toBe("019ed3ec-90eb-7a00-ad00-8db2745dec9b");
    expect(p.text()).toBe("ok");
  });

  it("captures the thread id eagerly, before close, across chunk splits", () => {
    const p = createCodexJsonParser();
    // Split mid-line to exercise the cross-chunk buffer.
    p.push('{"type":"thread.started","thr');
    p.push('ead_id":"abc-123"}\n{"type":"turn.started"}\n');
    expect(p.threadId()).toBe("abc-123");
  });

  it("concatenates multiple agent_message items in order", () => {
    const p = createCodexJsonParser();
    p.push(
      [
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
        '{"type":"item.completed","item":{"type":"reasoning","text":"ignored"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
        "",
      ].join("\n"),
    );
    expect(p.text()).toBe("first\nsecond");
  });

  it("flushes a trailing line without a newline at text()", () => {
    const p = createCodexJsonParser();
    p.push('{"type":"thread.started","thread_id":"t1"}\n');
    p.push('{"type":"item.completed","item":{"type":"agent_message","text":"tail"}}');
    expect(p.text()).toBe("tail");
  });

  it("ignores banner / non-JSON lines", () => {
    const p = createCodexJsonParser();
    p.push("Reading prompt from stdin...\n");
    p.push('{"type":"thread.started","thread_id":"t1"}\n');
    expect(p.threadId()).toBe("t1");
    expect(p.text()).toBe("");
  });
});
