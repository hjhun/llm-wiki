import { describe, expect, it } from "vitest";
import {
  MAX_LEAVES_PER_WORKER,
  buildLeafScopeReference,
  partitionActionableLeaves,
} from "./partition";

describe("partitionActionableLeaves", () => {
  it("bootstrap (null leaves): only worker 0 is unrestricted, others empty", () => {
    const { assignments, hasState } = partitionActionableLeaves(3, null);
    expect(hasState).toBe(false);
    expect(assignments[0]).toBeNull();
    expect(assignments[1]).toEqual([]);
    expect(assignments[2]).toEqual([]);
  });

  it("distributes leaves round-robin and disjointly", () => {
    const leaves = ["a", "b", "c", "d", "e"];
    const { assignments, hasState } = partitionActionableLeaves(2, leaves);
    expect(hasState).toBe(true);
    expect(assignments[0]).toEqual(["a", "c", "e"]);
    expect(assignments[1]).toEqual(["b", "d"]);
    // disjoint + complete (within cap)
    const union = assignments.flat();
    expect(new Set(union).size).toBe(union.length);
    expect(union.sort()).toEqual([...leaves].sort());
  });

  it("caps total assigned at workerCount * MAX_LEAVES_PER_WORKER", () => {
    const workerCount = 2;
    const total = workerCount * MAX_LEAVES_PER_WORKER + 5;
    const leaves = Array.from({ length: total }, (_, i) => `leaf-${i}`);
    const { assignments } = partitionActionableLeaves(workerCount, leaves);
    const assigned = (assignments as string[][]).flat().length;
    expect(assigned).toBe(workerCount * MAX_LEAVES_PER_WORKER);
  });

  it("handles an empty actionable list (every worker empty, hasState true)", () => {
    const { assignments, hasState } = partitionActionableLeaves(3, []);
    expect(hasState).toBe(true);
    expect(assignments).toEqual([[], [], []]);
  });

  it("returns no assignments for a non-positive worker count", () => {
    expect(partitionActionableLeaves(0, ["a"]).assignments).toEqual([]);
  });
});

describe("buildLeafScopeReference", () => {
  it("null + no state → bootstrap instructions", () => {
    const text = buildLeafScopeReference(null, false);
    expect(text).toContain("bootstrap worker");
    expect(text).toContain("leaf enumeration");
  });

  it("null + has state → unrestricted instructions", () => {
    const text = buildLeafScopeReference(null, true);
    expect(text).toContain("Unrestricted");
  });

  it("empty array → no-op exit instructions", () => {
    const text = buildLeafScopeReference([], true);
    expect(text).toContain("Empty assignment");
    expect(text).toContain("Exit successfully");
  });

  it("non-empty → lists the assigned leaves", () => {
    const text = buildLeafScopeReference(["raw/a", "raw/b"], true);
    expect(text).toContain("- raw/a");
    expect(text).toContain("- raw/b");
    expect(text).toContain("disjoint from other workers");
  });
});
