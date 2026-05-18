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
      this.armJob(job);
      await patchAutomationJobRuntime(job.id, {
        status: "idle",
        reason: "scheduled",
        nextRunAt: this.nextFireAt.get(job.id)?.toISOString() ?? null,
      });
    }

    await writeAutomationRuntime({
      status: "idle",
      reason: "automation ready",
      nextRunAt: earliest(this.nextFireAt)?.toISOString() ?? null,
    });
    emitState();
  }

  private stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.nextFireAt.clear();
    this.active = null;
  }

  private armJob(job: AutomationJob): void {
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
      void (async () => {
        try {
          await this.trigger(job.id, "cron", "scheduled run", "run");
        } finally {
          const fresh = (await loadConfig()).automation.jobs.find(
            (candidate) => candidate.id === job.id,
          );
          if (fresh?.enabled && (await loadConfig()).automation.enabled) {
            this.armJob(fresh);
            await patchAutomationJobRuntime(fresh.id, {
              nextRunAt: this.nextFireAt.get(fresh.id)?.toISOString() ?? null,
            });
            await writeAutomationRuntime({
              nextRunAt: earliest(this.nextFireAt)?.toISOString() ?? null,
            });
            emitState();
          }
        }
      })();
    }, delay);
    this.timers.set(job.id, timer);
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
  ): Promise<void> {
    const cfg = (await loadConfig()).automation;
    const job = cfg.jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      await recordSkip(jobId, "job not found");
      return;
    }
    if ((!cfg.enabled || !job.enabled) && source === "cron") return;
    if (this.inFlight.has(jobId)) {
      await recordSkip(jobId, "previous automation run still in flight");
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

async function recordSkip(jobId: string, reason: string): Promise<void> {
  await patchAutomationJobRuntime(jobId, {
    status: "skipped",
    reason,
  });
  await writeAutomationRuntime({
    status: "skipped",
    reason,
  });
  getAutomationEvents().emitEvent({ type: "skipped", jobId, reason });
  emitState();
  setTimeout(() => {
    void patchAutomationJobRuntime(jobId, { status: "idle", reason })
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
