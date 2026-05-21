import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { WS_KEYS, resolveEntry, type WsKey } from "@/lib/files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const OFFICE_EXTS = new Set([
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".odt",
  ".odp",
  ".ods",
  ".rtf",
]);

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const { searchParams } = new URL(req.url);
  const ws = searchParams.get("ws") ?? "";
  const rel = searchParams.get("path") ?? "";
  if (!WS_KEYS.includes(ws as WsKey)) return jsonError("invalid ws", 400);
  if (!rel) return jsonError("path required", 400);

  const ext = path.extname(rel).toLowerCase();
  if (!OFFICE_EXTS.has(ext)) {
    return jsonError("preview conversion is not supported for this file type", 415);
  }

  try {
    const abs = resolveEntry(ws as WsKey, rel);
    const pdf = await convertOfficeToPdf(abs);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}

async function convertOfficeToPdf(abs: string): Promise<Buffer> {
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error("not a file");

  const executable = await findLibreOffice();
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}`)
    .digest("hex");
  const cacheDir = path.join(os.tmpdir(), "llm-wiki-preview-cache", cacheKey);
  const outputPath = path.join(
    cacheDir,
    `${path.basename(abs, path.extname(abs))}.pdf`,
  );

  try {
    return await fs.readFile(outputPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await fs.mkdir(cacheDir, { recursive: true });
  await execFileAsync(
    executable,
    [
      "--headless",
      "--nologo",
      "--nofirststartwizard",
      `-env:UserInstallation=${pathToFileURL(path.join(cacheDir, "lo-profile")).href}`,
      "--convert-to",
      "pdf",
      "--outdir",
      cacheDir,
      abs,
    ],
    {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );

  try {
    return await fs.readFile(outputPath);
  } catch {
    throw new Error("preview conversion did not produce a PDF");
  }
}

async function findLibreOffice(): Promise<string> {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    "soffice",
    "libreoffice",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], {
        timeout: 5_000,
        maxBuffer: 1024 * 128,
      });
      return candidate;
    } catch {
      // Try the next known executable name.
    }
  }

  throw new Error("LibreOffice/soffice is not installed, so this file can only be downloaded");
}
