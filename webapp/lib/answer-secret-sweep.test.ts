import { describe, expect, it } from "vitest";
import {
  selectChangedAnswers,
  type AnswerMtimes,
} from "./answer-secret-sweep";

/**
 * selectChangedAnswers decides which wiki/answers files the post-operation
 * secret sweep must re-read: only files created or rewritten during the chat
 * operation. The masking itself is covered by secret-scan.test.ts.
 */

const m = (entries: Record<string, number>): AnswerMtimes =>
  new Map(Object.entries(entries));

describe("selectChangedAnswers", () => {
  it("returns files that are new since the baseline", () => {
    const baseline = m({ "a.md": 100 });
    const current = m({ "a.md": 100, "b.md": 200 });
    expect(selectChangedAnswers(baseline, current)).toEqual(["b.md"]);
  });

  it("returns files whose mtime advanced (rewritten)", () => {
    const baseline = m({ "a.md": 100, "b.md": 200 });
    const current = m({ "a.md": 150, "b.md": 200 });
    expect(selectChangedAnswers(baseline, current)).toEqual(["a.md"]);
  });

  it("ignores unchanged files", () => {
    const baseline = m({ "a.md": 100, "b.md": 200 });
    const current = m({ "a.md": 100, "b.md": 200 });
    expect(selectChangedAnswers(baseline, current)).toEqual([]);
  });

  it("returns results sorted", () => {
    const baseline = m({});
    const current = m({ "c.md": 1, "a.md": 1, "b.md": 1 });
    expect(selectChangedAnswers(baseline, current)).toEqual([
      "a.md",
      "b.md",
      "c.md",
    ]);
  });

  it("treats an empty baseline as everything-new", () => {
    const current = m({ "x.md": 5 });
    expect(selectChangedAnswers(m({}), current)).toEqual(["x.md"]);
  });
});
