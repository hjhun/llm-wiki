/**
 * Shared ingest-loop data shapes. Extracted from ingest-loop.ts so the pure
 * decision/classification helpers can depend on the types without importing
 * the stateful loop module (which would create a cycle). ingest-loop.ts
 * re-exports these names, so existing `@/lib/ingest-loop` imports keep working.
 */

export type StateSummary = {
  total: number;
  done: number;
  in_progress: number;
  partial: number;
  pending: number;
  error: number;
  active_leaf: string | null;
  active_subchunk: { id: string; status: string } | null;
};

export type ProgressSnapshot = {
  leavesTotal: number;
  leavesDone: number;
  sourcePagesMissing: number;
  missingSourceLeaves: string[];
  codeLeavesTotal: number;
  /** Legacy name: code/mixed leaves that are represented in ingest progress. */
  codeLeavesWithOutputs: number;
  /** Legacy name: kept for compatibility; Code Wiki pages are no longer required. */
  codeLeavesMissingOutputs: number;
  missingCodeLeaves: string[];
  codeFilePagesTotal: number;
  /** Legacy name: no longer tracks wiki/code file pages. */
  codeFilePagesWithOutputs: number;
  /** Code-looking raw files that have not been represented in ingest state. */
  codeFilePagesMissing: number;
  missingCodeFiles: string[];
  codeDirectoryIndexesTotal: number;
  /** Legacy name: directory wiki/code pages are no longer required. */
  codeDirectoryIndexesWithOutputs: number;
  /** Legacy name: directory wiki/code pages are no longer required. */
  codeDirectoryIndexesMissing: number;
  missingCodeDirectories: string[];
  /** Legacy wiki/code output counter; graphify is the primary code artifact now. */
  codeOutputsWritten: number;
  subChunksTotal: number;
  subChunksDone: number;
  filesTotal: number;
  bytesTotal: number;
  sourcePagesWritten: number;
  mergeDone: boolean;
  /** Count of parent dirs still queued in merge_pass.pending_parents. */
  mergePendingParents: number;
  /** Sorted POSIX paths of leaves whose status === "done". */
  doneLeaves: string[];
};

export type ProgressScope = {
  rawScope?: string | null;
};

export const EMPTY_SNAPSHOT: ProgressSnapshot = {
  leavesTotal: 0,
  leavesDone: 0,
  sourcePagesMissing: 0,
  missingSourceLeaves: [],
  codeLeavesTotal: 0,
  codeLeavesWithOutputs: 0,
  codeLeavesMissingOutputs: 0,
  missingCodeLeaves: [],
  codeFilePagesTotal: 0,
  codeFilePagesWithOutputs: 0,
  codeFilePagesMissing: 0,
  missingCodeFiles: [],
  codeDirectoryIndexesTotal: 0,
  codeDirectoryIndexesWithOutputs: 0,
  codeDirectoryIndexesMissing: 0,
  missingCodeDirectories: [],
  codeOutputsWritten: 0,
  subChunksTotal: 0,
  subChunksDone: 0,
  filesTotal: 0,
  bytesTotal: 0,
  sourcePagesWritten: 0,
  mergeDone: false,
  mergePendingParents: 0,
  doneLeaves: [],
};
