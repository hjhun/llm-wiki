import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../paths";

const STATE_REL = "wiki/.progress/automation/state.json";

const AgentResultSchema = z.object({
  agent: z.enum(["codex", "claude", "gemini", "cline"]),
  status: z.enum(["success", "error"]),
  workspacePath: z.string(),
  artifactPath: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().min(0),
  error: z.string().nullable(),
});

const LastResultSchema = z.object({
  jobId: z.string(),
  jobName: z.string(),
  runId: z.string(),
  mode: z.enum(["plan", "run"]),
  source: z.enum(["cron", "manual", "plan"]),
  artifactRoot: z.string(),
  startedAt: z.string(),
  endedAt: z.string(),
  durationMs: z.number().int().min(0),
  agents: z.array(AgentResultSchema),
});

export const AutomationRuntimeSchema = z.object({
  status: z.enum(["idle", "running", "skipped", "disabled"]).default("idle"),
  reason: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null),
  nextRunAt: z.string().nullable().default(null),
  lastResult: LastResultSchema.nullable().default(null),
  jobs: z
    .record(
      z.object({
        status: z.enum(["idle", "running", "skipped", "disabled"]).default("idle"),
        reason: z.string().nullable().default(null),
        startedAt: z.string().nullable().default(null),
        lastRunAt: z.string().nullable().default(null),
        nextRunAt: z.string().nullable().default(null),
        lastResult: LastResultSchema.nullable().default(null),
      }),
    )
    .default({}),
});

export type AutomationRuntime = z.infer<typeof AutomationRuntimeSchema>;

const EMPTY_RUNTIME: AutomationRuntime = AutomationRuntimeSchema.parse({});

function statePath(): string {
  return path.join(PROJECT_ROOT, STATE_REL);
}

export async function readAutomationRuntime(): Promise<AutomationRuntime> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    return AutomationRuntimeSchema.parse(JSON.parse(raw));
  } catch {
    return { ...EMPTY_RUNTIME, jobs: {} };
  }
}

export async function writeAutomationRuntime(
  patch: Partial<AutomationRuntime>,
): Promise<AutomationRuntime> {
  const current = await readAutomationRuntime();
  const merged = {
    ...current,
    ...patch,
    jobs: { ...current.jobs, ...(patch.jobs ?? {}) },
  };
  const validated = AutomationRuntimeSchema.parse(merged);
  const abs = statePath();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(validated, null, 2) + "\n", "utf8");
  return validated;
}

export async function patchAutomationJobRuntime(
  jobId: string,
  patch: Partial<AutomationRuntime["jobs"][string]>,
): Promise<AutomationRuntime> {
  const current = await readAutomationRuntime();
  const emptyJob = {
    status: "idle" as const,
    reason: null,
    startedAt: null,
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
  };
  return writeAutomationRuntime({
    jobs: {
      [jobId]: {
        ...emptyJob,
        ...(current.jobs[jobId] ?? {}),
        ...patch,
      },
    },
  });
}
