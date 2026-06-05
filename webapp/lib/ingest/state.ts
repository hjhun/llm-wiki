/**
 * Pure interpretation of the ingest `.state.json` document: turn the raw JSON
 * string into a status summary or a list of actionable leaf paths, and decide
 * whether a leaf belongs to a session or an active raw-scope. No filesystem,
 * no CLI — callers in ingest-loop.ts own the IO and pass the bytes in, so this
 * layer is fully unit-testable.
 *
 * Extracted from ingest-loop.ts, which re-exports `summarizeIngestState` so
 * existing `@/lib/ingest-loop` importers are unaffected.
 */

import { normalizeRawScope, pathMatchesScope } from "./scope";
import { collectLeafFiles } from "./leaf-classify";
import type { StateSummary } from "./types";

export function leafMatchesScope(
  leafPath: string,
  leaf: Record<string, unknown>,
  rawScope?: string | null,
): boolean {
  const scope = normalizeRawScope(rawScope);
  if (!scope) return true;
  if (pathMatchesScope(leafPath, scope)) return true;
  return collectLeafFiles(leafPath, leaf).some((filePath) =>
    pathMatchesScope(filePath, scope),
  );
}

export function stateLeafBelongsToSession(
  leaf: Record<string, unknown>,
  sessionPath: string,
): boolean {
  const lastSession =
    typeof leaf.last_session === "string" ? leaf.last_session : "";
  return (
    lastSession === sessionPath || lastSession === `sessions/${sessionPath}`
  );
}

export function summarizeIngestState(
  raw: string,
  options: { sessionPath?: string; rawScope?: string | null } = {},
): StateSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("leaves" in parsed) ||
    typeof (parsed as { leaves: unknown }).leaves !== "object" ||
    (parsed as { leaves: unknown }).leaves == null
  ) {
    return null;
  }
  const leaves = (parsed as { leaves: Record<string, unknown> }).leaves;
  const summary: StateSummary = {
    total: 0,
    done: 0,
    in_progress: 0,
    partial: 0,
    pending: 0,
    error: 0,
    active_leaf: null,
    active_subchunk: null,
  };
  for (const [leafPath, leafValue] of Object.entries(leaves)) {
    const leaf = (leafValue ?? {}) as Record<string, unknown>;
    if (
      options.sessionPath &&
      !stateLeafBelongsToSession(leaf, options.sessionPath)
    ) {
      continue;
    }
    if (!leafMatchesScope(leafPath, leaf, options.rawScope)) continue;
    const status = typeof leaf.status === "string" ? leaf.status : "pending";
    // A "stale" leaf is one whose source files vanished from disk
    // (wiki-ingest §Step 1). It is not actionable work, so exclude it entirely
    // — matching readProgressSnapshot — instead of letting it fall into the
    // "pending" bucket, where it would permanently block the loop's completion
    // check.
    if (status === "stale") continue;
    summary.total += 1;
    if (status === "done") summary.done += 1;
    else if (status === "in_progress") summary.in_progress += 1;
    else if (status === "partial") summary.partial += 1;
    else if (status === "error") summary.error += 1;
    else summary.pending += 1;
    if (summary.active_leaf == null && Array.isArray(leaf.sub_chunks)) {
      for (const sc of leaf.sub_chunks as Array<Record<string, unknown>>) {
        if (sc && typeof sc === "object" && sc.status === "in_progress") {
          summary.active_leaf = leafPath;
          summary.active_subchunk = {
            id: String(sc.id ?? "?"),
            status: "in_progress",
          };
          break;
        }
      }
    }
  }
  if (options.sessionPath && summary.total === 0) return null;
  return summary;
}

/**
 * Parse a `.state.json` string into the sorted list of actionable leaf paths
 * (status not done/stale/error, within scope). Returns null when the file is
 * unparseable or has no leaves yet — the latter signals "bootstrap" so a
 * worker performs Step 1 enumeration instead of receiving an empty assignment.
 */
export function parseStateJsonActionable(
  raw: string,
  rawScope: string | null | undefined,
): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("leaves" in parsed) ||
    typeof (parsed as { leaves: unknown }).leaves !== "object" ||
    (parsed as { leaves: unknown }).leaves == null
  ) {
    return null;
  }
  const leaves = (parsed as { leaves: Record<string, unknown> }).leaves;
  const actionable: string[] = [];
  for (const [leafPath, leafValue] of Object.entries(leaves)) {
    const leaf = (leafValue ?? {}) as Record<string, unknown>;
    const status = typeof leaf.status === "string" ? leaf.status : "pending";
    if (status === "done" || status === "stale" || status === "error") continue;
    if (!leafMatchesScope(leafPath, leaf, rawScope)) continue;
    actionable.push(leafPath);
  }
  // No actionable leaf within scope is the bootstrap signal: worker 0 gets
  // unrestricted scope and performs Step 1 enumeration. This covers three
  // cases that all need enumeration — an empty `leaves` map (never enumerated),
  // a scope whose subtree was never enumerated (so no recorded leaf matches it),
  // and a previously-done scope whose raw files changed. Returning `[]` here
  // instead would hand every worker an empty assignment, so the loop would
  // never enumerate `raw/` and would stall. Mirrors the stream-scan path in
  // readActionableLeafPaths, which already promotes empty results to null.
  if (actionable.length === 0) {
    return null;
  }
  actionable.sort();
  return actionable;
}
