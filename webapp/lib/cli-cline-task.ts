/**
 * Incremental sniffer for cline's task id banner.
 *
 * Used by the multi-agent resume path: to continue a worker's own cline
 * conversation across ingest rounds we need its task id, but cline does not let
 * us assign one up front (unlike claude `--session-id`). Running a fresh
 * non-interactive round with a positional prompt may print a
 * `Task started: <task id>` line to stdout; later rounds resume that task with
 * `cline --id <task id>`.
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
// cline -v final summary: `[<sec>s | <in> in, <out> out]` (whitespace-tolerant).
// Global so we can scan every occurrence and keep the LAST one — cline may
// print interim summary lines before the final one.
const VERBOSE_RE = /\[\s*\d+s\s*\|\s*(\d+)\s*in,\s*(\d+)\s*out\s*\]/g;

export type ClineTaskParser = {
  /** Feed a raw stdout chunk (plain text). */
  push(chunk: string): void;
  /** Captured task id from the `Task started:` banner, or null if not seen. */
  taskId(): string | null;
  /** in+out tokens from the latest `-v` summary line, or null. */
  contextTokens(): number | null;
};

export function createClineTaskParser(): ClineTaskParser {
  let idBuffer = "";
  let verboseBuffer = "";
  let taskId: string | null = null;
  let context: number | null = null;

  return {
    push(chunk: string): void {
      const clean = chunk.replace(ANSI_RE, "");
      // Task-id sniff: stop buffering once captured.
      if (!taskId) {
        idBuffer += clean;
        const m = TASK_RE.exec(idBuffer);
        if (m) {
          taskId = m[1];
          idBuffer = "";
        } else if (idBuffer.length > 4096) {
          idBuffer = idBuffer.slice(-256);
        }
      }
      // Summary-line sniff: keep scanning to the end of the stream; the LAST
      // match wins so the final summary beats any interim lines.
      verboseBuffer += clean;
      VERBOSE_RE.lastIndex = 0;
      let v: RegExpExecArray | null;
      while ((v = VERBOSE_RE.exec(verboseBuffer)) !== null) {
        context = Number(v[1]) + Number(v[2]);
      }
      if (verboseBuffer.length > 8192) verboseBuffer = verboseBuffer.slice(-512);
    },
    taskId(): string | null {
      return taskId;
    },
    contextTokens(): number | null {
      return context;
    },
  };
}
