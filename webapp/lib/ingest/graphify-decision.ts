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

  const thresholds = cfg.graph.partialThresholds;
  const hits = [
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

  if (hits.length > 0) {
    return { enabled: true, reason: `strategy=auto; ${hits.join(", ")}` };
  }
  return {
    enabled: false,
    reason:
      `strategy=auto; workload below thresholds ` +
      `(leaves=${snapshot.leavesTotal}, files=${snapshot.filesTotal}, ` +
      `bytes=${snapshot.bytesTotal}, subChunks=${snapshot.subChunksTotal})`,
  };
}
