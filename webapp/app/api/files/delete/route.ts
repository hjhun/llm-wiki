import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { moveToTrash } from "@/lib/files";

const Body = z.object({
  ws: z.enum(["wiki", "raw", "sessions"]),
  path: z.string().min(1),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  try {
    const trashPath = await moveToTrash(parsed.data.ws, parsed.data.path);
    return NextResponse.json({ ok: true, trashPath });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
