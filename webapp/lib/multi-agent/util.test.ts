import { describe, expect, it } from "vitest";
import {
  clampAgentCount,
  displayManagerName,
  fitAsciiCell,
  ingestWorkComplete,
  isOrchestratedKind,
  missionProfiles,
  operationPolicy,
  rawScopeFromMessage,
  seedOffset,
} from "./util";
import { EMPTY_SNAPSHOT } from "../ingest/types";
import type { ProgressSnapshot } from "../ingest/types";
import type { Config } from "../config";

const cfgWith = (maxConcurrentAgents: number): Config =>
  ({ agent: { orchestration: { maxConcurrentAgents } } }) as unknown as Config;

const snap = (o: Partial<ProgressSnapshot> = {}): ProgressSnapshot => ({
  ...EMPTY_SNAPSHOT,
  ...o,
});

describe("isOrchestratedKind", () => {
  it("recognizes the orchestrated kinds", () => {
    expect(isOrchestratedKind("ingest")).toBe(true);
    expect(isOrchestratedKind("ingest-loop")).toBe(true);
    expect(isOrchestratedKind("lint")).toBe(true);
  });
  it("rejects single-CLI kinds", () => {
    expect(isOrchestratedKind("chat")).toBe(false);
    expect(isOrchestratedKind("query")).toBe(false);
  });
});

describe("clampAgentCount", () => {
  it("clamps to [1, 16]", () => {
    expect(clampAgentCount(cfgWith(0))).toBe(1);
    expect(clampAgentCount(cfgWith(-5))).toBe(1);
    expect(clampAgentCount(cfgWith(4))).toBe(4);
    expect(clampAgentCount(cfgWith(99))).toBe(16);
  });
});

describe("seedOffset", () => {
  it("is deterministic and varies by input", () => {
    expect(seedOffset("clio:ingest")).toBe(seedOffset("clio:ingest"));
    expect(seedOffset("clio:ingest")).not.toBe(seedOffset("clio:lint"));
  });
  it("returns a non-negative integer", () => {
    expect(seedOffset("anything")).toBeGreaterThanOrEqual(0);
  });
});

describe("displayManagerName", () => {
  it("defaults to Coordinator for empty or the literal 'manager'", () => {
    expect(displayManagerName(null)).toBe("Coordinator");
    expect(displayManagerName("  ")).toBe("Coordinator");
    expect(displayManagerName("manager")).toBe("Coordinator");
    expect(displayManagerName("Manager")).toBe("Coordinator");
  });
  it("passes through a real name", () => {
    expect(displayManagerName("Boss")).toBe("Boss");
  });
});

describe("fitAsciiCell", () => {
  it("pads short text to the width", () => {
    expect(fitAsciiCell("hi", 5)).toBe("hi   ");
  });
  it("truncates long text with a trailing marker", () => {
    expect(fitAsciiCell("abcdef", 4)).toBe("abc>");
  });
  it("collapses internal whitespace", () => {
    expect(fitAsciiCell("a   b", 5)).toBe("a b  ");
  });
});

describe("rawScopeFromMessage", () => {
  it("parses a scope from /ingest-loop and /ingest", () => {
    expect(rawScopeFromMessage("/ingest-loop raw/articles")).toBe(
      "raw/articles",
    );
    expect(rawScopeFromMessage("/ingest raw/a/b")).toBe("raw/a/b");
  });
  it("returns null for a bare command or non-command", () => {
    expect(rawScopeFromMessage("/ingest")).toBeNull();
    expect(rawScopeFromMessage("just chatting")).toBeNull();
    expect(rawScopeFromMessage(null)).toBeNull();
  });
  it("rejects scopes outside raw/", () => {
    expect(rawScopeFromMessage("/ingest wiki/x")).toBeNull();
  });
});

describe("ingestWorkComplete", () => {
  it("is true only when all leaves are done with no missing outputs", () => {
    expect(
      ingestWorkComplete(snap({ leavesTotal: 3, leavesDone: 3 })),
    ).toBe(true);
  });
  it("is false when leaves remain or outputs are missing", () => {
    expect(ingestWorkComplete(snap({ leavesTotal: 0, leavesDone: 0 }))).toBe(
      false,
    );
    expect(
      ingestWorkComplete(snap({ leavesTotal: 3, leavesDone: 2 })),
    ).toBe(false);
    expect(
      ingestWorkComplete(
        snap({ leavesTotal: 3, leavesDone: 3, sourcePagesMissing: 1 }),
      ),
    ).toBe(false);
    expect(
      ingestWorkComplete(
        snap({ leavesTotal: 3, leavesDone: 3, mergePendingParents: 1 }),
      ),
    ).toBe(false);
  });
});

describe("missionProfiles", () => {
  it("returns lint-specific profiles", () => {
    const p = missionProfiles("lint");
    expect(p).toHaveLength(4);
    expect(p[0].role).toBe("Evidence Scout");
  });
  it("returns ingest profiles for ingest kinds", () => {
    const p = missionProfiles("ingest");
    expect(p[0].role).toBe("Source Scout");
  });
});

describe("operationPolicy", () => {
  it("differs by kind", () => {
    expect(operationPolicy("lint")).toContain("read-only lint worker");
    expect(operationPolicy("ingest-loop")).toContain("backend-managed loop");
    expect(operationPolicy("ingest")).toContain(
      "exactly one sub-chunk",
    );
  });
});
