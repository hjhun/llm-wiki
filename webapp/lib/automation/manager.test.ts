import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// --- Hoisted mocks ------------------------------------------------------
// runner.runAutomationJob is the side effect we observe ("did the job fire").
const { runAutomationJob } = vi.hoisted(() => ({
  runAutomationJob: vi.fn(async () => ({
    jobId: "job-1",
    jobName: "Test Job",
    runId: "run-1",
    mode: "run" as const,
    source: "cron" as const,
    artifactRoot: "raw/automation/test/run-1",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1,
    agents: [],
  })),
}));

// Stateful in-memory runtime store so catch-up can read a persisted nextRunAt.
const { store } = vi.hoisted(() => ({
  store: { value: { jobs: {} as Record<string, Record<string, unknown>> } as Record<string, unknown> },
}));

const { config } = vi.hoisted(() => ({
  config: {
    value: {
      automation: {
        enabled: true,
        maxConcurrentJobs: 2,
        defaultWorkspaceBasePath: "",
        jobs: [
          {
            id: "job-1",
            name: "Test Job",
            enabled: true,
            template: "custom",
            prompt: "",
            schedule: {
              mode: "cron",
              preset: "daily",
              cron: "*/5 * * * *",
              time: { hour: 9, minute: 0 },
              dayOfWeek: 1,
              dayOfMonth: 1,
              timezone: "",
            },
            selectedAgents: ["codex"],
            workspaceBasePath: "",
            externalWritePolicy: "draft-only",
            autoIngestAfterRun: false,
          },
        ],
      },
    },
  },
}));

vi.mock("./runner", () => ({ runAutomationJob }));
vi.mock("../config", () => ({
  loadConfig: vi.fn(async () => config.value),
}));
vi.mock("../auto-ingest/manager", () => ({
  getAutoIngestManager: () => ({ runNow: vi.fn(async () => undefined) }),
}));
vi.mock("./events", () => ({
  getAutomationEvents: () => ({ emitEvent: vi.fn() }),
}));
vi.mock("./runtime-state", () => ({
  readAutomationRuntime: vi.fn(async () => structuredClone(store.value)),
  writeAutomationRuntime: vi.fn(async (patch: Record<string, unknown>) => {
    const cur = store.value as Record<string, unknown>;
    store.value = {
      ...cur,
      ...patch,
      jobs: { ...(cur.jobs as object), ...((patch.jobs as object) ?? {}) },
    };
    return structuredClone(store.value);
  }),
  patchAutomationJobRuntime: vi.fn(async (jobId: string, patch: Record<string, unknown>) => {
    const cur = store.value as { jobs: Record<string, unknown> };
    cur.jobs = { ...cur.jobs, [jobId]: { ...(cur.jobs[jobId] as object), ...patch } };
    return structuredClone(store.value);
  }),
}));

import { getAutomationManager } from "./manager";

function resetManager() {
  (globalThis as Record<string, unknown>).__automationManager = undefined;
}

describe("AutomationManager scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runAutomationJob.mockClear();
    store.value = { jobs: {} };
    config.value.automation.enabled = true;
    config.value.automation.jobs[0].enabled = true;
    resetManager();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a */5 cron job at the scheduled minute and re-arms", async () => {
    vi.setSystemTime(new Date("2026-06-16T08:02:30"));
    await getAutomationManager().boot();
    expect(runAutomationJob).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // -> 08:05
    expect(runAutomationJob).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000); // -> 08:10
    expect(runAutomationJob).toHaveBeenCalledTimes(2);
  });

  it("replays a missed run once on boot (process was down at the fire time)", async () => {
    // Simulate prior process that armed for 08:05 but died before firing.
    store.value = {
      jobs: {
        "job-1": {
          status: "idle",
          nextRunAt: "2026-06-16T08:05:00.000",
          lastFiredSlot: null,
        },
      },
    };
    // Boot at 08:07 — 08:05 already elapsed.
    vi.setSystemTime(new Date("2026-06-16T08:07:30"));
    await getAutomationManager().boot();
    // Catch-up is fire-and-forget so it never blocks boot; flush its microtasks.
    await vi.advanceTimersByTimeAsync(0);

    // Catch-up fired the missed 08:05 slot exactly once.
    expect(runAutomationJob).toHaveBeenCalledTimes(1);
    expect(
      (store.value as { jobs: Record<string, { lastFiredSlot?: string }> }).jobs[
        "job-1"
      ].lastFiredSlot,
    ).toBe(new Date("2026-06-16T08:05:00.000").toISOString());
  });

  it("does not replay a slot that was already fired", async () => {
    store.value = {
      jobs: {
        "job-1": {
          status: "idle",
          nextRunAt: "2026-06-16T08:05:00.000",
          lastFiredSlot: "2026-06-16T08:05:00.000", // already executed
        },
      },
    };
    vi.setSystemTime(new Date("2026-06-16T08:07:30"));
    await getAutomationManager().boot();
    await vi.advanceTimersByTimeAsync(0);
    expect(runAutomationJob).not.toHaveBeenCalled();
  });

  it("tick() arms a never-armed job and replays its missed run", async () => {
    store.value = {
      jobs: {
        "job-1": {
          status: "idle",
          nextRunAt: "2026-06-16T08:05:00.000",
          lastFiredSlot: null,
        },
      },
    };
    vi.setSystemTime(new Date("2026-06-16T08:07:30"));
    // No boot() — simulate the manager singleton in a fresh process the
    // external cron tick reaches before any in-memory arming happened.
    await getAutomationManager().tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(runAutomationJob).toHaveBeenCalledTimes(1);
  });

  it("tick() does not double-fire when the in-memory timer already ran the slot", async () => {
    vi.setSystemTime(new Date("2026-06-16T08:02:30"));
    const manager = getAutomationManager();
    await manager.boot();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000); // fires 08:05
    expect(runAutomationJob).toHaveBeenCalledTimes(1);

    // A cron tick lands right after the timer fired the same 08:05 slot.
    await manager.tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(runAutomationJob).toHaveBeenCalledTimes(1);
  });
});
