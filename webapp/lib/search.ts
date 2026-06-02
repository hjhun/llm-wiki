import "server-only";

import { listDir, readText, type WsKey } from "./files";

export type SearchHit = {
  /** Path relative to the wiki root, e.g. `sources/articles/foo.md`. */
  path: string;
  title: string;
  snippet: string;
};

/** Build a one-line snippet centered on the first match of `query`. */
export function makeSnippet(content: string, query: string, radius = 60): string {
  const flat = content.replace(/\s+/g, " ");
  const idx = flat.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return flat.slice(0, radius * 2).trim();
  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + query.length + radius);
  return (
    (start > 0 ? "…" : "") +
    flat.slice(start, end).trim() +
    (end < flat.length ? "…" : "")
  );
}

/** Derive a page title from frontmatter `title:`, the first heading, or the path. */
export function titleOf(content: string, path: string): string {
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(content);
  if (frontmatter) {
    const m = /(^|\n)title:\s*(.+)/.exec(frontmatter[1]);
    if (m) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  const heading = /^#\s+(.+)$/m.exec(content);
  if (heading) return heading[1].trim();
  return path.split("/").pop() ?? path;
}

async function walkMarkdown(rel: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await listDir("wiki" as WsKey, rel);
  for (const entry of entries) {
    if (entry.path === "archive" || entry.path.startsWith("archive/")) continue;
    if (entry.kind === "dir") {
      out.push(...(await walkMarkdown(entry.path)));
    } else if (entry.path.endsWith(".md")) {
      out.push(entry.path);
    }
  }
  return out;
}

/** Case-insensitive substring search across wiki markdown pages. */
export async function searchWiki(query: string, limit = 12): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const files = await walkMarkdown("").catch(() => [] as string[]);
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  for (const path of files) {
    const content = await readText("wiki" as WsKey, path).catch(() => "");
    if (!content.toLowerCase().includes(needle)) continue;
    hits.push({
      path,
      title: titleOf(content, path),
      snippet: makeSnippet(content, q),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
