import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { AutomationJobBody } from "@/lib/automation/schema";
import { runAutomationJob } from "@/lib/automation/runner";
import type { AutomationJob } from "@/lib/automation/types";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = AutomationJobBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }
  try {
    const job: AutomationJob = {
      id: `builder-${randomUUID()}`,
      ...parsed.data,
      enabled: false,
    };
    const result = await runAutomationJob({
      job,
      mode: "plan",
      source: "plan",
    });
    return NextResponse.json({ result });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
