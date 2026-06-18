import { describe, expect, it } from "vitest";
import { createClineTaskParser } from "./cli-cline-task";

describe("createClineTaskParser", () => {
  it("captures the task id from the banner", () => {
    const p = createClineTaskParser();
    p.push("Task started: task-12345\nrunning...\n");
    expect(p.taskId()).toBe("task-12345");
  });

  it("captures the id across a chunk split", () => {
    const p = createClineTaskParser();
    p.push("Task star");
    p.push("ted: abc-987\n");
    expect(p.taskId()).toBe("abc-987");
  });

  it("matches a colorized banner with ANSI codes", () => {
    const p = createClineTaskParser();
    p.push("\x1b[32mTask started:\x1b[0m \x1b[1mt-42\x1b[0m\n");
    expect(p.taskId()).toBe("t-42");
  });

  it("returns null when no banner is present", () => {
    const p = createClineTaskParser();
    p.push("just some plain output without the marker\n");
    expect(p.taskId()).toBeNull();
  });

  it("keeps the first id and ignores later banners", () => {
    const p = createClineTaskParser();
    p.push("Task started: first\n");
    p.push("Task started: second\n");
    expect(p.taskId()).toBe("first");
  });
});

describe("cline contextTokens from -v summary line", () => {
  it("parses `[Ns | IN in, OUT out]` into in+out", () => {
    const p = createClineTaskParser();
    p.push("Task started: abc123\n");
    p.push("...work...\n");
    p.push("[12s | 3500 in, 420 out]\n");
    expect(p.taskId()).toBe("abc123");
    expect(p.contextTokens()).toBe(3920);
  });

  it("parses the summary line even on a resume round with no Task banner", () => {
    const p = createClineTaskParser();
    p.push("[5s | 1000 in, 200 out]\n");
    expect(p.contextTokens()).toBe(1200);
  });

  it("returns null when no summary line is seen", () => {
    const p = createClineTaskParser();
    p.push("Task started: x\n");
    expect(p.contextTokens()).toBeNull();
  });
});
