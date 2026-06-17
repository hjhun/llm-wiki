import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import {
  clearStopFlag,
  requestStopFlag,
  stopFlagExists,
} from "@/lib/ingest-loop";

/**
 * Per-session stop flag for the /ingest-loop driver in /api/chat/send/route.ts.
 *
 * Each loop polls its own session-scoped file between sub-chunk invocations
 * and halts when it is present. We use files (not in-memory abort controllers)
 * because:
 *   - it survives Next.js dev-server hot reloads,
 *   - it works across multiple worker processes (none today, but trivial to
 *     scale later),
 *   - the loop already inspects the same `progress/ingest/` directory
 *     between iterations, so adding one `fs.access` call costs nothing.
 *
 * GET returns whether the flag exists. DELETE clears it. POST creates it.
 * The currently running sub-chunk is *not* killed — the loop finishes the
 * in-flight CLI invocation cleanly and stops before the next one. This
 * matches the user-visible "Stop after current sub-chunk" semantics in the
 * chat UI.
 */
const StopQuery = z.object({
  sessionPath: z.string().min(1).optional(),
});

const StopBody = z.object({
  sessionPath: z.string().min(1),
});

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = StopQuery.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!parsed.success) return jsonError("invalid query", 400);
  return NextResponse.json({
    stopRequested: await stopFlagExists(parsed.data.sessionPath),
  });
}

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = StopBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("sessionPath required", 400);
  try {
    await requestStopFlag(parsed.data.sessionPath);
    return NextResponse.json({ ok: true, stopRequested: true });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

export async function DELETE(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = StopQuery.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!parsed.success) return jsonError("invalid query", 400);
  try {
    await clearStopFlag(parsed.data.sessionPath);
    return NextResponse.json({ ok: true, stopRequested: false });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
