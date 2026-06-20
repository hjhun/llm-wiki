import { describe, expect, it, vi } from "vitest";
import {
  retryDelayMs,
  resultFailureSummary,
  runCliWithIngestLoopRetries,
  type CliRetryDeps,
} from "./cli-retry";
import type { Config } from "../config";
import type { RunResult } from "../cli";
import type { StateSummary } from "./types";

const cfg = (maxRetryAttempts: number, retryBackoffMs: number[] = [10, 20]): Config =>
  ({
    agent: { safeMode: false },
    cli: { ingestLoop: { maxRetryAttempts, retryBackoffMs } },
  }) as unknown as Config;

const result = (exitCode: number, durationMs = 5): RunResult =>
  ({
    stdout: exitCode === 0 ? "ok" : "",
    stderr: exitCode === 0 ? "" : "boom",
    exitCode,
    durationMs,
  }) as unknown as RunResult;

/** Build deps whose runCli yields the given results in order. */
function makeDeps(
  results: RunResult[],
  overrides: Partial<CliRetryDeps> = {},
): CliRetryDeps {
  let i = 0;
  return {
    runCli: vi.fn(async () => results[i++] ?? result(1)),
    appendMessage: vi.fn(async () => undefined) as unknown as CliRetryDeps["appendMessage"],
    stopFlagExists: vi.fn(async () => false),
    readIngestStateSummary: vi.fn(async () => null),
    errorMessage: (err) => String(err),
    delay: vi.fn(async () => undefined),
    ...overrides,
  };
}

const input = {
  agent: "claude" as const,
  prompt: "do work",
  cfg: cfg(3),
  iteration: 1,
  sessionPath: "s.md",
};

describe("retryDelayMs", () => {
  it("indexes by 1-based attempt and clamps to the last entry", () => {
    expect(retryDelayMs([10, 20, 30], 1)).toBe(10);
    expect(retryDelayMs([10, 20, 30], 3)).toBe(30);
    expect(retryDelayMs([10, 20], 5)).toBe(20);
    expect(retryDelayMs([], 1)).toBe(0);
  });
});

describe("resultFailureSummary", () => {
  it("prefers stderr, falls back to stdout, and truncates", () => {
    expect(resultFailureSummary(result(2))).toContain("exitCode=2");
    expect(resultFailureSummary(result(2))).toContain("boom");
  });
});

describe("runCliWithIngestLoopRetries", () => {
  it("succeeds on the first attempt", async () => {
    const deps = makeDeps([result(0)]);
    const r = await runCliWithIngestLoopRetries(input, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(1);
      expect(r.durationMs).toBe(5);
    }
    expect(deps.delay).not.toHaveBeenCalled();
  });

  it("retries after a failure, then succeeds, accumulating duration", async () => {
    const deps = makeDeps([result(1, 3), result(0, 7)]);
    const r = await runCliWithIngestLoopRetries(input, deps);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.attempts).toBe(2);
      expect(r.durationMs).toBe(10);
    }
    expect(deps.delay).toHaveBeenCalledTimes(1);
  });

  it("gives up as an error after exhausting all attempts", async () => {
    const deps = makeDeps([result(1), result(1), result(1)]);
    const r = await runCliWithIngestLoopRetries(input, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("error");
      expect(r.attempts).toBe(3);
      expect(r.reason).toContain("3회 시도 모두 실패");
    }
  });

  it("stops immediately when the stop flag is set before the first attempt", async () => {
    const deps = makeDeps([result(0)], { stopFlagExists: vi.fn(async () => true) });
    const r = await runCliWithIngestLoopRetries(input, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("stopped");
      expect(r.attempts).toBe(0);
    }
    expect(deps.runCli).not.toHaveBeenCalled();
  });

  it("short-circuits to error when a sub-chunk reports an error state", async () => {
    const errored = { error: 1 } as unknown as StateSummary;
    const deps = makeDeps([result(1)], {
      readIngestStateSummary: vi.fn(async () => errored),
    });
    const r = await runCliWithIngestLoopRetries(input, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("error");
      expect(r.attempts).toBe(1);
      expect(r.reason).toContain("error 상태");
    }
    // Did not consume a second runCli attempt.
    expect(deps.runCli).toHaveBeenCalledTimes(1);
  });

  it("forwards the session option to runCli for warm-session resume", async () => {
    const deps = makeDeps([result(0)]);
    const session = { id: "sess-1", resume: true };
    await runCliWithIngestLoopRetries({ ...input, session }, deps);
    expect(deps.runCli).toHaveBeenCalledTimes(1);
    const opts = (deps.runCli as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.session).toEqual(session);
  });

  it("always hard-kills the child on abort so the Stop button works without a timeout", async () => {
    const deps = makeDeps([result(0)]);
    // No timeout configured (the ingest/ingest-loop default).
    await runCliWithIngestLoopRetries({ ...input, timeoutMs: undefined }, deps);
    const opts = (deps.runCli as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.killOnAbort).toBe(true);
  });

  it("treats a thrown runCli as a failed attempt", async () => {
    const deps = makeDeps([], {
      runCli: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
    });
    const r = await runCliWithIngestLoopRetries({ ...input, cfg: cfg(1) }, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("error");
      expect(r.lastExitCode).toBe(-1);
    }
  });

  it("forwards compact:true into runCli opts", async () => {
    let seenCompact: boolean | undefined;
    const runCli = vi.fn(async (_agent: unknown, _prompt: unknown, opts: { compact?: boolean }) => {
      seenCompact = opts?.compact;
      return result(0);
    }) as unknown as CliRetryDeps["runCli"];

    await runCliWithIngestLoopRetries(
      {
        agent: "cline",
        prompt: "p",
        cfg: cfg(1),
        iteration: 2,
        sessionPath: "/tmp/s",
        compact: true,
      },
      makeDeps([], { runCli }),
    );

    expect(seenCompact).toBe(true);
  });

  it("forwards assistantTextOnly into runCli opts", async () => {
    let seenAssistantTextOnly: boolean | undefined;
    const runCli = vi.fn(
      async (
        _agent: unknown,
        _prompt: unknown,
        opts: { assistantTextOnly?: boolean },
      ) => {
        seenAssistantTextOnly = opts?.assistantTextOnly;
        return result(0);
      },
    ) as unknown as CliRetryDeps["runCli"];

    await runCliWithIngestLoopRetries(
      {
        agent: "cline",
        prompt: "p",
        cfg: cfg(1),
        iteration: 2,
        sessionPath: "/tmp/s",
        assistantTextOnly: true,
      },
      makeDeps([], { runCli }),
    );

    expect(seenAssistantTextOnly).toBe(true);
  });
});
