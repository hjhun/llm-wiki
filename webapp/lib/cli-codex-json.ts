/**
 * Incremental parser for Codex's `codex exec --json` JSONL event stream.
 *
 * Used by the multi-agent resume path: to continue a worker's own Codex
 * conversation across ingest rounds we need the session id, but Codex does not
 * let us assign one up front (unlike claude `--session-id`). Running round 1
 * with `--json` makes Codex print one JSON event per line, including a
 * `thread.started` event whose `thread_id` is the session id used by
 * `codex exec resume <thread_id>` on later rounds.
 *
 * Because `--json` turns stdout into JSONL, this parser also extracts the final
 * assistant answer from `item.completed` events of type `agent_message`, so the
 * caller can keep RunResult.stdout as plain text.
 *
 * The `thread_id` arrives on the first event, so it is captured eagerly as
 * chunks stream in — a bounded tail buffer on the raw stdout could otherwise
 * drop that head line for very large outputs.
 *
 * Pure and side-effect free so it can be unit-tested without running codex.
 */

export type CodexJsonParser = {
  /** Feed a raw stdout chunk (JSONL). */
  push(chunk: string): void;
  /** Session/thread id from `thread.started`, or null if not seen. */
  threadId(): string | null;
  /** Concatenated `agent_message` text, the plain-text answer. */
  text(): string;
};

export function createCodexJsonParser(): CodexJsonParser {
  let buffer = "";
  let threadId: string | null = null;
  const messages: string[] = [];

  function consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return; // banner / partial / non-JSON line — ignore
    }
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    if (o.type === "thread.started" && typeof o.thread_id === "string") {
      threadId = o.thread_id;
      return;
    }
    if (o.type === "item.completed" && o.item && typeof o.item === "object") {
      const item = o.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") {
        messages.push(item.text);
      }
    }
  }

  return {
    push(chunk: string): void {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        consumeLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    },
    threadId(): string | null {
      return threadId;
    },
    text(): string {
      // Flush any trailing line that arrived without a newline.
      if (buffer.trim()) {
        consumeLine(buffer);
        buffer = "";
      }
      return messages.join("\n").trim();
    },
  };
}
