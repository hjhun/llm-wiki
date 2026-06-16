import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { getAutomationManager } from "@/lib/automation/manager";

export const dynamic = "force-dynamic";

/**
 * Reliability backstop for automation scheduling.
 *
 * The in-memory `setTimeout` scheduler only fires while the single server
 * process is continuously alive from arming until the fire instant. On
 * WSL/desktop the process is not reliably long-lived, so an external
 * watchdog/cron (`scripts/clio-automation-cron.sh`) hits this endpoint every
 * minute to force a reconcile: arm missing timers and replay any missed runs
 * (catch-up). Auth reuses `requireSession`, which accepts the local
 * `Authorization: Bearer <auth.cliToken>` used by the watchdog.
 */
export async function POST() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  try {
    const runtime = await getAutomationManager().tick();
    return NextResponse.json({ ok: true, runtime });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
