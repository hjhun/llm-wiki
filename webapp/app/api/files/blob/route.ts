import path from "node:path";
import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { WS_KEYS, readBytes, type WsKey } from "@/lib/files";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const ws = searchParams.get("ws") ?? "";
  const rel = searchParams.get("path") ?? "";
  if (!WS_KEYS.includes(ws as WsKey)) return jsonError("invalid ws", 400);
  if (!rel) return jsonError("path required", 400);

  try {
    const bytes = await readBytes(ws as WsKey, rel);
    const ext = path.extname(rel).toLowerCase();
    const type = MIME[ext] ?? "application/octet-stream";
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": type,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return jsonError(errorMessage(err), 404);
  }
}
