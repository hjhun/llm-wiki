import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "../paths";
import {
  PROGRESS_STATE_PATH,
  WIKI_LOG_REL,
  ensureIngestProgressMigrated,
  formatStateSummary,
  summarizeIngestState,
} from "../ingest-loop";
import type { ChatSendEvent } from "../chat-events";

const LOG_HEADING_RE =
  /^##\s+\[([^\]]+)\]\s+(ingest|preprocess|query|lint|graph)\s*\|\s*(.+?)\s*$/;

type ProgressEvent = Extract<ChatSendEvent, { type: "progress" }>;

/**
 * Polling watcher that exposes ingest sub-chunk progress to the chat stream.
 * Skills persist state to progress/ingest/.state.json after every
 * sub-chunk and append a heading to wiki/log.md, so this watcher reads both
 * during runCli rather than relying on the CLI's stdout flushing behavior
 * (claude -p / codex exec frequently buffer until exit).
 *
 * Returns a disposer that stops the timer. The watcher swallows all I/O
 * errors — it must never break the main CLI stream. Extracted verbatim from
 * the /api/chat/send route.
 */
export function startProgressWatcher(
  emit: (event: ProgressEvent) => void,
  options: { sessionPath?: string } = {},
): () => void {
  const stateAbs = path.join(PROJECT_ROOT, PROGRESS_STATE_PATH);
  const logAbs = path.join(PROJECT_ROOT, WIKI_LOG_REL);
  let stopped = false;
  let lastStateMtime = 0;
  let lastSummary = "";
  let baselineLogSize: number | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await ensureIngestProgressMigrated();
      const st = await fs.stat(stateAbs);
      if (st.mtimeMs !== lastStateMtime) {
        lastStateMtime = st.mtimeMs;
        const raw = await fs.readFile(stateAbs, "utf8");
        const summary = summarizeIngestState(raw, {
          sessionPath: options.sessionPath,
        });
        if (summary) {
          const line = formatStateSummary(summary);
          if (line !== lastSummary) {
            lastSummary = line;
            emit({
              type: "progress",
              phase: "state",
              summary: line,
              active: summary.active_leaf,
            });
          }
        }
      }
    } catch {
      // ENOENT or partial JSON — try again on the next tick.
    }
    if (!options.sessionPath) {
      try {
        const st = await fs.stat(logAbs);
        if (baselineLogSize == null) {
          baselineLogSize = st.size;
        } else if (st.size > baselineLogSize) {
          const length = st.size - baselineLogSize;
          const fh = await fs.open(logAbs, "r");
          try {
            const buf = Buffer.alloc(length);
            await fh.read(buf, 0, length, baselineLogSize);
            const text = buf.toString("utf8");
            const lines = text.split("\n");
            const completed = lines.slice(0, -1);
            let consumedBytes = 0;
            for (const line of completed) {
              consumedBytes += Buffer.byteLength(line, "utf8") + 1;
              const m = LOG_HEADING_RE.exec(line);
              if (m) {
                emit({
                  type: "progress",
                  phase: "log",
                  ts: m[1],
                  op: m[2],
                  detail: m[3],
                });
              }
            }
            baselineLogSize += consumedBytes;
          } finally {
            await fh.close();
          }
        } else if (st.size < baselineLogSize) {
          baselineLogSize = st.size;
        }
      } catch {
        // log.md may not exist yet — that is fine.
      }
    }
  };

  void tick();
  const handle = setInterval(() => {
    void tick();
  }, 1500);

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
