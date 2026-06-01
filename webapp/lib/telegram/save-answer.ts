import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT, WIKI_ROOT } from "../paths";
import type { PublicQueryVisibleSource } from "../public-query";

/**
 * `trusted` permission lets a Telegram chat preserve an answer in the
 * wiki via the same path the chat UI's "Save to wiki/answers/" button
 * uses. The shape mirrors wiki-query's Step 4 (Feedback into the Wiki)
 * so the generated page is indistinguishable from one written by the
 * Coding Agent CLI.
 */

const SLUG_MAX = 60;

function slugify(input: string): string {
  const lowered = input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[　\s]+/g, " ")
    .trim();
  const ascii = lowered
    .replace(/[^a-z0-9가-힣 _-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return ascii.slice(0, SLUG_MAX) || "untitled";
}

async function uniqueSlug(slug: string): Promise<string> {
  const dir = path.join(WIKI_ROOT, "answers");
  for (let i = 0; i < 50; i += 1) {
    const candidate = i === 0 ? slug : `${slug}-${i + 1}`;
    const abs = path.join(dir, `${candidate}.md`);
    try {
      await fs.access(abs);
    } catch {
      return candidate;
    }
  }
  return `${slug}-${Date.now()}`;
}

function fmtDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtDateTime(date: Date): string {
  const time =
    String(date.getHours()).padStart(2, "0") +
    ":" +
    String(date.getMinutes()).padStart(2, "0");
  return `${fmtDate(date)} ${time}`;
}

function buildSourceList(sources: PublicQueryVisibleSource[]): string {
  if (sources.length === 0) return "[]";
  const items = sources
    .map((s) => s.path.replace(/^\/+/, "").replace(/\.md$/, ""))
    .map((p) => `wiki/${p.startsWith("wiki/") ? p.slice("wiki/".length) : p}`)
    .map((p) => `"${p}"`);
  return `[${items.join(", ")}]`;
}

function bodyText(input: SaveAnswerInput): string {
  const lines: string[] = [];
  lines.push(`# ${input.question.trim() || "Untitled"}`);
  lines.push("");
  lines.push(input.answer.trim());
  if (input.sources.length > 0) {
    lines.push("");
    lines.push("## Cited pages");
    for (const s of input.sources) {
      const ref = s.path.replace(/\.md$/, "");
      const label = s.title || ref;
      lines.push(`- [[${ref}|${label}]]`);
    }
  }
  return lines.join("\n");
}

export type SaveAnswerInput = {
  question: string;
  answer: string;
  sources: PublicQueryVisibleSource[];
  chatId: number;
};

export type SaveAnswerResult = {
  relPath: string;
  slug: string;
};

export async function saveAnswerToWiki(
  input: SaveAnswerInput,
): Promise<SaveAnswerResult> {
  const slugBase = slugify(input.question);
  const slug = await uniqueSlug(slugBase);
  const now = new Date();
  const frontmatter = [
    "---",
    `title: ${input.question.replace(/\n+/g, " ").trim() || "Untitled"}`,
    "type: answer",
    "tags: [telegram]",
    `sources: ${buildSourceList(input.sources)}`,
    `question: ${JSON.stringify(input.question)}`,
    `asked_at: ${fmtDateTime(now)}`,
    `updated: ${fmtDate(now)}`,
    `telegram_chat_id: ${input.chatId}`,
    "---",
    "",
  ].join("\n");
  const rel = path.join("wiki", "answers", `${slug}.md`);
  const abs = path.join(PROJECT_ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${frontmatter}${bodyText(input)}\n`, "utf8");

  // Append a log entry mirroring wiki-query's Step 4 § log shape.
  const logPath = path.join(WIKI_ROOT, "log.md");
  const logEntry = [
    "",
    `## [${fmtDateTime(now)}] query | telegram chat ${input.chatId}`,
    `- Feedback: \`${rel.split(path.sep).join("/")}\``,
    input.sources.length > 0
      ? `- Citations: ${input.sources
          .map((s) => `\`${s.path}\``)
          .join(", ")}`
      : "- Citations: (none)",
    "",
  ].join("\n");
  await fs
    .appendFile(logPath, logEntry, "utf8")
    .catch(() => undefined);
  return { relPath: rel.split(path.sep).join("/"), slug };
}
