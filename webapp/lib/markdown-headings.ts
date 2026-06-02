export type MarkdownHeading = {
  depth: number;
  text: string;
  slug: string;
};

/**
 * Slugify heading text into an anchor id. Keeps Unicode letters (incl. Korean),
 * lowercases ASCII, and collapses everything else into single hyphens.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Extract ATX headings (`# ...`) from markdown, skipping fenced code blocks.
 * Slugs are deterministic (no dedup) so a ToC link always matches the id the
 * renderer assigns to the first heading with that text.
 */
export function extractHeadings(markdown: string): MarkdownHeading[] {
  if (!markdown) return [];
  const out: MarkdownHeading[] = [];
  let inFence = false;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const depth = match[1].length;
    const text = match[2].trim();
    if (!text) continue;
    out.push({ depth, text, slug: slugify(text) });
  }
  return out;
}
