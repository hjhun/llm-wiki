import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { renameEntry } from "@/lib/files";

const Body = z.object({
  ws: z.enum(["wiki", "raw", "sessions"]),
  from: z.string().min(1),
  to: z.string().min(1),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  try {
    await renameEntry(parsed.data.ws, parsed.data.from, parsed.data.to);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
