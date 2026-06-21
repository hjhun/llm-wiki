/**
 * Incremental parser for Cline CLI's `--json` NDJSON stream.
 *
 * Cline's help/README documents `--json` as structured NDJSON and shows
 * assistant text at `type == "agent_event" && event.text`. For Cline-backed
 * Chat operations we want exactly that user-facing answer text, not styled
 * terminal output or tool-call progress events.
 */

export type ClineJsonParser = {
  /** Feed a raw stdout chunk. Returns newly emitted assistant text. */
  push(chunk: string): string;
  /** Concatenated assistant text extracted from `agent_event.event.text`. */
  finalText(): string;
  /** Captured Cline task/session id, when the NDJSON stream exposes one. */
  taskId(): string | null;
};

function eventText(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (o.type !== "agent_event" || !o.event || typeof o.event !== "object") {
    return null;
  }
  const event = o.event as Record<string, unknown>;
  if (typeof event.text !== "string") return null;

  // Cline 0.6 streams the assistant answer as `content_start` events with
  // contentType "text", whose `text` field is a delta (plus a cumulative
  // `accumulated`). It then emits a matching `content_end` carrying the FULL
  // text again, and a terminal `done` event carrying the submit summary.
  // Concatenating every `event.text` therefore duplicates the whole answer
  // (delta stream + content_end repeat) and appends the submit summary. Keep
  // only the streamed text deltas: skip reasoning (chain-of-thought), the
  // content_end repeat, and the done summary.
  const innerType = typeof event.type === "string" ? event.type : null;
  const contentType =
    typeof event.contentType === "string" ? event.contentType : null;

  if (contentType && contentType !== "text") return null;
  if (innerType === "content_end" || innerType === "done") return null;

  return event.text;
}

function taskId(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  const looksLikeTaskEvent = /task|session/i.test(type);
  for (const key of ["task_id", "taskId", "session_id", "sessionId", "id"]) {
    if (
      looksLikeTaskEvent &&
      typeof o[key] === "string" &&
      String(o[key]).trim()
    ) {
      return o[key] as string;
    }
  }
  if (o.event && typeof o.event === "object") {
    return taskId(o.event);
  }
  return null;
}

export function createClineJsonParser(): ClineJsonParser {
  let buffer = "";
  let text = "";
  let capturedTaskId: string | null = null;

  function consumeLine(line: string): string {
    const trimmed = line.trim();
    if (!trimmed) return "";
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return "";
    }
    if (!capturedTaskId) capturedTaskId = taskId(obj);
    const chunk = eventText(obj);
    if (chunk == null) return "";
    text += chunk;
    return chunk;
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
      if (buffer.trim()) {
        consumeLine(buffer);
        buffer = "";
      }
      return text;
    },
    taskId(): string | null {
      return capturedTaskId;
    },
  };
}
