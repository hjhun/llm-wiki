/**
 * Telegram's sendMessage caps the body at 4096 characters. Long answers
 * from runPublicQuery need to be cut into multiple sendMessage calls
 * without breaking code fences or markdown tokens we depend on.
 *
 * Strategy:
 *   1. If the text fits, send a single chunk.
 *   2. Otherwise, split on paragraph boundaries first, then line
 *      boundaries, then hard char limit. Each chunk gets a small
 *      `(n/total)` page marker so the user can tell when more is coming.
 *
 * We treat the input as plain text in M2. Markdown formatting is a
 * separate concern — the caller decides whether to set parse_mode.
 */

const HARD_LIMIT = 4096;
const PAGE_MARKER_RESERVED = 12; // " (12/12)" plus newline

export type TelegramReplyChunk = {
  index: number;
  total: number;
  text: string;
};

export function splitForTelegram(
  text: string,
  perChunkMax: number = HARD_LIMIT,
): TelegramReplyChunk[] {
  const cap = Math.max(
    100,
    Math.min(HARD_LIMIT, perChunkMax) - PAGE_MARKER_RESERVED,
  );
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [{ index: 1, total: 1, text: "(empty response)" }];

  if (normalized.length <= cap && normalized.length <= perChunkMax) {
    return [{ index: 1, total: 1, text: normalized }];
  }

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = "";
  };

  for (const para of paragraphs) {
    const candidate = current.length === 0 ? para : `${current}\n\n${para}`;
    if (candidate.length <= cap) {
      current = candidate;
      continue;
    }
    push();
    if (para.length <= cap) {
      current = para;
      continue;
    }
    // Single paragraph too long — split on line boundaries.
    const lines = para.split("\n");
    let buf = "";
    for (const line of lines) {
      const next = buf.length === 0 ? line : `${buf}\n${line}`;
      if (next.length <= cap) {
        buf = next;
        continue;
      }
      if (buf.trim()) chunks.push(buf.trim());
      buf = "";
      if (line.length <= cap) {
        buf = line;
        continue;
      }
      // Last resort: hard cut.
      for (let i = 0; i < line.length; i += cap) {
        const slice = line.slice(i, i + cap);
        if (i + cap >= line.length) {
          buf = slice;
        } else {
          chunks.push(slice);
        }
      }
    }
    if (buf.trim()) chunks.push(buf.trim());
  }
  push();

  if (chunks.length === 0) {
    return [{ index: 1, total: 1, text: normalized.slice(0, cap) }];
  }
  return chunks.map((text, i) => ({
    index: i + 1,
    total: chunks.length,
    text:
      chunks.length === 1 ? text : `${text}\n\n(${i + 1}/${chunks.length})`,
  }));
}
