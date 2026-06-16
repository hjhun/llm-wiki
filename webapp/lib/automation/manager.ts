import { loadConfig, type Config } from "../config";
import { getAutoIngestManager } from "../auto-ingest/manager";
import { computeNextAutomationFire, safeAutomationDelay } from "./cron";
import { getAutomationEvents } from "./events";
import {
  patchAutomationJobRuntime,
  readAutomationRuntime,
  writeAutomationRuntime,
  type AutomationRuntime,
} from "./runtime-state";
import { runAutomationJob } from "./runner";
import type { AutomationJob, AutomationSource } from "./types";

type AutomationConfig = Config["automation"];

const globalRef = globalThis as unknown as {
  __automationManager?: AutomationManager;
};

export class AutomationManager {
  private timers = new Map<string, NodeJS.Timeout>();
  private nextFireAt = new Map<string, Date>();
  private inFlight = new Set<string>();
  private booting = false;
  private active: AutomationConfig | null = null;

  async boot(): Promise<void> {
    if (this.booting) return;
    this.booting = true;
    try {
      await this.restart();
    } finally {
      this.booting = false;
    }
  }

  async restart(): Promise<void> {
    this.stop();
    const cfg = await loadConfig(true);
    await this.start(cfg.automation);
  }

  private async start(cfg: AutomationConfig): Promise<void> {
    this.active = cfg;
    if (!cfg.enabled) {
      await writeAutomationRuntime({
        status: "disabled",
        reason: "automation disabled",
        nextRunAt: null,
      });
      for (const job of cfg.jobs) {
        await patchAutomationJobRuntime(job.id, {
          status: job.enabled ? "idle" : "disabled",
          reason: job.enabled ? "global automation disabled" : "job disabled",
          nextRunAt: null,
        });
      }
      console.log("[automation] disabled; no jobs armed");
      emitState();
      return;
    }

    for (const job of cfg.jobs) {
      if (!job.enabled) {
        await patchAutomationJobRuntime(job.id, {
          status: "disabled",
          reason: "job disabled",
          nextRunAt: null,
        });
        continue;
      }
      await this.armWithCatchUp(job);
    }

    await writeAutomationRuntime({
      status: "idle",
      reason: "automation ready",
      nextRunAt: earliest(this.nextFireAt)?.toISOString() ?? null,
    });
    console.log(
      `[automation] armed ${this.timers.size} job(s); next fire ` +
        `${earliest(this.nextFireAt)?.toISOString() ?? "—"}`,
    );
    emitState();
  }

  private stop(): void {
    this.clearTimers();
    this.active = null;
  }

  private armJob(job: AutomationJob): void {
    // Clear any timer already armed for this job so re-arming (boot, restart,
    // tick, or catch-up) never leaks a stray timer that would double-fire.
    const existing = this.timers.get(job.id);
    if (existing) clearTimeout(existing);
    const next = computeNextAutomationFire(new Date(), job.schedule);
    this.nextFireAt.set(job.id, next);
    const delay = safeAutomationDelay(next.getTime() - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      const target = this.nextFireAt.get(job.id);
      if (target && Date.now() < target.getTime() - 1000) {
        this.armJob(job);
        return;
      }
      // The scheduled slot this firing represents; carried into `trigger` so
      // the same slot is not also replayed by a concurrent tick/catch-up.
      const slot = target?.toISOString() ?? new Date().toISOString();
      void (async () => {
        // Schedule the next occurrence *before* running, so a long-running or
        // hanging run never stalls the cadence. Re-read config so a job that
        // was disabled meanwhile stops re-arming. Overlap is handled by
        // `trigger`'s inFlight / maxConcurrentJobs guards, which skip the new
        // occurrence while the previous run is still in flight.
        const cfg = (await loadConfig()).automation;
        const fresh = cfg.jobs.find((candidate) => candidate.id === job.id);
        if (fresh?.enabled && cfg.enabled) {
          this.armJob(fresh);
          await patchAutomationJobRuntime(fresh.id, {
            nextRunAt: this.nextFireAt.get(fresh.id)?.toISOString() ?? null,
          });
          await writeAutomationRuntime({
            nextRunAt: earliest(this.nextFireAt)?.toISOString() ?? null,
          });
          emitState();
        }
        await this.trigger(job.id, "cron", "scheduled run", "run", slot);
      })();
    }, delay);
    this.timers.set(job.id, timer);
  }

  /**
   * Arm a job for its next future fire and, if a previously scheduled fire
   * elapsed while no timer was alive to service it (process was down, the
   * in-memory timer was lost, or the server was suspended — common on
   * WSL/desktop), replay that missed run exactly once. The persisted
   * `nextRunAt` is the schedule clock that survives restarts; `lastFiredSlot`
   * guards against replaying a slot that was already executed.
   */
  private async armWithCatchUp(job: AutomationJob): Promise<void> {
    const now = Date.now();
    const runtime = await readAutomationRuntime();
    const jobState = runtime.jobs[job.id];
    const prevNext = jobState?.nextRunAt ? new Date(jobState.nextRunAt) : null;
    const lastSlot = jobState?.lastFiredSlot ?? null;

    const missed =
      prevNext !== null &&
      prevNext.getTime() <= now &&
      (lastSlot === null || new Date(lastSlot).getTime() < prevNext.getTime());

    this.armJob(job);
    await patchAutomationJobRuntime(job.id, {
      status: jobState?.status === "running" ? "running" : "idle",
      reason: missed ? "catch-up: replaying missed run" : "scheduled",
      nextRunAt: this.nextFireAt.get(job.id)?.toISOString() ?? null,
    });

    if (missed && prevNext) {
      // Fire-and-forget: the catch-up run must not block server startup
      // (instrumentation awaits boot) or the `/tick` request, both of which
      // would otherwise hang for the full duration of the agent run. The
      // normal timer path is non-blocking for the same reason; `trigger`
      // handles its own errors and concurrency guards.
      console.log(
        `[automation] catch-up: replaying missed run for ${job.id} ` +
          `slot ${prevNext.toISOString()}`,
      );
      void this.trigger(
        job.id,
        "cron",
        "catch-up for missed scheduled run",
        "run",
        prevNext.toISOString(),
      ).catch(() => undefined);
    }
  }

  /**
   * Reconcile every job against the current config and the persisted schedule
   * clock, arming missing timers and replaying any missed runs. Safe to call
   * repeatedly — it is the entry point for the external watchdog/cron tick that
   * keeps automation reliable even when the host process is not continuously
   * alive. Idempotent: `armJob` clears existing timers and `lastFiredSlot`
   * dedupes already-fired slots.
   */
  async tick(): Promise<AutomationRuntime> {
    const cfg = (await loadConfig(true)).automation;
    this.active = cfg;
    if (!cfg.enabled) {
      this.clearTimers();
      await writeAutomationRuntime({
        status: "disabled",
        reason: "automation disabled",
        nextRunAt: null,
      });
      emitState();
      return readAutomationRuntime();
    }

    for (const job of cfg.jobs) {
      if (!job.enabled) {
        const timer = this.timers.get(job.id);
        if (timer) clearTimeout(timer);
        this.timers.delete(job.id);
        this.nextFireAt.delete(job.id);
        continue;
      }
      await this.armWithCatchUp(job);
    }

    await writeAutomationRuntime({
      status: this.inFlight.size > 0 ? "running" : "idle",
      reason: "automation tick",
      nextRunAt: earliest(this.nextFireAt)?.toISOString() ?? null,
    });
    emitState();
    return readAutomationRuntime();
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.nextFireAt.clear();
  }

  async runNow(jobId: string): Promise<AutomationRuntime> {
    void this.trigger(jobId, "manual", "manual run-now", "run");
    return readAutomationRuntime();
  }

  async planNow(jobId: string): Promise<AutomationRuntime> {
    void this.trigger(jobId, "plan", "manual plan generation", "plan");
    return readAutomationRuntime();
  }

  private async trigger(
    jobId: string,
    source: AutomationSource,
    reason: string,
    mode: "plan" | "run",
    slot?: string,
  ): Promise<void> {
    const cfg = (await loadConfig()).automation;
    const job = cfg.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      await recordSkip(jobId, "job not found");
      return;
    }
    if ((!cfg.enabled || !job.enabled) && source === "cron") return;
    if (slot) {
      // Another path (in-memory timer vs. catch-up/tick) may have already run
      // this exact scheduled slot; never replay it.
      const current = await readAutomationRuntime();
      if (current.jobs[jobId]?.lastFiredSlot === slot) return;
    }
    if (this.inFlight.has(jobId)) {
      // The job is still running from a previous occurrence. Record the skip
      // as an event but keep the per-job "running" status intact so the UI
      // does not flicker to skipped/idle while the run is ongoing.
      await recordSkip(jobId, "previous automation run still in flight", {
        preserveJobStatus: true,
      });
      return;
    }
    if (this.inFlight.size >= cfg.maxConcurrentJobs) {
      await recordSkip(jobId, "max concurrent automation jobs reached");
      return;
    }

    this.inFlight.add(jobId);
    const startedAt = new Date().toISOString();
    try {
      await patchAutomationJobRuntime(jobId, {
        status: "running",
        reason,
        startedAt,
        ...(slot ? { lastFiredSlot: slot } : {}),
      });
      await writeAutomationRuntime({
        status: "running",
        reason: `${job.name}: ${reason}`,
        startedAt,
      });
      getAutomationEvents().emitEvent({
        type: "start",
        jobId,
        runId: "pending",
        source,
        mode,
        startedAt,
      });
      emitState();

      const result = await runAutomationJob({ job, mode, source });
      await patchAutomationJobRuntime(jobId, {
        status: "idle",
        reason: `${mode} complete`,
        startedAt: null,
        lastRunAt: result.endedAt,
        lastResult: result,
        nextRunAt: this.nextFireAt.get(jobId)?.toISOString() ?? null,
      });
      await writeAutomationRuntime({
        status: "idle",
        reason: `${job.name}: ${mode} complete`,
        startedAt: null,
        lastRunAt: result.endedAt,
        lastResult: result,
        nextRunAt: earliest(this.nextFireAt)?.toISOString() ?? null,
      });
      getAutomationEvents().emitEvent({ type: "done", result });
      emitState();

      if (
        mode === "run" &&
        job.autoIngestAfterRun &&
        result.agents.some((agent) => agent.status === "success")
      ) {
        void getAutoIngestManager().runNow().catch(() => undefined);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await patchAutomationJobRuntime(jobId, {
        status: "idle",
        reason: message,
        startedAt: null,
      });
      await writeAutomationRuntime({
        status: "idle",
        reason: message,
        startedAt: null,
      });
      emitState();
    } finally {
      this.inFlight.delete(jobId);
    }
  }
}

async function recordSkip(
  jobId: string,
  reason: string,
  opts: { preserveJobStatus?: boolean } = {},
): Promise<void> {
  if (!opts.preserveJobStatus) {
    await patchAutomationJobRuntime(jobId, {
      status: "skipped",
      reason,
    });
  }
  await writeAutomationRuntime({
    status: "skipped",
    reason,
  });
  getAutomationEvents().emitEvent({ type: "skipped", jobId, reason });
  emitState();
  setTimeout(() => {
    const jobPatch = opts.preserveJobStatus
      ? Promise.resolve()
      : patchAutomationJobRuntime(jobId, { status: "idle", reason }).then(
          () => undefined,
        );
    void jobPatch
      .then(() => writeAutomationRuntime({ status: "idle", reason }))
      .then(() => emitState())
      .catch(() => undefined);
  }, 2000);
}

function earliest(values: Map<string, Date>): Date | null {
  let best: Date | null = null;
  for (const value of values.values()) {
    if (!best || value.getTime() < best.getTime()) best = value;
  }
  return best;
}

function emitState(): void {
  void readAutomationRuntime()
    .then((state) => getAutomationEvents().emitEvent({ type: "state", state }))
    .catch(() => undefined);
}

export function getAutomationManager(): AutomationManager {
  if (!globalRef.__automationManager) {
    globalRef.__automationManager = new AutomationManager();
  }
  return globalRef.__automationManager;
}
