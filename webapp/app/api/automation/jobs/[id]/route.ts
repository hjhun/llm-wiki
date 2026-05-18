import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig, patchLocalConfig, type Config } from "@/lib/config";
import { getAutomationManager } from "@/lib/automation/manager";
import { validateCronExpression } from "@/lib/automation/cron";
import { AutomationJobBody } from "@/lib/automation/schema";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Params) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const { id } = await ctx.params;
  const cfg = await loadConfig();
  const job = cfg.automation.jobs.find((candidate) => candidate.id === id);
  if (!job) return jsonError("job not found", 404);
  return NextResponse.json({ job });
}

export async function PUT(req: Request, ctx: Params) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const { id } = await ctx.params;
  const parsed = AutomationJobBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }
  if (parsed.data.schedule.mode === "cron") {
    const validationError = validateCronExpression(parsed.data.schedule.cron);
    if (validationError) return jsonError(validationError, 400);
  }

  try {
    const cfg = await loadConfig();
    let found = false;
    const jobs: Config["automation"]["jobs"] = cfg.automation.jobs.map((job) => {
      if (job.id !== id) return job;
      found = true;
      return { id, ...parsed.data };
    });
    if (!found) return jsonError("job not found", 404);
    await patchLocalConfig({
      automation: { ...cfg.automation, jobs },
    });
    await getAutomationManager().restart();
    return NextResponse.json({ job: jobs.find((job) => job.id === id) });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

export async function DELETE(_req: Request, ctx: Params) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const { id } = await ctx.params;
  try {
    const cfg = await loadConfig();
    const jobs = cfg.automation.jobs.filter((job) => job.id !== id);
    if (jobs.length === cfg.automation.jobs.length) {
      return jsonError("job not found", 404);
    }
    await patchLocalConfig({
      automation: { ...cfg.automation, jobs },
    });
    await getAutomationManager().restart();
    return NextResponse.json({ deleted: id });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
