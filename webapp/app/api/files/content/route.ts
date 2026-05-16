import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import {
  WS_KEYS,
  isLikelyText,
  readText,
  writeText,
  type WsKey,
} from "@/lib/files";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const ws = searchParams.get("ws") ?? "";
  const rel = searchParams.get("path") ?? "";
  if (!WS_KEYS.includes(ws as WsKey)) return jsonError("invalid ws", 400);
  if (!rel) return jsonError("path required", 400);

  try {
    if (!isLikelyText(rel)) {
      return jsonError("not a text file (use /api/files/blob)", 415);
    }
    const content = await readText(ws as WsKey, rel);
    return NextResponse.json({ ws, path: rel, content });
  } catch (err) {
    return jsonError(errorMessage(err), 404);
  }
}

const WriteBody = z.object({
  ws: z.enum(["wiki", "raw", "sessions"]),
  path: z.string().min(1),
  content: z.string(),
});

export async function PUT(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = WriteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("invalid body", 400);

  try {
    await writeText(parsed.data.ws, parsed.data.path, parsed.data.content);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
