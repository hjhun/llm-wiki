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
  origin: "chat" | "background";
  created: string; // ISO
  updated: string; // ISO
};

export type SessionRef = {
  /** sessions/ 루트 기준 상대 경로 (POSIX, ex: 2026-05-16/130045_subject.md) */
  path: string;
  meta: SessionMeta;
};

export type SessionPromptContext = {
  body: string;
  totalMessages: number;
  injectedMessages: number;
  compactedMessages: number;
  fullContextBytes: number;
  promptContextBytes: number;
  maxBytes: number;
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
        origin: "chat",
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
  const title = meta.title ?? "untitled";
  return {
    meta: {
      title,
      agent: meta.agent ? meta.agent : null,
      origin:
        meta.origin === "background" || /^auto-(ingest|lint)\b/.test(title)
          ? "background"
          : "chat",
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
    `origin: ${meta.origin}`,
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

function byteLength(input: string): number {
  return Buffer.byteLength(input, "utf8");
}

function messageTag(m: ChatMessage): string {
  if (m.role === "user") return "User";
  if (m.role === "assistant") {
    return `Assistant${m.agent ? ` (${m.agent})` : ""}`;
  }
  return "System";
}

function renderPromptMessage(m: ChatMessage): string {
  return `${messageTag(m)} [${m.ts}]:\n${m.content}`;
}

function renderPromptMessages(messages: ChatMessage[]): string {
  return messages.map(renderPromptMessage).join("\n\n----\n\n");
}

function compactOneLine(input: string, maxChars: number): string {
  const clean = input.trim().replace(/\s+/g, " ");
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function renderCompactedPreviousConversation(
  messages: ChatMessage[],
  budgetBytes: number,
): string {
  if (messages.length === 0) return "";

  const heading = [
    "===== 이전대화 (compacted) =====",
    `Full earlier chat history exceeded the prompt context budget, so ${messages.length} older messages are represented as compact continuity memory.`,
    "Use this block to preserve user intent and decisions. Read the Active session log only if an exact old detail is essential.",
    "",
  ].join("\n");
  const footer = "\n===== 최근대화 (원문) =====";
  const entryBudget = Math.max(
    120,
    Math.min(2000, Math.floor(budgetBytes / messages.length) - 80),
  );
  const entries = messages.map((m) => {
    const compacted = compactOneLine(m.content, entryBudget);
    const suffix =
      compacted.length < m.content.trim().length
        ? ` (compacted from ${m.content.length} chars)`
        : "";
    return `- ${messageTag(m)} [${m.ts}]${suffix}: ${compacted}`;
  });

  const selected: string[] = [];
  let used = byteLength(heading) + byteLength(footer);
  let omitted = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entryBytes = byteLength(entries[i]) + 1;
    if (used + entryBytes > budgetBytes && selected.length > 0) {
      omitted = i + 1;
      break;
    }
    if (used + entryBytes > budgetBytes) {
      omitted = i + 1;
      break;
    }
    selected.unshift(entries[i]);
    used += entryBytes;
  }

  const omittedLine =
    omitted > 0
      ? `- (${omitted} older messages omitted from compacted memory to stay under budget.)\n`
      : "";
  return `${heading}${omittedLine}${selected.join("\n")}${footer}`;
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
  origin?: "chat" | "background";
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
    origin: opts.origin ?? "chat",
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
 * Builds the conversation block passed to stateless coding-agent CLIs.
 *
 * In slim mode we preserve the whole session verbatim while it fits inside
 * `maxBytes`. Only after crossing that threshold do we compact older turns
 * into an `이전대화` continuity block and keep the newest turns verbatim.
 */
export async function buildSessionPromptContext(
  rel: string,
  opts: {
    recentMessages: number;
    maxBytes: number;
    forceFull?: boolean;
  },
): Promise<SessionPromptContext> {
  const { messages } = await readSession(rel);
  const maxBytes = Math.max(16 * 1024, opts.maxBytes);
  const fullBody = renderPromptMessages(messages);
  const fullContextBytes = byteLength(fullBody);
  if (opts.forceFull || fullContextBytes <= maxBytes) {
    return {
      body: fullBody,
      totalMessages: messages.length,
      injectedMessages: messages.length,
      compactedMessages: 0,
      fullContextBytes,
      promptContextBytes: fullContextBytes,
      maxBytes,
    };
  }

  const compactBudget = Math.max(
    16 * 1024,
    Math.min(64 * 1024, Math.floor(maxBytes / 4)),
  );
  const maxRecent = Math.max(1, Math.min(opts.recentMessages, messages.length));
  let bestBody = "";
  let bestRecentCount = 1;
  for (let recentCount = maxRecent; recentCount >= 1; recentCount -= 1) {
    const previous = messages.slice(0, -recentCount);
    const recent = messages.slice(-recentCount);
    const compacted = renderCompactedPreviousConversation(
      previous,
      compactBudget,
    );
    const recentBody = renderPromptMessages(recent);
    const body = compacted ? `${compacted}\n\n${recentBody}` : recentBody;
    bestBody = body;
    bestRecentCount = recentCount;
    if (byteLength(body) <= maxBytes) break;
  }

  return {
    body: bestBody,
    totalMessages: messages.length,
    injectedMessages: bestRecentCount,
    compactedMessages: Math.max(0, messages.length - bestRecentCount),
    fullContextBytes,
    promptContextBytes: byteLength(bestBody),
    maxBytes,
  };
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
