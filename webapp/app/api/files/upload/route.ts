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
 *   - paths: 선택. files와 같은 순서의 상대 경로. 폴더 업로드 구조 보존용.
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
  const paths = form.getAll("paths").map((v) => String(v));

  const written: { path: string; size: number; isText: boolean }[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const safeRel = cleanUploadPath(paths[index], file.name);
      const target = dir ? `${dir.replace(/\/+$/, "")}/${safeRel}` : safeRel;
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

function cleanUploadPath(rel: string | undefined, fallbackName: string): string {
  const raw = (rel && rel.trim() ? rel : fallbackName).replace(/\\/g, "/");
  const parts = raw
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");

  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new Error("invalid upload path");
  }

  return parts
    .map((part) => path.basename(part).replace(/[\\/]/g, "_"))
    .join("/");
}
