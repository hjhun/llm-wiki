import { z } from "zod";

export const AutomationJobBody = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean(),
  template: z.enum([
    "youtube-summary",
    "github-gerrit-review",
    "email-sync",
    "custom",
  ]),
  prompt: z.string().max(20_000),
  schedule: z.object({
    mode: z.enum(["preset", "cron"]),
    preset: z.enum(["hourly", "daily", "weekly", "monthly"]),
    cron: z.string().min(1).max(120),
    time: z.object({
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    }),
    dayOfWeek: z.number().int().min(0).max(6),
    dayOfMonth: z.number().int().min(1).max(28),
    timezone: z.string().max(80),
  }),
  selectedAgents: z
    .array(z.enum(["codex", "claude", "gemini", "cline", "agy"]))
    .min(1),
  workspaceBasePath: z.string().max(2000),
  externalWritePolicy: z.enum(["draft-only"]),
  autoIngestAfterRun: z.boolean(),
});
