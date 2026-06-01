import { describe, expect, it } from "vitest";
import {
  buildLoopContinuationPrompt,
  decideLoopHalt,
  formatStateSummary,
  ingestMadeProgress,
  newlyDoneLeaves,
} from "./loop-decision";
import { EMPTY_SNAPSHOT } from "./types";
import type { ProgressSnapshot, StateSummary } from "./types";

function summary(overrides: Partial<StateSummary> = {}): StateSummary {
  return {
    total: 1,
    done: 0,
    in_progress: 0,
    partial: 0,
    pending: 1,
    error: 0,
    active_leaf: null,
    active_subchunk: null,
    ...overrides,
  };
}

function snap(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

const baseDecision = {
  exitCode: 0,
  summary: summary(),
  mergeDone: false,
  mergePending: false,
  idleRounds: 0,
  stopRequested: false,
  iteration: 1,
  maxIter: 10,
};

describe("decideLoopHalt — terminal conditions", () => {
  it("halts on a non-zero CLI exit code", () => {
    const d = decideLoopHalt({ ...baseDecision, exitCode: 2 });
    expect(d).toMatchObject({ halt: true, kind: "error" });
  });

  it("halts when a sub-chunk is in the error state", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ error: 1 }),
    });
    expect(d).toMatchObject({ halt: true, kind: "error" });
  });

  it("halts on a user stop request", () => {
    const d = decideLoopHalt({ ...baseDecision, stopRequested: true });
    expect(d).toMatchObject({ halt: true, kind: "stopped" });
  });

  it("halts when the iteration cap is reached", () => {
    const d = decideLoopHalt({ ...baseDecision, iteration: 10, maxIter: 10 });
    expect(d).toMatchObject({ halt: true, kind: "capped" });
  });
});

describe("decideLoopHalt — completion", () => {
  it("completes when all leaves are done and no merge is pending, even with merge status idle", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ total: 3, done: 3, pending: 0 }),
      mergeDone: false,
      mergePending: false,
    });
    expect(d).toMatchObject({ halt: true, kind: "normal" });
  });

  it("does NOT complete while a merge is still pending", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ total: 3, done: 3, pending: 0 }),
      mergeDone: false,
      mergePending: true,
    });
    expect(d.halt).toBe(false);
  });

  it("does NOT complete while source pages are missing", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ total: 1, done: 1, pending: 0 }),
      sourcePagesMissing: 2,
    });
    expect(d.halt).toBe(false);
  });
});

describe("decideLoopHalt — stagnation", () => {
  it("halts as stalled after the stagnation limit with missing outputs", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      idleRounds: 3,
      sourcePagesMissing: 1,
    });
    expect(d).toMatchObject({ halt: true, kind: "stalled" });
    if (d.halt) expect(d.reason).toContain("산출물 누락");
  });

  it("halts as stalled after the stagnation limit with no other progress", () => {
    const d = decideLoopHalt({ ...baseDecision, idleRounds: 3 });
    expect(d).toMatchObject({ halt: true, kind: "stalled" });
  });

  it("keeps going below the stagnation limit", () => {
    const d = decideLoopHalt({ ...baseDecision, idleRounds: 2 });
    expect(d.halt).toBe(false);
  });
});

describe("ingestMadeProgress", () => {
  it("detects forward movement in any tracked counter", () => {
    expect(
      ingestMadeProgress(snap(), snap({ subChunksDone: 1 })),
    ).toBe(true);
    expect(ingestMadeProgress(snap(), snap({ leavesDone: 1 }))).toBe(true);
    expect(
      ingestMadeProgress(snap({ mergePendingParents: 2 }), snap({ mergePendingParents: 1 })),
    ).toBe(true);
    expect(
      ingestMadeProgress(snap({ mergeDone: false }), snap({ mergeDone: true })),
    ).toBe(true);
  });

  it("returns false when nothing advanced", () => {
    expect(ingestMadeProgress(snap(), snap())).toBe(false);
  });
});

describe("newlyDoneLeaves", () => {
  it("returns only leaves that became done this round", () => {
    const before = snap({ doneLeaves: ["raw/a"] });
    const after = snap({ doneLeaves: ["raw/a", "raw/b", "raw/c"] });
    expect(newlyDoneLeaves(before, after)).toEqual(["raw/b", "raw/c"]);
  });
});

describe("buildLoopContinuationPrompt", () => {
  it("includes the scope line and scoped conversation when a raw scope is set", () => {
    const prompt = buildLoopContinuationPrompt({
      sessionPath: "2026-06-01/x_ingest.md",
      iteration: 2,
      progressRef: null,
      rawScope: "raw/articles",
    });
    expect(prompt).toContain("target scope: raw/articles");
    expect(prompt).toContain("User: /ingest-loop raw/articles");
    expect(prompt).toContain("iteration 2");
  });

  it("falls back to a plain /ingest conversation without a scope", () => {
    const prompt = buildLoopContinuationPrompt({
      sessionPath: "s.md",
      iteration: 1,
      progressRef: null,
    });
    expect(prompt).toContain("User: /ingest");
    expect(prompt).not.toContain("target scope:");
  });

  it("includes optional reference blocks when provided", () => {
    const prompt = buildLoopContinuationPrompt({
      sessionPath: "s.md",
      iteration: 1,
      progressRef: "PROGRESS-REF",
      entityRegistryRef: "ENTITY-REF",
    });
    expect(prompt).toContain("PROGRESS-REF");
    expect(prompt).toContain("ENTITY-REF");
  });
});

describe("formatStateSummary", () => {
  it("renders counts and only the non-zero states", () => {
    expect(formatStateSummary(summary({ total: 4, done: 2, pending: 2 }))).toBe(
      "leaves 2/4 done · 2 pending",
    );
  });

  it("appends the active leaf and sub-chunk when present", () => {
    const text = formatStateSummary(
      summary({
        total: 2,
        done: 1,
        in_progress: 1,
        pending: 0,
        active_leaf: "raw/x",
        active_subchunk: { id: "c1", status: "in_progress" },
      }),
    );
    expect(text).toContain("raw/x");
    expect(text).toContain("sub-chunk c1 in_progress");
  });
});
