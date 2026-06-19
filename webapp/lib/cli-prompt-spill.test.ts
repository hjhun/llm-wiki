import { describe, it, expect } from "vitest";
import { planPromptSpill, promptByteLength } from "./cli";

describe("promptByteLength", () => {
  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    // The kernel argv ceiling (MAX_ARG_STRLEN) counts bytes. Korean chars are
    // 3 bytes each in UTF-8 but length 1 in JS, so `.length` underestimates.
    const ko = "한국어";
    expect(ko.length).toBe(3);
    expect(promptByteLength(ko)).toBe(9);
  });
});

describe("planPromptSpill", () => {
  it("leaves a small prompt inline", () => {
    const plan = planPromptSpill("hello", 1024, "id1");
    expect(plan.spilled).toBe(false);
    expect(plan.promptForArgs).toBe("hello");
  });

  it("spills when the UTF-8 byte length exceeds the threshold", () => {
    // 4 Korean chars = 12 bytes > 10-byte threshold, even though length is 4.
    const big = "한국어다";
    const plan = planPromptSpill(big, 10, "id2");
    expect(plan.spilled).toBe(true);
    if (!plan.spilled) throw new Error("expected spill");
    // The argv stub is tiny and must point at the spill file.
    expect(promptByteLength(plan.promptForArgs)).toBeLessThan(2048);
    expect(plan.fileName).toContain("id2");
    expect(plan.promptForArgs).toContain(plan.fileName);
    // The full original prompt is preserved verbatim as the file content.
    expect(plan.content).toBe(big);
  });

  it("decides on the byte boundary, not the code-unit boundary", () => {
    // 10 ASCII bytes, threshold 10 -> inline (<=). 11 -> spill.
    expect(planPromptSpill("0123456789", 10, "x").spilled).toBe(false);
    expect(planPromptSpill("01234567890", 10, "x").spilled).toBe(true);
  });
});
