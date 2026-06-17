import { describe, expect, it } from "vitest";
import {
  buildDeterministicIngestLoopReply,
  buildWorkerDeltaPrompt,
  clampAgentCount,
  displayManagerName,
  fitAsciiCell,
  ingestWorkComplete,
  isOrchestratedKind,
  missionProfiles,
  operationPolicy,
  rawScopeFromMessage,
  seedOffset,
  shouldUseDeterministicIngestLoopReply,
  shouldResumeWorker,
  summarizeWorkerFailures,
} from "./util";
import { EMPTY_SNAPSHOT } from "../ingest/types";
import type { ProgressSnapshot } from "../ingest/types";
import type { Config } from "../config";
import type { RunResult } from "../cli";
import type { WorkerRun } from "./types";

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

describe("shouldUseDeterministicIngestLoopReply", () => {
  const base = {
    haltKind: "normal",
    workComplete: true,
    failedWorkerRounds: 0,
    lastExitCode: 0,
  };

  it("uses the deterministic reply only for a clean normal completion", () => {
    expect(shouldUseDeterministicIngestLoopReply(base)).toBe(true);
  });

  it("falls back to the manager for non-normal or risky endings", () => {
    expect(
      shouldUseDeterministicIngestLoopReply({ ...base, haltKind: "timeout" }),
    ).toBe(false);
    expect(
      shouldUseDeterministicIngestLoopReply({ ...base, workComplete: false }),
    ).toBe(false);
    expect(
      shouldUseDeterministicIngestLoopReply({ ...base, failedWorkerRounds: 1 }),
    ).toBe(false);
    expect(
      shouldUseDeterministicIngestLoopReply({ ...base, lastExitCode: 1 }),
    ).toBe(false);
  });
});

describe("buildDeterministicIngestLoopReply", () => {
  const worker = (name: string): WorkerRun["worker"] =>
    ({ id: name, name }) as unknown as WorkerRun["worker"];
  const ok = (durationMs: number): RunResult =>
    ({ exitCode: 0, durationMs }) as unknown as RunResult;

  it("formats a compact successful ingest-loop summary", () => {
    const out = buildDeterministicIngestLoopReply({
      haltKind: "normal",
      haltReason: "all ingest work complete",
      rounds: 2,
      rawScope: "raw/demo",
      snapshot: snap({
        leavesTotal: 1,
        leavesDone: 1,
        filesTotal: 1,
        sourcePagesWritten: 1,
      }),
      runs: [
        {
          worker: worker("Ada Lovelace"),
          round: 1,
          result: ok(1250),
          error: null,
        },
      ],
      totalDurationMs: 2500,
    });

    expect(out).toContain("[/ingest-loop normal] all ingest work complete");
    expect(out).toContain("Scope: `raw/demo`");
    expect(out).toContain("Duration: 2.5s");
    expect(out).toContain("Leaves: 1/1");
    expect(out).toContain("Round 1: Ada Lovelace, 1.3s");
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

describe("shouldResumeWorker", () => {
  const base = {
    hasSessionTracking: true,
    cliSupportsResume: true,
    round: 2,
    priorSessionId: "sess-1",
  };
  it("resumes when tracking, support, round>1, and a prior id all hold", () => {
    expect(shouldResumeWorker(base)).toBe(true);
  });
  it("does not resume on the first round", () => {
    expect(shouldResumeWorker({ ...base, round: 1 })).toBe(false);
  });
  it("does not resume without a prior session id", () => {
    expect(shouldResumeWorker({ ...base, priorSessionId: null })).toBe(false);
  });
  it("does not resume when the CLI cannot resume by id", () => {
    expect(shouldResumeWorker({ ...base, cliSupportsResume: false })).toBe(false);
  });
  it("does not resume when session tracking is disabled", () => {
    expect(shouldResumeWorker({ ...base, hasSessionTracking: false })).toBe(false);
  });
});

describe("buildWorkerDeltaPrompt", () => {
  it("names the worker and round and omits a missing leaf scope", () => {
    const out = buildWorkerDeltaPrompt({ workerName: "Ada Lovelace", round: 3 });
    expect(out).toContain("Ada Lovelace");
    expect(out).toContain("round 3");
    expect(out).not.toContain("ASSIGNED LEAF SCOPE");
  });
  it("instructs re-reading on-disk state instead of reloading instructions", () => {
    const out = buildWorkerDeltaPrompt({ workerName: "W", round: 2 });
    expect(out).toContain("Do not reload");
    expect(out).toContain(".state.json");
  });
  it("includes the leaf scope block when provided", () => {
    const out = buildWorkerDeltaPrompt({
      workerName: "W",
      round: 2,
      leafScopeRef: "===== ASSIGNED LEAF SCOPE =====\n- raw/a",
    });
    expect(out).toContain("ASSIGNED LEAF SCOPE");
    expect(out).toContain("raw/a");
  });
});

describe("summarizeWorkerFailures", () => {
  const worker = (name: string): WorkerRun["worker"] =>
    ({ id: name, name }) as unknown as WorkerRun["worker"];
  const ok = (exitCode: number): RunResult =>
    ({ exitCode }) as unknown as RunResult;
  const run = (
    name: string,
    opts: { exitCode?: number; error?: string } = {},
  ): WorkerRun => ({
    worker: worker(name),
    round: 1,
    result: opts.error ? null : ok(opts.exitCode ?? 0),
    error: opts.error ?? null,
  });

  it("reports zero failures when all workers exit 0", () => {
    expect(summarizeWorkerFailures([run("a"), run("b")])).toEqual({
      total: 2,
      failed: 0,
      failedNames: [],
    });
  });

  it("counts a non-zero exit as a failure and names it", () => {
    const s = summarizeWorkerFailures([run("a", { exitCode: 1 }), run("b")]);
    expect(s).toEqual({ total: 2, failed: 1, failedNames: ["a"] });
  });

  it("counts a thrown error as a failure", () => {
    const s = summarizeWorkerFailures([run("a", { error: "boom" }), run("b")]);
    expect(s).toEqual({ total: 2, failed: 1, failedNames: ["a"] });
  });

  it("handles a fully failed round", () => {
    const s = summarizeWorkerFailures([
      run("a", { exitCode: 1 }),
      run("b", { error: "x" }),
    ]);
    expect(s).toEqual({ total: 2, failed: 2, failedNames: ["a", "b"] });
  });

  it("treats an empty batch as no failures", () => {
    expect(summarizeWorkerFailures([])).toEqual({
      total: 0,
      failed: 0,
      failedNames: [],
    });
  });
});
