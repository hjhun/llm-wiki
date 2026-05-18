import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig, patchLocalConfig, type Config } from "@/lib/config";
import { getAutomationManager } from "@/lib/automation/manager";
import { validateCronExpression } from "@/lib/automation/cron";
import { AutomationJobBody } from "@/lib/automation/schema";

export const dynamic = "force-dynamic";

function validateJob(job: Config["automation"]["jobs"][number]): string | null {
  if (job.schedule.mode === "cron") {
    return validateCronExpression(job.schedule.cron);
  }
  return null;
}

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;

  try {
    const cfg = await loadConfig();
    return NextResponse.json({
      enabled: cfg.automation.enabled,
      maxConcurrentJobs: cfg.automation.maxConcurrentJobs,
      defaultWorkspaceBasePath: cfg.automation.defaultWorkspaceBasePath,
      jobs: cfg.automation.jobs,
    });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = AutomationJobBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }
  const validationError = validateJob({ id: "new", ...parsed.data });
  if (validationError) return jsonError(validationError, 400);

  try {
    const cfg = await loadConfig();
    const job: Config["automation"]["jobs"][number] = {
      id: randomUUID(),
      ...parsed.data,
    };
    await patchLocalConfig({
      automation: {
        ...cfg.automation,
        jobs: [...cfg.automation.jobs, job],
      },
    });
    await getAutomationManager().restart();
    return NextResponse.json({ job });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

const SettingsBody = z.object({
  enabled: z.boolean(),
  maxConcurrentJobs: z.number().int().min(1).max(8),
  defaultWorkspaceBasePath: z.string().max(2000),
});

export async function PUT(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = SettingsBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }

  try {
    const cfg = await loadConfig();
    const automation = {
      ...cfg.automation,
      enabled: parsed.data.enabled,
      maxConcurrentJobs: parsed.data.maxConcurrentJobs,
      defaultWorkspaceBasePath: parsed.data.defaultWorkspaceBasePath,
    };
    await patchLocalConfig({ automation });
    await getAutomationManager().restart();
    return NextResponse.json({ automation });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
