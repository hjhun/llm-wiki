import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_ROOT } from "./paths";

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  role: ChatRole;
  ts: string; // HH:MM:SS
  agent?: string;
  content: string;
};

export type SessionMeta = {
  title: string;
  agent: string | null;
  created: string; // ISO
  updated: string; // ISO
};

export type SessionRef = {
  /** sessions/ 루트 기준 상대 경로 (POSIX, ex: 2026-05-16/130045_subject.md) */
  path: string;
  meta: SessionMeta;
};

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
/**
 * 메시지 헤더는 끝에 `<!-- lw-msg -->` 마커가 붙은 라인만 인식.
 * assistant 응답 본문에 `## [HH:MM:SS] user`처럼 보이는 텍스트가 섞여 있어도
 * 마커가 없으면 헤더로 오해하지 않는다.
 */
const MSG_MARKER = "<!-- lw-msg -->";
const MESSAGE_HEADER_RE =
  /^## \[(\d{2}:\d{2}:\d{2})\] (user|assistant|system)(?: \(([^)]+)\))?\s+<!-- lw-msg -->\s*$/;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function formatStamp(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function slugify(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s/\\]+/g, "-")
    .replace(/[^\p{L}\p{N}\-_.]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 50);
}

function escapeYaml(v: string): string {
  if (/[:#\n"']|^\s|\s$/.test(v)) return JSON.stringify(v);
  return v;
}

function parseFrontmatter(src: string): {
  meta: SessionMeta;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(src);
  if (!m) {
    return {
      meta: {
        title: "untitled",
        agent: null,
        created: new Date(0).toISOString(),
        updated: new Date(0).toISOString(),
      },
      body: src,
    };
  }
  const yamlText = m[1];
  const meta: Record<string, string> = {};
  for (const line of yamlText.split(/\r?\n/)) {
    const mm = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!mm) continue;
    let value = mm[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value.replace(/'/g, '"'));
      } catch {
        value = value.slice(1, -1);
      }
    }
    meta[mm[1]] = value;
  }
  return {
    meta: {
      title: meta.title ?? "untitled",
      agent: meta.agent ? meta.agent : null,
      created: meta.created ?? new Date(0).toISOString(),
      updated: meta.updated ?? meta.created ?? new Date(0).toISOString(),
    },
    body: src.slice(m[0].length),
  };
}

function renderFrontmatter(meta: SessionMeta): string {
  const lines = [
    "---",
    `title: ${escapeYaml(meta.title)}`,
    "type: chat-session",
    `agent: ${escapeYaml(meta.agent ?? "")}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

function normalizeTitle(input: string): string {
  return input.trim().replace(/\s+/g, " ").slice(0, 120) || "untitled";
}

async function allocateSessionPath(date: string, time: string, slug: string): Promise<{
  rel: string;
  abs: string;
}> {
  const base = slug || "untitled";
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? "" : `-${index + 1}`;
    const rel = `${date}/${time}_${base}${suffix}.md`;
    const abs = path.join(SESSIONS_ROOT, rel);
    try {
      const handle = await fs.open(abs, "wx");
      await handle.close();
      return { rel, abs };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error("could not allocate a unique session path");
}

export async function newSession(opts: {
  subject: string;
  agent: string | null;
}): Promise<SessionRef> {
  const now = new Date();
  const date = formatDate(now);
  const time = formatTime(now);
  const title = normalizeTitle(opts.subject);
  const slug = slugify(title) || "untitled";
  await fs.mkdir(path.join(SESSIONS_ROOT, date), { recursive: true });
  const { rel, abs } = await allocateSessionPath(date, time, slug);
  const meta: SessionMeta = {
    title,
    agent: opts.agent,
    created: now.toISOString(),
    updated: now.toISOString(),
  };
  await fs.writeFile(abs, renderFrontmatter(meta), "utf8");
  return { path: rel, meta };
}

async function walk(
  dir: string,
  root: string,
  out: string[],
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue; // .trash, .gitkeep 등
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(abs, root, out);
    } else if (e.isFile() && abs.endsWith(".md")) {
      out.push(toPosix(path.relative(root, abs)));
    }
  }
}

export async function listSessions(): Promise<SessionRef[]> {
  const found: string[] = [];
  await walk(SESSIONS_ROOT, SESSIONS_ROOT, found);
  const refs: SessionRef[] = [];
  for (const rel of found) {
    try {
      const abs = path.join(SESSIONS_ROOT, rel);
      const text = await fs.readFile(abs, "utf8");
      const { meta } = parseFrontmatter(text);
      refs.push({ path: rel, meta });
    } catch {
      // 무시
    }
  }
  refs.sort((a, b) => (a.meta.updated < b.meta.updated ? 1 : -1));
  return refs;
}

export function resolveSessionAbs(rel: string): string {
  const normalized = rel.replace(/^\/+/, "");
  const abs = path.resolve(SESSIONS_ROOT, normalized);
  const rootSlash = path.resolve(SESSIONS_ROOT) + path.sep;
  if (abs !== path.resolve(SESSIONS_ROOT) && !abs.startsWith(rootSlash)) {
    throw new Error(`path escapes sessions root: ${rel}`);
  }
  return abs;
}

export async function deleteSessions(paths: string[]): Promise<{
  deleted: string[];
}> {
  const deleted: string[] = [];
  for (const rel of paths) {
    if (!rel.endsWith(".md")) {
      throw new Error(`not a markdown session: ${rel}`);
    }
    const abs = resolveSessionAbs(rel);
    try {
      const st = await fs.stat(abs);
      if (!st.isFile()) continue;
      await fs.unlink(abs);
      deleted.push(rel);
      await fs.rmdir(path.dirname(abs)).catch(() => undefined);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  return { deleted };
}

export async function readSession(rel: string): Promise<{
  meta: SessionMeta;
  messages: ChatMessage[];
}> {
  const abs = resolveSessionAbs(rel);
  const text = await fs.readFile(abs, "utf8");
  const { meta, body } = parseFrontmatter(text);
  const messages: ChatMessage[] = [];
  const lines = body.split(/\r?\n/);
  let current: ChatMessage | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = MESSAGE_HEADER_RE.exec(line);
    if (m) {
      if (current) {
        current.content = buf.join("\n").trim();
        messages.push(current);
      }
      current = {
        ts: m[1],
        role: m[2] as ChatRole,
        agent: m[3] || undefined,
        content: "",
      };
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) {
    current.content = buf.join("\n").trim();
    messages.push(current);
  }
  return { meta, messages };
}

export async function renameSession(
  rel: string,
  title: string,
): Promise<SessionRef> {
  if (!rel.endsWith(".md")) {
    throw new Error(`not a markdown session: ${rel}`);
  }
  const abs = resolveSessionAbs(rel);
  const text = await fs.readFile(abs, "utf8");
  const { meta, body } = parseFrontmatter(text);
  const now = new Date();
  const newMeta: SessionMeta = {
    ...meta,
    title: normalizeTitle(title),
    updated: now.toISOString(),
  };
  await fs.writeFile(abs, renderFrontmatter(newMeta) + body, "utf8");
  return { path: rel, meta: newMeta };
}

/**
 * Returns only the last n messages from a session markdown file. Re-injecting
 * the full history into the prompt on every stateless CLI call makes prompt
 * size grow linearly with turn count and risks OOM, so the slim prompt builder
 * uses this helper. The implementation delegates to readSession — the file
 * itself is usually small (tens of KB), so the memory cost is negligible, and
 * full parsing keeps message-aligned slicing deterministic.
 */
export async function readSessionTail(
  rel: string,
  n: number,
): Promise<{ meta: SessionMeta; messages: ChatMessage[]; total: number }> {
  const { meta, messages } = await readSession(rel);
  const tail = n >= messages.length ? messages : messages.slice(-n);
  return { meta, messages: tail, total: messages.length };
}

export async function appendMessage(
  rel: string,
  role: ChatRole,
  content: string,
  agent?: string,
): Promise<ChatMessage> {
  const abs = resolveSessionAbs(rel);
  const text = await fs.readFile(abs, "utf8");
  const { meta, body } = parseFrontmatter(text);
  const now = new Date();
  const ts = formatStamp(now);
  const header = agent
    ? `## [${ts}] ${role} (${agent}) ${MSG_MARKER}`
    : `## [${ts}] ${role} ${MSG_MARKER}`;
  const block = `\n${header}\n\n${content.trim()}\n`;
  const newMeta: SessionMeta = {
    ...meta,
    updated: now.toISOString(),
  };
  const out = renderFrontmatter(newMeta) + body.replace(/^\n+/, "\n") + block;
  await fs.writeFile(abs, out, "utf8");
  return { role, ts, agent, content };
}
