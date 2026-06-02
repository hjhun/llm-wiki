/**
 * Incremental parser for Claude Code's `--output-format stream-json` NDJSON.
 *
 * Used by the optional token-streaming path (config `cli.streamTokens`): claude
 * `-p` buffers plain output until exit, but `--output-format stream-json
 * --verbose` emits one JSON object per line as the answer is generated. This
 * parser turns those lines into incremental plain-text deltas for live display
 * and yields an authoritative final text.
 *
 * It is deliberately tolerant: unknown line shapes are ignored, partial lines
 * spanning chunk boundaries are buffered, and the terminal `result` field —
 * the documented, stable signal — is preferred as the final answer so the saved
 * text is correct even if delta parsing missed something.
 *
 * Pure and side-effect free so it can be unit-tested without running claude.
 */

export type StreamJsonParser = {
  /**
   * Feed a raw stdout chunk. Returns any newly produced plain-text delta
   * (empty string when the chunk completed no text-bearing line).
   */
  push(chunk: string): string;
  /** Authoritative final text: the `result` field if seen, else the deltas. */
  finalText(): string;
};

function extractTextFromLine(
  obj: unknown,
): { delta: string; result: string | null } {
  if (!obj || typeof obj !== "object") return { delta: "", result: null };
  const o = obj as Record<string, unknown>;

  // Terminal result event carries the complete answer.
  if (o.type === "result" && typeof o.result === "string") {
    return { delta: "", result: o.result };
  }

  // Anthropic streaming delta: { type: "content_block_delta",
  //   delta: { type: "text_delta", text: "..." } }
  if (o.type === "content_block_delta" && o.delta && typeof o.delta === "object") {
    const d = o.delta as Record<string, unknown>;
    if (typeof d.text === "string") return { delta: d.text, result: null };
  }

  // Full assistant message block(s): { type: "assistant",
  //   message: { content: [{ type: "text", text: "..." }] } }
  if (o.type === "assistant" && o.message && typeof o.message === "object") {
    const msg = o.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      let text = "";
      for (const block of msg.content) {
        if (
          block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string"
        ) {
          text += (block as Record<string, unknown>).text as string;
        }
      }
      if (text) return { delta: text, result: null };
    }
  }

  return { delta: "", result: null };
}

export function createClaudeStreamParser(): StreamJsonParser {
  let buffer = "";
  let streamed = "";
  let result: string | null = null;

  function consumeLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) return "";
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return ""; // not a JSON line (banner, blank, partial) — ignore
    }
    const { delta, result: res } = extractTextFromLine(obj);
    if (res !== null) result = res;
    if (delta) {
      streamed += delta;
      return delta;
    }
    return "";
  }

  return {
    push(chunk: string): string {
      buffer += chunk;
      let out = "";
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        out += consumeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
      return out;
    },
    finalText(): string {
      // Flush any trailing line that arrived without a newline.
      if (buffer.trim()) {
        consumeLine(buffer);
        buffer = "";
      }
      return result ?? streamed;
    },
  };
}
