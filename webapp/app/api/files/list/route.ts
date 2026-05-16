import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { WS_KEYS, listDir, type WsKey } from "@/lib/files";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const ws = searchParams.get("ws") ?? "";
  const rel = searchParams.get("path") ?? "";
  if (!WS_KEYS.includes(ws as WsKey)) return jsonError("invalid ws", 400);

  try {
    const entries = await listDir(ws as WsKey, rel);
    return NextResponse.json({ ws, path: rel, entries });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
