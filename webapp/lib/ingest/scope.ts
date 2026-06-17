/**
 * Pure path/scope helpers for the ingest loop. A "raw scope" restricts an
 * /ingest-loop run to a subtree of `raw/`; these helpers normalize user input
 * and decide whether a given path is inside the active scope.
 *
 * Extracted verbatim from ingest-loop.ts. ingest-loop.ts re-exports
 * `normalizeRawScope`, so existing imports are unaffected.
 */

export function normalizePosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function normalizeRawScope(value?: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = normalizePosixPath(trimmed);
  if (normalized === "raw" || normalized.startsWith("raw/")) return normalized;
  return null;
}

export function pathMatchesScope(
  value: string,
  rawScope?: string | null,
): boolean {
  const scope = normalizeRawScope(rawScope);
  if (!scope) return true;
  const normalized = normalizePosixPath(value);
  return (
    normalized === scope ||
    normalized.startsWith(`${scope}/`) ||
    scope.startsWith(`${normalized}/`)
  );
}

export function mergeParentBlocksScopeCompletion(
  parent: string,
  rawScope?: string | null,
): boolean {
  const scope = normalizeRawScope(rawScope);
  if (!scope) return true;
  const normalized = normalizePosixPath(parent);
  return normalized === scope || normalized.startsWith(`${scope}/`);
}

export function pathSegments(relPath: string): string[] {
  return relPath.replace(/\\/g, "/").split("/").filter(Boolean);
}
