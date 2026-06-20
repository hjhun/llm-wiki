import { describe, expect, it } from "vitest";
import { createClineJsonParser } from "./cli-cline-json";

const line = (obj: unknown) => JSON.stringify(obj) + "\n";

describe("createClineJsonParser", () => {
  it("extracts assistant text from agent_event.event.text", () => {
    const p = createClineJsonParser();
    const out = p.push(
      line({ type: "agent_event", event: { text: "Hello" } }) +
        line({ type: "agent_event", event: { text: " world" } }),
    );

    expect(out).toBe("Hello world");
    expect(p.finalText()).toBe("Hello world");
  });

  it("ignores tool and status events", () => {
    const p = createClineJsonParser();
    p.push(
      line({ type: "task_started", id: "task-123" }) +
        line({
          type: "tool_call",
          tool: "read_file",
          event: { text: "hidden" },
        }) +
        line({ type: "agent_event", event: { text: "Answer" } }),
    );

    expect(p.finalText()).toBe("Answer");
  });

  it("captures a task id from task/session events only", () => {
    const p = createClineJsonParser();
    p.push(
      line({ type: "agent_event", id: "message-1", event: { text: "A" } }),
    );
    expect(p.taskId()).toBeNull();

    p.push(line({ type: "task_started", id: "task-123" }));
    expect(p.taskId()).toBe("task-123");
  });

  it("buffers partial lines and flushes a trailing newline-less line", () => {
    const p = createClineJsonParser();
    const full = line({ type: "agent_event", event: { text: "split" } });
    const mid = Math.floor(full.length / 2);

    expect(p.push(full.slice(0, mid))).toBe("");
    expect(p.push(full.slice(mid))).toBe("split");
    p.push(JSON.stringify({ type: "agent_event", event: { text: " tail" } }));

    expect(p.finalText()).toBe("split tail");
  });

  it("ignores non-JSON lines", () => {
    const p = createClineJsonParser();
    p.push("not json\n");
    p.push(line({ type: "agent_event", event: { text: "ok" } }));

    expect(p.finalText()).toBe("ok");
  });
});
