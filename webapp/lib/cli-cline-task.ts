/**
 * Incremental sniffer for cline's task id banner.
 *
 * Used by the multi-agent resume path: to continue a worker's own cline
 * conversation across ingest rounds we need its task id, but cline does not let
 * us assign one up front (unlike claude `--session-id`). Running a fresh round
 * with `-y -p <prompt>` makes cline print a `Task started: <task id>` line to
 * stdout; later rounds resume that task with `cline -T <task id>`.
 *
 * Unlike the codex JSON parser, cline stdout is ordinary plain text we want to
 * keep verbatim in RunResult.stdout — this sniffer only *observes* the stream
 * to extract the id and never transforms or suppresses it. The banner arrives
 * early, so the id is captured eagerly as chunks stream in and the internal
 * buffer is bounded once the (short) marker can no longer be split across a
 * future chunk.
 *
 * Pure and side-effect free so it can be unit-tested without running cline.
 */

// Strip ANSI SGR / control sequences so a colorized banner still matches.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const TASK_RE = /Task started:\s*(\S+)/;

export type ClineTaskParser = {
  /** Feed a raw stdout chunk (plain text). */
  push(chunk: string): void;
  /** Captured task id from the `Task started:` banner, or null if not seen. */
  taskId(): string | null;
};

export function createClineTaskParser(): ClineTaskParser {
  let buffer = "";
  let taskId: string | null = null;

  return {
    push(chunk: string): void {
      if (taskId) return;
      buffer += chunk.replace(ANSI_RE, "");
      const m = TASK_RE.exec(buffer);
      if (m) {
        taskId = m[1];
        buffer = "";
        return;
      }
      // The marker is short; keep only a tail long enough to span a split
      // banner so the buffer cannot grow without bound on large output.
      if (buffer.length > 4096) buffer = buffer.slice(-256);
    },
    taskId(): string | null {
      return taskId;
    },
  };
}
