import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { PROJECT_ROOT } from "@/lib/paths";

/**
 * Stop flag for the /ingest-loop driver in /api/chat/send/route.ts.
 *
 * The loop polls for this file between sub-chunk invocations and halts when
 * it is present. We use a file (not an in-memory abort controller) because:
 *   - it survives Next.js dev-server hot reloads,
 *   - it works across multiple worker processes (none today, but trivial to
 *     scale later),
 *   - the loop already inspects the same `wiki/.progress/ingest/` directory
 *     between iterations, so adding one `fs.access` call costs nothing.
 *
 * GET returns whether the flag exists. DELETE clears it. POST creates it.
 * The currently running sub-chunk is *not* killed — the loop finishes the
 * in-flight CLI invocation cleanly and stops before the next one. This
 * matches the user-visible "Stop after current sub-chunk" semantics in the
 * chat UI.
 */
const STOP_FLAG_REL = "wiki/.progress/ingest/.stop";

function stopFlagAbs(): string {
  return path.join(PROJECT_ROOT, STOP_FLAG_REL);
}

async function flagExists(): Promise<boolean> {
  try {
    await fs.access(stopFlagAbs());
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  return NextResponse.json({ stopRequested: await flagExists() });
}

export async function POST() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  try {
    const abs = stopFlagAbs();
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, `${new Date().toISOString()}\n`, "utf8");
    return NextResponse.json({ ok: true, stopRequested: true });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

export async function DELETE() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  try {
    await fs.rm(stopFlagAbs(), { force: true });
    return NextResponse.json({ ok: true, stopRequested: false });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
