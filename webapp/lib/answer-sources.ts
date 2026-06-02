/**
 * Derive the wiki/source pages an answer cites, straight from its markdown.
 *
 * The chat pipeline does not attach structured source metadata, so we scan the
 * rendered answer for references to `wiki/sources/...` pages (bare paths,
 * `[[wikilinks]]`, or markdown links) and present them as a "sources" footer.
 */

export type AnswerSource = {
  /** Path relative to the wiki root, e.g. `sources/articles/foo.md`. */
  path: string;
  /** Short label for the chip, e.g. `articles/foo`. */
  label: string;
};

const SOURCE_RE = /wiki\/sources\/[^\s)\]>"'`|]+/g;

function cleanPath(match: string): string {
  // Strip trailing punctuation that commonly abuts a path in prose.
  let path = match.replace(/[.,;:]+$/, "");
  if (!/\.[a-z0-9]+$/i.test(path)) {
    path = `${path}.md`;
  }
  return path;
}

export function extractAnswerSources(markdown: string): AnswerSource[] {
  if (!markdown) return [];
  const seen = new Set<string>();
  const out: AnswerSource[] = [];
  for (const match of markdown.match(SOURCE_RE) ?? []) {
    const full = cleanPath(match);
    if (seen.has(full)) continue;
    seen.add(full);
    // full is `wiki/sources/<rest>`; label drops the prefix + extension.
    const rest = full.replace(/^wiki\/sources\//, "").replace(/\.[a-z0-9]+$/i, "");
    out.push({ path: full, label: rest });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/** Explorer href for a derived source path (relative to wiki root). */
export function sourceHref(path: string): string {
  const rel = path.replace(/^wiki\//, "");
  return `/explorer?ws=wiki&path=${encodeURIComponent(rel)}`;
}
