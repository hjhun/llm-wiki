import { describe, expect, it } from "vitest";
import { graphIncrementalDecision } from "./graphify-decision";
import { EMPTY_SNAPSHOT } from "./types";
import type { ProgressSnapshot } from "./types";
import type { Config } from "../config";

function cfg(
  strategy: "partialAndFinal" | "finalOnly" | "auto",
  thresholds = { minLeaves: 4, minFiles: 16, minBytes: 1024 * 1024, minSubChunks: 4 },
): Config {
  return {
    graph: { autoUpdateStrategy: strategy, partialThresholds: thresholds },
  } as unknown as Config;
}

function snap(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return { ...EMPTY_SNAPSHOT, ...overrides };
}

describe("graphIncrementalDecision", () => {
  it("always enables for partialAndFinal", () => {
    const d = graphIncrementalDecision(cfg("partialAndFinal"), snap());
    expect(d.enabled).toBe(true);
    expect(d.reason).toContain("partialAndFinal");
  });

  it("always disables for finalOnly", () => {
    expect(graphIncrementalDecision(cfg("finalOnly"), snap()).enabled).toBe(
      false,
    );
  });

  it("auto: disabled when the workload is below every threshold", () => {
    const d = graphIncrementalDecision(
      cfg("auto"),
      snap({ leavesTotal: 1, filesTotal: 1, bytesTotal: 1, subChunksTotal: 1 }),
    );
    expect(d.enabled).toBe(false);
    expect(d.reason).toContain("below thresholds");
  });

  it("auto: enabled as soon as any single threshold is hit", () => {
    const d = graphIncrementalDecision(cfg("auto"), snap({ leavesTotal: 4 }));
    expect(d.enabled).toBe(true);
    expect(d.reason).toContain("leaves 4 >= 4");
  });

  it("auto: reports every threshold that fired", () => {
    const d = graphIncrementalDecision(
      cfg("auto"),
      snap({ filesTotal: 20, subChunksTotal: 10 }),
    );
    expect(d.enabled).toBe(true);
    expect(d.reason).toContain("files 20 >= 16");
    expect(d.reason).toContain("sub-chunks 10 >= 4");
  });
});
