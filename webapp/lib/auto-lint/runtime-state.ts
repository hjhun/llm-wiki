import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PROJECT_ROOT } from "../paths";

const STATE_REL = "wiki/.progress/auto-lint/state.json";

export const AutoLintRuntimeSchema = z.object({
  status: z.enum(["idle", "running", "skipped", "disabled"]).default("idle"),
  reason: z.string().nullable().default(null),
  counter: z
    .object({
      value: z.number().int().min(0).default(0),
      threshold: z.number().int().min(1).default(10),
      lastIngestAt: z.string().nullable().default(null),
      lastLintAt: z.string().nullable().default(null),
      suggested: z.boolean().default(false),
    })
    .default({
      value: 0,
      threshold: 10,
      lastIngestAt: null,
      lastLintAt: null,
      suggested: false,
    }),
  startedAt: z.string().nullable().default(null),
  lastRunAt: z.string().nullable().default(null),
  lastResult: z
    .object({
      halt: z.enum(["normal", "error", "skipped", "noop"]),
      reason: z.string(),
      durationMs: z.number().int().min(0),
      source: z.enum(["cron", "manual"]),
      sessionPath: z.string().nullable(),
      reportPath: z.string().nullable(),
    })
    .nullable()
    .default(null),
  nextRunAt: z.string().nullable().default(null),
  cronEnabled: z.boolean().default(false),
});

export type AutoLintRuntime = z.infer<typeof AutoLintRuntimeSchema>;

export const EMPTY_RUNTIME: AutoLintRuntime = AutoLintRuntimeSchema.parse({});

function statePath(): string {
  return path.join(PROJECT_ROOT, STATE_REL);
}

export async function readRuntimeState(): Promise<AutoLintRuntime> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    return AutoLintRuntimeSchema.parse(JSON.parse(raw));
  } catch {
    return { ...EMPTY_RUNTIME };
  }
}

export async function writeRuntimeState(
  patch: Partial<AutoLintRuntime>,
): Promise<AutoLintRuntime> {
  const current = await readRuntimeState();
  const merged = { ...current, ...patch } as AutoLintRuntime;
  const validated = AutoLintRuntimeSchema.parse(merged);
  const abs = statePath();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, JSON.stringify(validated, null, 2) + "\n", "utf8");
  return validated;
}

export async function patchCounter(
  patch: Partial<AutoLintRuntime["counter"]>,
): Promise<AutoLintRuntime> {
  const current = await readRuntimeState();
  const nextCounter = { ...current.counter, ...patch };
  return writeRuntimeState({ counter: nextCounter });
}
