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
  /** Code/mixed leaves whose code files have raw-mirrored source pages. */
  codeLeavesWithOutputs: number;
  /** Code/mixed leaves missing raw-mirrored source pages for code files. */
  codeLeavesMissingOutputs: number;
  missingCodeLeaves: string[];
  codeFilePagesTotal: number;
  /** Code-looking raw files with raw-mirrored source pages. */
  codeFilePagesWithOutputs: number;
  /** Code-looking raw files missing raw-mirrored source pages or ingest state. */
  codeFilePagesMissing: number;
  missingCodeFiles: string[];
  codeDirectoryIndexesTotal: number;
  /** Legacy name: directory wiki/code pages are no longer required. */
  codeDirectoryIndexesWithOutputs: number;
  /** Legacy name: directory wiki/code pages are no longer required. */
  codeDirectoryIndexesMissing: number;
  missingCodeDirectories: string[];
  /** Number of raw-mirrored code source pages written. */
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
