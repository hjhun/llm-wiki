import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { emptyTrash } from "@/lib/files";

const Body = z.object({
  ws: z.enum(["wiki", "raw", "progress", "sessions"]),
  path: z.string().optional(),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  try {
    const result = await emptyTrash(parsed.data.ws, parsed.data.path);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
