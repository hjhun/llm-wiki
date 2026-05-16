import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { Stats } from "node:fs";
import {
  WORKSPACE_ROOTS,
  WorkspaceKey,
  resolveSafe,
} from "./paths";

export type WsKey = WorkspaceKey;
export const WS_KEYS: WsKey[] = ["wiki", "raw", "sessions"];

/**
 * 어떤 워크스페이스에서든 절대 노출/수정해서는 안 되는 경로 패턴.
 * (config/local.json은 워크스페이스 화이트리스트 자체에 안 들어가니 자동 차단)
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git(\/|$)/,
  /credentials?\.(json|yaml|yml|env)$/i,
  /\.pem$/i,
  /\.key$/i,
];

function isSensitive(rel: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(rel));
}

function isReadOnlyWorkspace(ws: WsKey): boolean {
  // CLAUDE.md 규약: sessions/는 시스템이 append-only로 관리. UI에서는 수정 금지.
  // raw/는 사용자가 자료를 떨구는 곳이라 추가/삭제 허용. wiki/도 동일.
  return ws === "sessions";
}

export type EntryKind = "dir" | "file";

export type Entry = {
  name: string;
  kind: EntryKind;
  size: number;
  mtime: number;
  /** 워크스페이스 루트 기준 상대 경로 (POSIX) */
  path: string;
};

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** ws/path 한 쌍을 안전한 절대 경로로 해석. 민감 파일이면 차단. */
export function resolveEntry(ws: WsKey, rel: string): string {
  if (!WS_KEYS.includes(ws)) throw new Error(`unknown workspace: ${ws}`);
  const normalized = rel.replace(/^\/+/, "");
  if (isSensitive(normalized)) {
    throw new Error(`access denied (sensitive): ${normalized}`);
  }
  return resolveSafe(ws, normalized);
}

async function ensureDirForFile(abs: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
}

async function statSafe(abs: string): Promise<Stats | null> {
  try {
    return await fs.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listDir(
  ws: WsKey,
  rel: string,
): Promise<Entry[]> {
  const abs = resolveEntry(ws, rel);
  const st = await statSafe(abs);
  if (!st) return [];
  if (!st.isDirectory()) throw new Error("not a directory");
  const names = await fs.readdir(abs);

  const out: Entry[] = [];
  for (const name of names) {
    const childRel = toPosix(path.join(rel, name));
    if (isSensitive(childRel)) continue;
    const childAbs = path.join(abs, name);
    const cs = await statSafe(childAbs);
    if (!cs) continue;
    out.push({
      name,
      kind: cs.isDirectory() ? "dir" : "file",
      size: cs.size,
      mtime: Math.floor(cs.mtimeMs),
      path: childRel,
    });
  }
  // 디렉토리 먼저, 그 다음 파일. 각각 이름순.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

const TEXT_EXTS = new Set([
  ".md", ".mdx", ".txt", ".json", ".jsonc", ".yaml", ".yml",
  ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".csv", ".tsv",
  ".log", ".toml", ".ini", ".env", ".sh", ".py", ".go", ".rs",
  ".sql", ".xml", ".svg",
]);

export function isLikelyText(rel: string): boolean {
  const ext = path.extname(rel).toLowerCase();
  return TEXT_EXTS.has(ext);
}

export async function readText(ws: WsKey, rel: string): Promise<string> {
  const abs = resolveEntry(ws, rel);
  return fs.readFile(abs, "utf8");
}

export async function readBytes(ws: WsKey, rel: string): Promise<Buffer> {
  const abs = resolveEntry(ws, rel);
  return fs.readFile(abs);
}

export async function writeText(
  ws: WsKey,
  rel: string,
  content: string,
): Promise<void> {
  if (isReadOnlyWorkspace(ws)) {
    throw new Error(`workspace is read-only via UI: ${ws}`);
  }
  const abs = resolveEntry(ws, rel);
  await ensureDirForFile(abs);
  await fs.writeFile(abs, content, "utf8");
}

export async function writeBytes(
  ws: WsKey,
  rel: string,
  bytes: Buffer,
): Promise<void> {
  if (isReadOnlyWorkspace(ws)) {
    throw new Error(`workspace is read-only via UI: ${ws}`);
  }
  const abs = resolveEntry(ws, rel);
  await ensureDirForFile(abs);
  await fs.writeFile(abs, bytes);
}

export async function createEntry(
  ws: WsKey,
  rel: string,
  kind: EntryKind,
): Promise<void> {
  if (isReadOnlyWorkspace(ws)) {
    throw new Error(`workspace is read-only via UI: ${ws}`);
  }
  const abs = resolveEntry(ws, rel);
  const st = await statSafe(abs);
  if (st) throw new Error("already exists");
  if (kind === "dir") {
    await fs.mkdir(abs, { recursive: true });
  } else {
    await ensureDirForFile(abs);
    await fs.writeFile(abs, "", "utf8");
  }
}

export async function renameEntry(
  ws: WsKey,
  fromRel: string,
  toRel: string,
): Promise<void> {
  if (isReadOnlyWorkspace(ws)) {
    throw new Error(`workspace is read-only via UI: ${ws}`);
  }
  const fromAbs = resolveEntry(ws, fromRel);
  const toAbs = resolveEntry(ws, toRel);
  if (!(await statSafe(fromAbs))) throw new Error("source not found");
  if (await statSafe(toAbs)) throw new Error("target already exists");
  await ensureDirForFile(toAbs);
  await fs.rename(fromAbs, toAbs);
}

/**
 * UI 삭제 = 워크스페이스 안의 `.trash/<timestamp>_<basename>`으로 이동.
 * (위키의 `archive/`는 LLM 운영 의미상 폐기 폴더로 별도 사용.)
 */
export async function moveToTrash(ws: WsKey, rel: string): Promise<string> {
  if (isReadOnlyWorkspace(ws)) {
    throw new Error(`workspace is read-only via UI: ${ws}`);
  }
  const abs = resolveEntry(ws, rel);
  if (!(await statSafe(abs))) throw new Error("not found");

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "");
  const trashRel = `.trash/${stamp}_${path.basename(rel)}`;
  const trashAbs = resolveEntry(ws, trashRel);
  await ensureDirForFile(trashAbs);
  await fs.rename(abs, trashAbs);
  return trashRel;
}

export function getWorkspaceRoot(ws: WsKey): string {
  return WORKSPACE_ROOTS[ws];
}
