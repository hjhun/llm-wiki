/**
 * ANSI / control-sequence cleanup for CLI stdout chunks before they are shown
 * in the web UI. Shared by the chat send route and the graph run route so
 * streamed coding-agent output renders as plain text instead of escape
 * garbage.
 */

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x1b\x9b][[\]()#;?]*(?:[0-?]*[ -/]*[@-~]))/g;

/**
 * Strips ANSI escape sequences, carriage-return overwrites, and NUL bytes from
 * a raw CLI stdout chunk. Returns "" when nothing printable remains so callers
 * can skip emitting blank chunks.
 */
export function displayChunk(chunk: string): string {
  const text = chunk
    .replace(ANSI_RE, "")
    .replace(/\r[^\n]*/g, "")
    .replace(/\x00/g, "");
  return text.trim().length > 0 ? text : "";
}
