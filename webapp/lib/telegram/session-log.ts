import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_ROOT } from "../paths";
import type { CliName } from "../cli";
import type { PublicQueryVisibleSource } from "../public-query";
import { redactSecrets } from "../secret-scan";

const TIME_ZONE = "Asia/Seoul";
const TELEGRAM_LOG_DIR = "telegram";

function partMap(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function readableKstTime(date: Date): string {
  const p = partMap(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} KST`;
}

function kstDatePath(date: Date): string {
  const p = partMap(date);
  return `${p.year}-${p.month}-${p.day}`;
}

export type TelegramSessionLogInput = {
  chatId: number;
  chatKind: "private" | "group" | "channel";
  chatLabel: string;
  fromUserId?: number | null;
  fromUserName?: string | null;
  kind: "query" | "reject" | "static" | "throttled" | "non-text";
  rawMessage: string;
  question?: string;
  answer?: string;
  sources?: PublicQueryVisibleSource[];
  agent?: CliName | null;
  durationMs?: number;
  ok: boolean;
  error?: string;
};

/** Mask a high-confidence secret out of a nullable persisted field. */
function safeField(value: string | null | undefined): string | null {
  if (value == null) return null;
  return redactSecrets(value).redacted;
}

/**
 * Build the JSON entry persisted for a Telegram interaction. Pure and
 * filesystem-free so the redaction contract can be unit-tested.
 *
 * Secret masking applies to every free-text field a user or the LLM can
 * fill (the inbound message, derived question, and answer) plus the error
 * string. The `sessions/` audit trail is append-only (CLAUDE.md §9), so a
 * credential pasted into chat must be masked here just like at the
 * wiki/answers save boundary — there is no second chance to scrub it.
 */
export function buildTelegramSessionEntry(
  input: TelegramSessionLogInput,
  now: Date,
): Record<string, unknown> {
  return {
    time: readableKstTime(now),
    isoTime: now.toISOString(),
    kind: "telegram",
    actor: "telegram-user",
    chat: {
      id: input.chatId,
      kind: input.chatKind,
      label: input.chatLabel,
    },
    from: input.fromUserId
      ? { id: input.fromUserId, name: input.fromUserName ?? null }
      : null,
    interaction: input.kind,
    conversation: {
      message: safeField(input.rawMessage),
      question: safeField(input.question),
      answer: safeField(input.answer),
    },
    result: {
      ok: input.ok,
      error: safeField(input.error),
      agent: input.agent ?? null,
      durationMs: input.durationMs ?? null,
      sources: input.sources ?? [],
    },
  };
}

/**
 * Append a single Telegram interaction to
 * `sessions/<KST date>/telegram/<chatId>.jsonl`. One file per chat per
 * day keeps the audit trail easy to scan without leaking a separate
 * artifact per message.
 */
export async function appendTelegramSessionLog(
  input: TelegramSessionLogInput,
): Promise<string> {
  const now = new Date();
  const date = kstDatePath(now);
  const rel = path.join(date, TELEGRAM_LOG_DIR, `${input.chatId}.jsonl`);
  const abs = path.join(SESSIONS_ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const entry = buildTelegramSessionEntry(input, now);
  await fs.appendFile(abs, JSON.stringify(entry) + "\n", "utf8");
  return rel.split(path.sep).join("/");
}
