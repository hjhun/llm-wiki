/**
 * Pure decision for whether an *incremental* (per-round) graphify update should
 * run during an ingest loop, based on the configured strategy and workload
 * thresholds. The final post-merge graphify is decided elsewhere; this only
 * governs the mid-loop partial refresh.
 *
 * Extracted from ingest-loop.ts. Pure: config + snapshot in, decision out.
 */

import type { Config } from "../config";
import type { ProgressSnapshot } from "./types";

function workloadThresholdHits(
  cfg: Config,
  snapshot: ProgressSnapshot,
): string[] {
  const thresholds = cfg.graph.partialThresholds;
  return [
    snapshot.leavesTotal >= thresholds.minLeaves
      ? `leaves ${snapshot.leavesTotal} >= ${thresholds.minLeaves}`
      : null,
    snapshot.filesTotal >= thresholds.minFiles
      ? `files ${snapshot.filesTotal} >= ${thresholds.minFiles}`
      : null,
    snapshot.bytesTotal >= thresholds.minBytes
      ? `bytes ${snapshot.bytesTotal} >= ${thresholds.minBytes}`
      : null,
    snapshot.subChunksTotal >= thresholds.minSubChunks
      ? `sub-chunks ${snapshot.subChunksTotal} >= ${thresholds.minSubChunks}`
      : null,
  ].filter((hit): hit is string => hit !== null);
}

function workloadSummary(snapshot: ProgressSnapshot): string {
  return (
    `leaves=${snapshot.leavesTotal}, files=${snapshot.filesTotal}, ` +
    `bytes=${snapshot.bytesTotal}, subChunks=${snapshot.subChunksTotal}`
  );
}

export function graphIncrementalDecision(
  cfg: Config,
  snapshot: ProgressSnapshot,
): { enabled: boolean; reason: string } {
  const strategy = cfg.graph.autoUpdateStrategy;
  if (strategy === "partialAndFinal") {
    return { enabled: true, reason: "strategy=partialAndFinal" };
  }
  if (strategy === "finalOnly") {
    return { enabled: false, reason: "strategy=finalOnly" };
  }

  const hits = workloadThresholdHits(cfg, snapshot);
  if (hits.length > 0) {
    return { enabled: true, reason: `strategy=auto; ${hits.join(", ")}` };
  }
  return {
    enabled: false,
    reason:
      `strategy=auto; workload below thresholds ` +
      `(${workloadSummary(snapshot)})`,
  };
}

export function ingestFinalMaintenanceDecision(
  cfg: Config,
  snapshot: ProgressSnapshot,
): { enabled: boolean; reason: string } {
  const strategy = cfg.graph.autoUpdateStrategy;
  if (strategy === "finalOnly") {
    return { enabled: true, reason: "strategy=finalOnly" };
  }
  if (strategy === "partialAndFinal") {
    return { enabled: true, reason: "strategy=partialAndFinal" };
  }

  const hits = workloadThresholdHits(cfg, snapshot);
  if (hits.length > 0) {
    return { enabled: true, reason: `strategy=auto; ${hits.join(", ")}` };
  }
  return {
    enabled: false,
    reason:
      `strategy=auto; final maintenance below thresholds ` +
      `(${workloadSummary(snapshot)})`,
  };
}

export function finalMaintenanceSkippedNote(reason: string): string {
  return (
    "\n\n---\n\n" +
    `[auto final skipped] qmd, final graph update, and mini-lint were ` +
    `skipped: ${reason}. Set graph.autoUpdateStrategy to finalOnly or ` +
    `partialAndFinal to force full final maintenance after every ingest.\n`
  );
}
