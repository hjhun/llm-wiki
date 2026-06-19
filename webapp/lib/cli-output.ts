/**
 * ANSI / control-sequence cleanup for CLI stdout before it is shown in the web
 * UI or persisted as an assistant message. Shared by the chat send route, the
 * graph run route, and the ingest loop so streamed AND final coding-agent output
 * render as plain text instead of escape garbage (e.g. cline prints colorized,
 * cursor-control output whose raw `\x1b` bytes otherwise show up as "ESC").
 */

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x1b\x9b][[\]()#;?]*(?:[0-?]*[ -/]*[@-~]))/g;

// Any stray escape introducer left after the structured pass (a lone ESC/CSI
// that did not form a complete recognized sequence), so no raw `\x1b` survives.
// eslint-disable-next-line no-control-regex
const STRAY_ESC_RE = /[\x1b\x9b]/g;

/** Drop recognized + leftover escape sequences and NUL bytes. */
function stripEscapes(text: string): string {
  return text.replace(ANSI_RE, "").replace(/\x00/g, "").replace(STRAY_ESC_RE, "");
}

/**
 * Strips ANSI escape sequences, NUL bytes, and stray carriage returns from CLI
 * output while preserving newlines and surrounding whitespace. Does not trim or
 * blank the result. Use for text kept verbatim (persisted final replies).
 */
export function cleanCliText(text: string): string {
  return stripEscapes(text).replace(/\r(?!\n)/g, "");
}

/**
 * Per-chunk cleanup for the live stream. Collapses carriage-return overwrite
 * runs and returns "" when nothing printable remains so callers can skip
 * emitting blank chunks.
 */
export function displayChunk(chunk: string): string {
  const text = stripEscapes(chunk).replace(/\r[^\n]*/g, "");
  return text.trim().length > 0 ? text : "";
}
