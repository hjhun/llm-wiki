import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { SESSIONS_ROOT } from "../paths";
import type { CliName } from "../cli";
import type { PublicQueryVisibleSource } from "../public-query";

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
  const entry = {
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
      message: input.rawMessage,
      question: input.question ?? null,
      answer: input.answer ?? null,
    },
    result: {
      ok: input.ok,
      error: input.error ?? null,
      agent: input.agent ?? null,
      durationMs: input.durationMs ?? null,
      sources: input.sources ?? [],
    },
  };
  await fs.appendFile(abs, JSON.stringify(entry) + "\n", "utf8");
  return rel.split(path.sep).join("/");
}
