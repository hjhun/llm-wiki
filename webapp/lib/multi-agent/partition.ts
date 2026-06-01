/**
 * Disjoint round-robin partitioning of actionable ingest leaves across parallel
 * workers, and the per-worker ASSIGNED LEAF SCOPE prompt block it produces.
 * This is the correctness core of the parallel ingest model — workers must get
 * non-overlapping leaf sets so they don't write duplicate pages — so it lives
 * in its own pure, unit-tested module.
 *
 * Extracted from multi-agent.ts.
 */

/**
 * Cap on the number of leaves listed in a single worker's ASSIGNED LEAF SCOPE
 * block. Each leaf path is one line in the prompt, so even a handful keeps the
 * prompt readable and the LLM focused on completing one of them per round per
 * the wiki-ingest one-sub-chunk rule.
 */
export const MAX_LEAVES_PER_WORKER = 4;

/**
 * Partition actionable (pending/partial/in_progress) leaves across workers as
 * disjoint round-robin buckets. A `null` actionableLeaves input (no
 * `.state.json` yet, or a state file with no actionable leaves) is the
 * bootstrap case: only worker 0 gets unrestricted scope so it can enumerate;
 * the rest receive empty assignments and will no-op exit. Each worker's bucket
 * is capped at MAX_LEAVES_PER_WORKER to keep prompts small; the loop revisits
 * the file on subsequent rounds, so untaken leaves come back into the partition
 * then.
 */
export function partitionActionableLeaves(
  workerCount: number,
  actionableLeaves: string[] | null,
): { assignments: (string[] | null)[]; hasState: boolean } {
  if (workerCount <= 0)
    return { assignments: [], hasState: actionableLeaves != null };
  if (actionableLeaves == null) {
    const assignments: (string[] | null)[] = new Array(workerCount).fill([]);
    assignments[0] = null;
    return { assignments, hasState: false };
  }
  const cap = workerCount * MAX_LEAVES_PER_WORKER;
  const trimmed =
    actionableLeaves.length > cap
      ? actionableLeaves.slice(0, cap)
      : actionableLeaves;
  const assignments: string[][] = Array.from({ length: workerCount }, () => []);
  for (let i = 0; i < trimmed.length; i += 1) {
    assignments[i % workerCount].push(trimmed[i]);
  }
  return { assignments, hasState: true };
}

export function buildLeafScopeReference(
  assignedLeaves: string[] | null,
  hasState: boolean,
): string {
  if (assignedLeaves === null) {
    if (!hasState) {
      return [
        "===== ASSIGNED LEAF SCOPE =====",
        "No prior wiki/.progress/ingest/.state.json exists. You are the bootstrap worker for this round:",
        "perform leaf enumeration and initial sub-chunk planning per wiki-ingest Step 1, then process at most one sub-chunk.",
        "Hold the global wiki/.progress/ingest/.lock only for the short enumeration/state-write critical section.",
      ].join("\n");
    }
    return [
      "===== ASSIGNED LEAF SCOPE =====",
      "Unrestricted: pick any pending sub-chunk or merge-pass parent under the current raw scope.",
      "Use a per-leaf lock at wiki/.progress/ingest/leaves/<sha1(leafPath)>.lock for sub-chunk work.",
      "Hold the global wiki/.progress/ingest/.lock only briefly during enumeration or state-write critical sections.",
    ].join("\n");
  }
  if (assignedLeaves.length === 0) {
    return [
      "===== ASSIGNED LEAF SCOPE =====",
      "Empty assignment: no leaves were partitioned to this worker for this round.",
      "Exit successfully without performing any ingest work. Do NOT acquire any lock, enumerate leaves, or write state.json.",
      "The Coordinator will reconcile on the next round.",
    ].join("\n");
  }
  return [
    "===== ASSIGNED LEAF SCOPE =====",
    "Process work only within these leaves this round (disjoint from other workers):",
    ...assignedLeaves.map((p) => `- ${p}`),
    "Acquire a per-leaf lock at wiki/.progress/ingest/leaves/<sha1(leafPath)>.lock before touching a leaf's sub-chunks; release it on exit.",
    "Hold the global wiki/.progress/ingest/.lock only briefly when reading/writing wiki/.progress/ingest/.state.json (treat it as a short state mutex, not a long-held run lock).",
    "Process at most one pending sub-chunk from one assigned leaf this invocation. If all assigned leaves are already done or locked by another worker, exit successfully.",
  ].join("\n");
}
