import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../paths";

const STATE_REL = "wiki/.progress/auto-ingest/state.json";

export const AutoIngestRuntimeSchema = z.object({
  status: z.enum(["idle", "running", "skipped", "disabled"]).default("idle"),
  /** Last reason the trigger took its current status. */
  reason: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null),
  lastResult: z
    .object({
      halt: z.enum([
        "normal",
        "error",
        "stopped",
        "capped",
        "stalled",
        "skipped",
        "noop",
      ]),
      reason: z.string(),
      iterations: z.number().int().min(0),
      durationMs: z.number().int().min(0),
      anyProgress: z.boolean(),
      source: z.enum(["watch", "schedule", "manual"]),
      sessionPath: z.string().nullable(),
    })
    .nullable()
    .default(null),
  nextRunAt: z.string().nullable().default(null),
  /** Currently active mode. Null when disabled. */
  mode: z.enum(["watch", "schedule"]).nullable().default(null),
});

export type AutoIngestRuntime = z.infer<typeof AutoIngestRuntimeSchema>;

export const EMPTY_RUNTIME: AutoIngestRuntime = AutoIngestRuntimeSchema.parse({
  status: "disabled",
  reason: null,
  startedAt: null,
  lastRunAt: null,
  lastResult: null,
  nextRunAt: null,
  mode: null,
});

function statePath(): string {
  return path.join(PROJECT_ROOT, STATE_REL);
}

export async function readRuntimeState(): Promise<AutoIngestRuntime> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    return AutoIngestRuntimeSchema.parse(JSON.parse(raw));
  } catch {
    return { ...EMPTY_RUNTIME };
  }
}

export async function writeRuntimeState(
  patch: Partial<AutoIngestRuntime>,
): Promise<AutoIngestRuntime> {
  const current = await readRuntimeState();
  const merged = { ...current, ...patch } as AutoIngestRuntime;
  const validated = AutoIngestRuntimeSchema.parse(merged);
  const abs = statePath();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(validated, null, 2) + "\n", "utf8");
  return validated;
}
