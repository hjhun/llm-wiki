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
