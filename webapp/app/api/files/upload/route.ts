import path from "node:path";
import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { WS_KEYS, isLikelyText, writeBytes, type WsKey } from "@/lib/files";

export const dynamic = "force-dynamic";

/**
 * multipart/form-data 업로드.
 * 필드:
 *   - ws: "wiki" | "raw" | "sessions"
 *   - dir: 워크스페이스 루트 기준 상대 폴더 (없으면 "")
 *   - files: 다중 파일
 */
export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return jsonError(`bad form: ${errorMessage(err)}`, 400);
  }

  const ws = String(form.get("ws") ?? "");
  const dir = String(form.get("dir") ?? "");
  if (!WS_KEYS.includes(ws as WsKey)) return jsonError("invalid ws", 400);

  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  if (files.length === 0) return jsonError("no files", 400);

  const written: { path: string; size: number; isText: boolean }[] = [];
  try {
    for (const file of files) {
      const safeName = path.basename(file.name).replace(/[\\/]/g, "_");
      const target = dir ? `${dir}/${safeName}` : safeName;
      const buf = Buffer.from(await file.arrayBuffer());
      await writeBytes(ws as WsKey, target, buf);
      written.push({
        path: target,
        size: buf.byteLength,
        isText: isLikelyText(target),
      });
    }
    return NextResponse.json({ ok: true, written });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
