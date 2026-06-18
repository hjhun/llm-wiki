/**
 * Deterministic `wiki/index.md` reconciliation.
 *
 * `wiki/index.md` is the concept's retrieval backbone — query reads it first to
 * find candidate pages, so a page missing from it is effectively undiscoverable
 * (the RAG-failure mode the wiki is meant to avoid). Ingest is supposed to
 * catalog every synthesis page during the merge pass, but that mechanical
 * bookkeeping is exactly what an LLM forgets: a probe ingest finished "normal"
 * while lint flagged 16 pages missing from the index.
 *
 * This module fills that gap deterministically — no LLM call. It adds any
 * managed synthesis page (entities, concepts, code, answers, comparisons, lint
 * reports) that is missing from its category, with a summary derived from the
 * page body, and sorts each managed category. It is **additive and
 * non-destructive**: existing entries (including hand/LLM-written summaries) are
 * preserved verbatim, and when nothing needs adding the file is left
 * byte-for-byte unchanged. Individual source pages are intentionally excluded —
 * they have their own catalog at `wiki/sources/index.md`.
 *
 * The pure functions are exported for unit testing; `reconcileWikiIndex` does
 * the filesystem IO.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, WIKI_ROOT } from "../paths";

export type IndexPage = {
  /** Repo-relative path without extension, e.g. "wiki/entities/lyon". */
  relNoExt: string;
  title: string;
  category: string;
  summary: string;
};

/** Frontmatter `type` -> index category. Types not here are not cataloged in
 * the main index (sources/maps have their own catalogs; index/log are nav). */
const TYPE_TO_CATEGORY: Record<string, string> = {
  entity: "Entities",
  concept: "Concepts",
  code: "Code",
  architecture: "Code",
  answer: "Answers",
  comparison: "Comparisons",
  analysis: "Comparisons",
  lint: "Lint Reports",
};

const MANAGED_CATEGORIES = new Set(Object.values(TYPE_TO_CATEGORY));

/** Canonical ordering used only when inserting a managed section that does not
 * yet exist in the file. Mirrors CLAUDE.md §5.1. */
const CATEGORY_ORDER = [
  "Entities",
  "Concepts",
  "Code",
  "Sources",
  "Maps",
  "Answers",
  "Comparisons",
  "Lint Reports",
  "Graph",
];

export function categoryForType(type: string | null | undefined): string | null {
  if (!type) return null;
  return TYPE_TO_CATEGORY[type.trim().toLowerCase()] ?? null;
}

/** Minimal frontmatter scalar reader + body splitter. */
export function splitFrontmatter(content: string): {
  scalar: (name: string) => string | null;
  body: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  const fm = m ? m[1] : "";
  const body = m ? content.slice(m[0].length) : content;
  return {
    scalar: (name) => {
      const sm = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(fm);
      return sm ? sm[1].trim().replace(/^["']|["']$/g, "") : null;
    },
    body,
  };
}

/**
 * Derive a one-line index summary from a page body: the first real prose
 * sentence (skipping headings, callouts, tables, and list lines), wikilinks
 * flattened to their display text, capped at ~140 chars. Falls back to title.
 */
export function deriveSummary(body: string, title: string): string {
  const lines = body.split(/\r?\n/);
  const paragraphs: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) {
      paragraphs.push(buf.join(" "));
      buf = [];
    }
  };
  for (const line of lines) {
    const t = line.trim();
    if (
      t === "" ||
      t.startsWith("#") ||
      t.startsWith(">") ||
      t.startsWith("|") ||
      t.startsWith("-") ||
      t.startsWith("*") ||
      t.startsWith("```")
    ) {
      flush();
      continue;
    }
    buf.push(t);
  }
  flush();
  const first = paragraphs.find((p) => p.length > 0) ?? title;
  const sentence = first.split(/(?<=[.!?。])\s/)[0] ?? first;
  const flattened = sentence
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, p1, p2) =>
      (p2 ?? String(p1).split("/").pop() ?? "").trim(),
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!flattened) return title;
  return flattened.length > 140
    ? `${flattened.slice(0, 137).trimEnd()}…`
    : flattened;
}

type Section = { header: string; category: string; body: string[] };

/** Split index.md into the preamble (everything before the first `## `) and
 * an ordered list of category sections (header + the lines beneath it). */
export function parseIndex(content: string): {
  preamble: string[];
  sections: Section[];
} {
  const lines = content.split(/\r?\n/);
  const preamble: string[] = [];
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = { header: line, category: m[1].trim(), body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, sections };
}

/**
 * Reconcile the managed category sections of an index.md string against the
 * given pages. Additive: existing `- [[link]] …` lines are preserved verbatim,
 * only missing pages are appended, and each managed section is sorted. Returns
 * the original content unchanged (and `added: []`) when nothing was missing, so
 * a no-op never rewrites the file.
 */
export function reconcileIndexContent(
  content: string,
  pages: IndexPage[],
): { content: string; added: IndexPage[] } {
  const { preamble, sections } = parseIndex(content);
  const byCategory = new Map<string, IndexPage[]>();
  for (const page of pages) {
    if (!MANAGED_CATEGORIES.has(page.category)) continue;
    const list = byCategory.get(page.category) ?? [];
    list.push(page);
    byCategory.set(page.category, list);
  }

  const added: IndexPage[] = [];

  const ensureSection = (category: string): Section => {
    const existing = sections.find((s) => s.category === category);
    if (existing) return existing;
    const section: Section = {
      header: `## ${category}`,
      category,
      body: ["", "(empty for now)", ""],
    };
    const rank = CATEGORY_ORDER.indexOf(category);
    let insertAt = sections.length;
    for (let i = 0; i < sections.length; i += 1) {
      if (CATEGORY_ORDER.indexOf(sections[i].category) > rank) {
        insertAt = i;
        break;
      }
    }
    sections.splice(insertAt, 0, section);
    return section;
  };

  for (const [category, catPages] of byCategory) {
    const section = ensureSection(category);
    const presentLinks = new Set<string>();
    const entryLines: string[] = [];
    for (const line of section.body) {
      const lm = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/.exec(line);
      if (lm && line.trim().startsWith("-")) {
        presentLinks.add(lm[1].trim());
        entryLines.push(line.trimEnd());
      }
    }
    for (const page of catPages) {
      if (presentLinks.has(page.relNoExt)) continue;
      entryLines.push(`- [[${page.relNoExt}]] — ${page.summary}`);
      presentLinks.add(page.relNoExt);
      added.push(page);
    }
    entryLines.sort((a, b) => a.localeCompare(b));
    section.body = entryLines.length
      ? ["", ...entryLines, ""]
      : ["", "(empty for now)", ""];
  }

  if (added.length === 0) return { content, added: [] };

  const today = new Date().toISOString().slice(0, 10);
  const renderedPreamble = preamble.map((line) =>
    /^updated:\s*/.test(line) ? `updated: ${today}` : line,
  );
  const out = [...renderedPreamble];
  for (const section of sections) {
    out.push(section.header, ...section.body);
  }
  const rendered = `${out.join("\n").replace(/\s+$/, "")}\n`;
  return { content: rendered, added };
}

async function walkMarkdown(dir: string, acc: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip generated/non-page trees.
      if (["graph", "archive", ".progress"].includes(entry.name)) continue;
      await walkMarkdown(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      acc.push(full);
    }
  }
}

/** Collect the managed synthesis pages under wiki/ as IndexPage entries. */
export async function collectIndexPages(wikiRoot = WIKI_ROOT): Promise<IndexPage[]> {
  const files: string[] = [];
  await walkMarkdown(wikiRoot, files);
  const pages: IndexPage[] = [];
  for (const file of files) {
    const content = await fs.readFile(file, "utf8").catch(() => null);
    if (content == null) continue;
    const { scalar, body } = splitFrontmatter(content);
    const category = categoryForType(scalar("type"));
    if (!category) continue;
    const relNoExt = path
      .relative(PROJECT_ROOT, file)
      .replace(/\\/g, "/")
      .replace(/\.md$/, "");
    const title = scalar("title") ?? path.basename(relNoExt);
    pages.push({ relNoExt, title, category, summary: deriveSummary(body, title) });
  }
  return pages;
}

export type ReconcileResult = {
  ran: boolean;
  added: number;
  addedPaths: string[];
  note: string;
};

/**
 * Deterministically reconcile wiki/index.md so every managed synthesis page is
 * cataloged. Writes only when something was added. Safe to call at ingest loop
 * exit; never throws (filesystem errors degrade to a soft note).
 */
export async function reconcileWikiIndex(
  options: { wikiRoot?: string } = {},
): Promise<ReconcileResult> {
  const wikiRoot = options.wikiRoot ?? WIKI_ROOT;
  const indexPath = path.join(wikiRoot, "index.md");
  try {
    const content = await fs.readFile(indexPath, "utf8");
    const pages = await collectIndexPages(wikiRoot);
    const { content: next, added } = reconcileIndexContent(content, pages);
    if (added.length === 0) {
      return { ran: true, added: 0, addedPaths: [], note: "" };
    }
    await fs.writeFile(indexPath, next, "utf8");
    const addedPaths = added.map((p) => p.relNoExt);
    return {
      ran: true,
      added: added.length,
      addedPaths,
      note:
        `\n\n---\n\n[index reconcile] wiki/index.md에 카탈로그 누락 ` +
        `${added.length}개 페이지를 결정적으로 추가했습니다 ` +
        `(${addedPaths.slice(0, 6).join(", ")}${addedPaths.length > 6 ? " 외" : ""}).\n`,
    };
  } catch (err) {
    return {
      ran: false,
      added: 0,
      addedPaths: [],
      note:
        `\n\n---\n\n[index reconcile] 건너뜀: ${(err as Error).message}\n`,
    };
  }
}
