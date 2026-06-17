import { describe, expect, it } from "vitest";
import {
  buildLoopContinuationPrompt,
  decideIngestLoopFinalize,
  decideLoopHalt,
  formatStateSummary,
  ingestMadeProgress,
  ingestRoundAdvanced,
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

describe("decideLoopHalt — empty scope (nothing to ingest)", () => {
  it("halts with kind 'empty' when a round enumerated no leaf at all", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ total: 0, done: 0, pending: 0 }),
    });
    expect(d).toMatchObject({ halt: true, kind: "empty" });
  });

  it("names the scope in the reason when one was given", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ total: 0, done: 0, pending: 0 }),
      rawScope: "raw/tizen/alarm",
    });
    if (!d.halt) throw new Error("expected halt");
    expect(d.kind).toBe("empty");
    expect(d.reason).toContain("raw/tizen/alarm");
  });

  it("falls back to a raw/ message when no scope was given", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ total: 0, done: 0, pending: 0 }),
      rawScope: null,
    });
    if (!d.halt) throw new Error("expected halt");
    expect(d.kind).toBe("empty");
    expect(d.reason).toContain("raw/");
  });

  it("is NOT empty when leaves exist (genuine completion stays 'normal')", () => {
    // total counts done leaves, so a fully-ingested scope must not be
    // misclassified as empty.
    const d = decideLoopHalt({
      ...baseDecision,
      summary: summary({ total: 2, done: 2, pending: 0 }),
    });
    expect(d).toMatchObject({ halt: true, kind: "normal" });
  });

  it("does not fire empty when summary is null (no state read yet)", () => {
    const d = decideLoopHalt({ ...baseDecision, summary: null });
    expect(d.halt).toBe(false);
  });

  it("error/stop/cap take priority over empty", () => {
    expect(
      decideLoopHalt({
        ...baseDecision,
        summary: summary({ total: 0 }),
        exitCode: 1,
      }),
    ).toMatchObject({ kind: "error" });
    expect(
      decideLoopHalt({
        ...baseDecision,
        summary: summary({ total: 0 }),
        stopRequested: true,
      }),
    ).toMatchObject({ kind: "stopped" });
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

describe("decideLoopHalt — configurable stagnationLimit", () => {
  it("does not stall below a higher configured limit where the default would", () => {
    // idleRounds 3 trips the default LOOP_STAGNATION_LIMIT (3) but not a
    // configured budget of 10 — productive Ralph-loop tolerance.
    const d = decideLoopHalt({
      ...baseDecision,
      idleRounds: 3,
      stagnationLimit: 10,
    });
    expect(d.halt).toBe(false);
  });

  it("stalls once idleRounds reaches the configured limit", () => {
    const d = decideLoopHalt({
      ...baseDecision,
      idleRounds: 10,
      stagnationLimit: 10,
    });
    expect(d).toMatchObject({ halt: true, kind: "stalled" });
  });

  it("honors the configured limit for the missing-output stall branch", () => {
    const below = decideLoopHalt({
      ...baseDecision,
      idleRounds: 4,
      sourcePagesMissing: 1,
      stagnationLimit: 5,
    });
    expect(below.halt).toBe(false);

    const at = decideLoopHalt({
      ...baseDecision,
      idleRounds: 5,
      sourcePagesMissing: 1,
      stagnationLimit: 5,
    });
    expect(at).toMatchObject({ halt: true, kind: "stalled" });
    if (at.halt) expect(at.reason).toContain("산출물 누락");
  });

  it("falls back to LOOP_STAGNATION_LIMIT when stagnationLimit is omitted", () => {
    expect(decideLoopHalt({ ...baseDecision, idleRounds: 2 }).halt).toBe(false);
    expect(
      decideLoopHalt({ ...baseDecision, idleRounds: 3 }),
    ).toMatchObject({ halt: true, kind: "stalled" });
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

describe("ingestRoundAdvanced", () => {
  it("counts a tracked counter moving as progress", () => {
    expect(
      ingestRoundAdvanced({
        before: snap(),
        after: snap({ leavesDone: 1 }),
        activityBefore: "sig",
        activityAfter: "sig",
      }),
    ).toBe(true);
  });

  it("counts a changed activity signature as progress even with no counter movement", () => {
    // Enumeration discovering new leaves or merge-pass page synthesis mutates
    // .state.json / wiki/log.md without moving a completion counter; that must
    // reset the stagnation guard so the loop keeps going.
    expect(
      ingestRoundAdvanced({
        before: snap(),
        after: snap(),
        activityBefore: "state:1:10|log:1:20",
        activityAfter: "state:2:12|log:1:20",
      }),
    ).toBe(true);
  });

  it("reports no progress only when both counters and activity are unchanged", () => {
    expect(
      ingestRoundAdvanced({
        before: snap(),
        after: snap(),
        activityBefore: "frozen",
        activityAfter: "frozen",
      }),
    ).toBe(false);
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

describe("decideIngestLoopFinalize", () => {
  const base = {
    haltKind: "normal" as const,
    aborted: false,
    progressed: true,
    workComplete: true,
    graphAlreadyCoversLatest: false,
  };

  it("single: runs qmd/graph/lint on a normal run that progressed", () => {
    expect(decideIngestLoopFinalize({ ...base, driver: "single" })).toEqual({
      runQmd: true,
      runGraph: true,
      graphSkipped: false,
      runLint: true,
    });
  });

  it("single: skips the final graph merge when it is already covered", () => {
    const plan = decideIngestLoopFinalize({
      ...base,
      driver: "single",
      graphAlreadyCoversLatest: true,
    });
    expect(plan.runGraph).toBe(false);
    expect(plan.graphSkipped).toBe(true);
  });

  it("single: no qmd/lint when nothing progressed", () => {
    const plan = decideIngestLoopFinalize({
      ...base,
      driver: "single",
      progressed: false,
    });
    expect(plan.runQmd).toBe(false);
    expect(plan.runLint).toBe(false);
    // The final graph merge still runs (it does not gate on progress).
    expect(plan.runGraph).toBe(true);
  });

  it("single: error halt suppresses every step", () => {
    expect(
      decideIngestLoopFinalize({ ...base, driver: "single", haltKind: "error" }),
    ).toEqual({
      runQmd: false,
      runGraph: false,
      graphSkipped: false,
      runLint: false,
    });
  });

  it("single: ignores workComplete (finalizes on progress, not completeness)", () => {
    const plan = decideIngestLoopFinalize({
      ...base,
      driver: "single",
      workComplete: false,
    });
    expect(plan.runQmd).toBe(true);
    expect(plan.runLint).toBe(true);
  });

  it("multi: runs qmd/graph/lint when complete, not aborted, normal", () => {
    expect(decideIngestLoopFinalize({ ...base, driver: "multi" })).toEqual({
      runQmd: true,
      runGraph: true,
      graphSkipped: false,
      runLint: true,
    });
  });

  it("multi: gates the whole block on full completion", () => {
    expect(
      decideIngestLoopFinalize({ ...base, driver: "multi", workComplete: false }),
    ).toEqual({
      runQmd: false,
      runGraph: false,
      graphSkipped: false,
      runLint: false,
    });
  });

  it("multi: abort suppresses every step", () => {
    expect(
      decideIngestLoopFinalize({ ...base, driver: "multi", aborted: true }),
    ).toEqual({
      runQmd: false,
      runGraph: false,
      graphSkipped: false,
      runLint: false,
    });
  });

  it("multi: complete but non-normal halt still refreshes qmd/graph, not lint", () => {
    const plan = decideIngestLoopFinalize({
      ...base,
      driver: "multi",
      haltKind: "capped",
    });
    expect(plan.runQmd).toBe(true);
    expect(plan.runGraph).toBe(true);
    expect(plan.runLint).toBe(false);
  });

  it("multi: never reports graphSkipped (no incremental merges)", () => {
    const plan = decideIngestLoopFinalize({
      ...base,
      driver: "multi",
      graphAlreadyCoversLatest: true,
    });
    expect(plan.graphSkipped).toBe(false);
    expect(plan.runGraph).toBe(true);
  });
});
