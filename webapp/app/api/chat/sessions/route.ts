import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { deleteSessions, listSessions } from "@/lib/sessions";

export const dynamic = "force-dynamic";

const DeleteBody = z.object({
  paths: z.array(z.string().min(1)).min(1).max(500),
});

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  try {
    const sessions = await listSessions();
    return NextResponse.json({ sessions });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

export async function DELETE(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = DeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }

  try {
    const result = await deleteSessions(parsed.data.paths);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
