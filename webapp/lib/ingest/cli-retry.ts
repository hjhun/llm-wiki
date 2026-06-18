/**
 * Retry orchestration for one ingest-loop iteration's CLI call. The actual
 * side effects — spawning the coding-agent CLI, reading the stop flag, reading
 * the state summary, appending to the session log — are injected via `deps`,
 * so the retry/backoff/stop/error-detection control flow is fully testable
 * with fakes instead of real processes.
 *
 * Extracted from ingest-loop.ts, which supplies the real `deps`.
 */

import type { runCli, CliName } from "../cli";
import type { RunResult, SessionOption } from "../cli";
import type { Config } from "../config";
import type { appendMessage } from "../sessions";
import type { StateSummary } from "./types";

export type IngestLoopCliAttempt =
  | { ok: true; result: RunResult; attempts: number; durationMs: number }
  | {
      ok: false;
      kind: "error" | "stopped";
      reason: string;
      lastExitCode: number;
      attempts: number;
      durationMs: number;
    };

/** Backoff for `attempt` (1-based); clamps to the last configured value. */
export function retryDelayMs(backoffs: number[], attempt: number): number {
  if (backoffs.length === 0) return 0;
  return backoffs[Math.min(attempt - 1, backoffs.length - 1)] ?? 0;
}

/** Abortable sleep. Rejects if `signal` fires while waiting. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted while waiting to retry"));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function resultFailureSummary(result: RunResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  const suffix = detail ? `: ${detail.slice(0, 500)}` : "";
  return `CLI exitCode=${result.exitCode}${suffix}`;
}

/** Collaborators the retry loop needs, injected so tests can fake them. */
export type CliRetryDeps = {
  runCli: typeof runCli;
  appendMessage: typeof appendMessage;
  stopFlagExists: (sessionPath?: string) => Promise<boolean>;
  readIngestStateSummary: (options?: {
    sessionPath?: string;
    rawScope?: string | null;
  }) => Promise<StateSummary | null>;
  errorMessage: (err: unknown) => string;
  /** Defaults to the module's real `delay`; tests pass a no-op. */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type CliRetryInput = {
  agent: CliName;
  prompt: string;
  cfg: Config;
  timeoutMs?: number;
  signal?: AbortSignal;
  iteration: number;
  sessionPath: string;
  onChunk?: (text: string) => void;
  /**
   * Native CLI conversation resume for this iteration. When set, the loop
   * keeps one warm CLI session across iterations: the first iteration assigns
   * or captures a session id; later iterations resume it. The resolved id is
   * available on the returned `result.sessionId`. Undefined keeps the legacy
   * fresh-process behavior.
   */
  session?: SessionOption;
  /** Request the CLI's native history compaction this iteration (cline). */
  compact?: boolean;
};

export async function runCliWithIngestLoopRetries(
  input: CliRetryInput,
  deps: CliRetryDeps,
): Promise<IngestLoopCliAttempt> {
  const delayFn = deps.delay ?? delay;
  const maxAttempts = input.cfg.cli.ingestLoop.maxRetryAttempts;
  const backoffs = input.cfg.cli.ingestLoop.retryBackoffMs;
  let totalDurationMs = 0;
  let lastExitCode = 0;
  let lastFailure = "CLI 호출 실패";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (await deps.stopFlagExists(input.sessionPath)) {
      return {
        ok: false,
        kind: "stopped",
        reason: "사용자 Stop 요청",
        lastExitCode,
        attempts: attempt - 1,
        durationMs: totalDurationMs,
      };
    }

    try {
      const result = await deps.runCli(input.agent, input.prompt, {
        safeMode: input.cfg.agent.safeMode,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        // Always hard-kill on abort. `input.signal` here is the job's
        // AbortController, which fires ONLY on an explicit Stop (it is kept
        // separate from the HTTP req.signal so a dropped stream never kills the
        // CLI — see chat-jobs.ts). Gating this on a configured timeout meant
        // ingest (timeout=null) ignored the Stop button entirely: the abort
        // never SIGTERM'd the child, and since the agent now drives the whole
        // scope in one warm session, the between-iteration stop-flag check was
        // never reached until the run finished. Stop must interrupt the live
        // child immediately regardless of timeout config.
        killOnAbort: true,
        session: input.session,
        compact: input.compact,
        onStdout: (chunk) => {
          input.onChunk?.(chunk);
        },
      });
      totalDurationMs += result.durationMs;
      lastExitCode = result.exitCode;

      if (result.exitCode === 0) {
        return {
          ok: true,
          result,
          attempts: attempt,
          durationMs: totalDurationMs,
        };
      }

      lastFailure = resultFailureSummary(result);
    } catch (err) {
      lastExitCode = -1;
      lastFailure = `CLI 호출 실패: ${deps.errorMessage(err)}`;
    }

    const failedSummary = await deps.readIngestStateSummary();
    if (failedSummary && failedSummary.error > 0) {
      const reason = `sub-chunk ${failedSummary.error}건이 error 상태로 종료`;
      await deps
        .appendMessage(
          input.sessionPath,
          "system",
          `❌ /ingest-loop iter ${input.iteration} 처리 오류 감지: ${reason}`,
        )
        .catch(() => undefined);
      return {
        ok: false,
        kind: "error",
        reason,
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }

    const exhausted = attempt >= maxAttempts;
    const prefix = `❌ /ingest-loop iter ${input.iteration} CLI 시도 ${attempt}/${maxAttempts} 실패`;
    if (exhausted) {
      const reason = `${maxAttempts}회 시도 모두 실패: ${lastFailure}`;
      await deps
        .appendMessage(input.sessionPath, "system", `${prefix}: ${lastFailure}`)
        .catch(() => undefined);
      input.onChunk?.(`\n\n---\n${prefix}: ${lastFailure}\n`);
      return {
        ok: false,
        kind: "error",
        reason,
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }

    const waitMs = retryDelayMs(backoffs, attempt);
    const retryNote =
      `${prefix}: ${lastFailure}\n` +
      `↻ ${Math.round(waitMs / 1000)}초 후 같은 iteration을 재시도합니다.`;
    await deps
      .appendMessage(input.sessionPath, "system", retryNote)
      .catch(() => undefined);
    input.onChunk?.(`\n\n---\n${retryNote}\n`);

    if (await deps.stopFlagExists(input.sessionPath)) {
      return {
        ok: false,
        kind: "stopped",
        reason: "사용자 Stop 요청",
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }
    try {
      await delayFn(waitMs, input.signal);
    } catch (err) {
      return {
        ok: false,
        kind: "error",
        reason: deps.errorMessage(err),
        lastExitCode,
        attempts: attempt,
        durationMs: totalDurationMs,
      };
    }
  }

  return {
    ok: false,
    kind: "error",
    reason: lastFailure,
    lastExitCode,
    attempts: maxAttempts,
    durationMs: totalDurationMs,
  };
}
