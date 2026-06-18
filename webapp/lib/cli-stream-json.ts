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
  /** Total context tokens of the last/terminal usage, or null if unseen. */
  contextTokens(): number | null;
};

type LineKind =
  | { kind: "partial"; text: string } // incremental token delta
  | { kind: "assistant"; text: string } // full (cumulative) message block
  | { kind: "result"; result: string } // terminal authoritative answer
  | { kind: "none" };

function usageTokens(u: unknown): number | null {
  if (!u || typeof u !== "object") return null;
  const o = u as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : 0);
  const total =
    n("input_tokens") +
    n("output_tokens") +
    n("cache_read_input_tokens") +
    n("cache_creation_input_tokens");
  return total > 0 ? total : null;
}

function contentBlockDeltaText(o: Record<string, unknown>): string | null {
  if (
    o.type === "content_block_delta" &&
    o.delta &&
    typeof o.delta === "object"
  ) {
    const d = o.delta as Record<string, unknown>;
    if (typeof d.text === "string") return d.text;
  }
  return null;
}

function classifyLine(obj: unknown): LineKind {
  if (!obj || typeof obj !== "object") return { kind: "none" };
  const o = obj as Record<string, unknown>;

  // Terminal result event carries the complete answer.
  if (o.type === "result" && typeof o.result === "string") {
    return { kind: "result", result: o.result };
  }

  // Direct Anthropic streaming delta.
  const direct = contentBlockDeltaText(o);
  if (direct !== null) return { kind: "partial", text: direct };

  // Claude Code `--include-partial-messages` wraps the same delta:
  //   { type: "stream_event", event: { type: "content_block_delta", delta } }
  if (o.type === "stream_event" && o.event && typeof o.event === "object") {
    const inner = contentBlockDeltaText(o.event as Record<string, unknown>);
    if (inner !== null) return { kind: "partial", text: inner };
  }

  // Full assistant message block(s):
  //   { type: "assistant", message: { content: [{ type: "text", text }] } }
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
      if (text) return { kind: "assistant", text };
    }
  }

  return { kind: "none" };
}

export function createClaudeStreamParser(): StreamJsonParser {
  let buffer = "";
  let streamed = "";
  let result: string | null = null;
  // Once we see fine-grained partial deltas, the later full `assistant`
  // message is just their cumulative duplicate — skip it so the live stream
  // and the delta fallback don't double-count the answer.
  let sawPartial = false;
  let context: number | null = null;

  function consumeLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) return "";
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return ""; // not a JSON line (banner, blank, partial) — ignore
    }
    const parsed = classifyLine(obj);
    const o = obj as Record<string, unknown>;
    if (o.type === "result") {
      const u = usageTokens(o.usage);
      if (u !== null) context = u;
    } else if (o.type === "assistant" && o.message && typeof o.message === "object") {
      const u = usageTokens((o.message as Record<string, unknown>).usage);
      if (u !== null) context = u;
    }
    switch (parsed.kind) {
      case "result":
        result = parsed.result;
        return "";
      case "partial":
        sawPartial = true;
        streamed += parsed.text;
        return parsed.text;
      case "assistant":
        if (sawPartial) return ""; // duplicate of the streamed deltas
        streamed += parsed.text;
        return parsed.text;
      default:
        return "";
    }
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
    contextTokens(): number | null {
      return context;
    },
  };
}
