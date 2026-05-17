import fs from "node:fs/promises";
import { WIKI_LOG_PATH } from "../paths";

const TAIL_BYTES = 64 * 1024;

export type IngestSinceLastLint = {
  /** Number of `ingest |` entries newer than the most recent `lint |` entry. */
  count: number;
  /** Timestamp string from the most recent ingest entry, if any. */
  lastIngestAt: string | null;
  /** Timestamp string from the most recent lint entry, if any. */
  lastLintAt: string | null;
};

const HEADING_RE = /^## \[([^\]]+)\] (ingest|lint) \|/;

/**
 * Reads the tail of wiki/log.md and counts how many `ingest |` entries appear
 * after the most recent `lint |` entry. If no lint entry exists in the tail,
 * counts all ingest entries that are visible — this overcounts only when the
 * log is larger than TAIL_BYTES and the most recent lint scrolled off the
 * window. That is acceptable for a "recommendation" trigger and avoids
 * scanning a potentially large log.
 */
export async function countIngestSinceLastLint(): Promise<IngestSinceLastLint> {
  let raw = "";
  try {
    const handle = await fs.open(WIKI_LOG_PATH, "r");
    try {
      const stat = await handle.stat();
      const size = stat.size;
      const start = Math.max(0, size - TAIL_BYTES);
      const length = size - start;
      if (length > 0) {
        const buf = Buffer.alloc(length);
        await handle.read(buf, 0, length, start);
        raw = buf.toString("utf8");
        if (start > 0) {
          // Discard the (likely truncated) first line so we don't half-match a
          // boundary entry.
          const nl = raw.indexOf("\n");
          if (nl >= 0) raw = raw.slice(nl + 1);
        }
      }
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { count: 0, lastIngestAt: null, lastLintAt: null };
    }
    throw err;
  }

  let count = 0;
  let lastIngestAt: string | null = null;
  let lastLintAt: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    const ts = m[1];
    const kind = m[2];
    if (kind === "lint") {
      lastLintAt = ts;
      // Reset because everything before is older than this lint.
      count = 0;
    } else if (kind === "ingest") {
      lastIngestAt = ts;
      count += 1;
    }
  }
  return { count, lastIngestAt, lastLintAt };
}
