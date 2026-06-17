export type ResolvedWikilink = {
  /** Visible chip label. */
  label: string;
  /**
   * Explorer href for path-style targets (e.g. `[[wiki/sources/foo]]`), or
   * null for title-only targets (e.g. `[[Some Concept]]`) which render as a
   * non-navigating chip because a title cannot be resolved to a file path.
   */
  href: string | null;
};

const WS_PREFIXES = ["wiki", "raw", "progress", "sessions"] as const;

/**
 * Resolve the inner text of a `[[...]]` wikilink. Supports an optional
 * `[[target|label]]` display label. Path-style targets (containing `/`) link
 * into the Explorer at the mirrored path; title-only targets have no href.
 */
export function resolveWikilink(inner: string): ResolvedWikilink | null {
  const [rawTarget, rawLabel] = inner.split("|");
  const target = (rawTarget ?? "").trim();
  if (!target) return null;
  const label = (rawLabel ?? rawTarget).trim() || target;

  if (!target.includes("/")) {
    return { label, href: null };
  }

  const normalized = target.replace(/^\/+/, "");
  const segments = normalized.split("/");
  let ws: string = "wiki";
  let rest = normalized;
  if ((WS_PREFIXES as readonly string[]).includes(segments[0])) {
    ws = segments[0];
    rest = segments.slice(1).join("/");
  }
  if (!rest) return { label, href: null };

  const lastSegment = rest.split("/").pop() ?? rest;
  if (!lastSegment.includes(".")) {
    rest = `${rest}.md`;
  }

  const href = `/explorer?ws=${ws}&path=${encodeURIComponent(rest)}`;
  return { label, href };
}
