import "server-only";

import { listWikiMarkdownDocs, titleOfMarkdown } from "./wiki-docs";

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
  return titleOfMarkdown(content, path);
}

/** Case-insensitive substring search across wiki markdown pages. */
export async function searchWiki(query: string, limit = 12): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const needle = q.toLowerCase();
  const hits: SearchHit[] = [];
  const docs = await listWikiMarkdownDocs({ maxDocBytes: 1024 * 1024 }).catch(
    () => [],
  );

  for (const doc of docs) {
    if (!doc.text.toLowerCase().includes(needle)) continue;
    hits.push({
      path: doc.relPath,
      title: doc.title,
      snippet: makeSnippet(doc.text, q),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
