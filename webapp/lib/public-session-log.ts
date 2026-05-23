import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSIONS_ROOT } from "./paths";
import type { CliName } from "./cli";
import type { PublicQueryVisibleSource } from "./public-query";

export type PublicSessionLogInput = {
  request: Request;
  visitorId?: string;
  conversationId?: string;
  rawMessage?: string;
  question: string;
  answer?: string;
  sources?: PublicQueryVisibleSource[];
  agent?: CliName | null;
  durationMs?: number;
  ok: boolean;
  error?: string;
};

const TIME_ZONE = "Asia/Seoul";
const PUBLIC_LOG_DIR = "public";

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
  const parts = partMap(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} KST`;
}

function kstDatePath(date: Date): string {
  const parts = partMap(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function safeSegment(input: string | undefined, fallback: string): string {
  const value = (input ?? "").trim();
  if (!value) return fallback;
  const safe = value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
  return safe || fallback;
}

function firstHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (!value) return null;
  return value.split(",")[0]?.trim() || null;
}

function forwardedFor(headers: Headers): string | null {
  const forwarded = headers.get("forwarded");
  if (!forwarded) return null;
  const first = forwarded.split(",")[0] ?? "";
  const match = /(?:^|;)\s*for="?([^";]+)"?/i.exec(first);
  return match?.[1]?.trim() ?? null;
}

function clientIp(request: Request): string {
  return (
    firstHeader(request.headers, "x-forwarded-for") ??
    firstHeader(request.headers, "x-real-ip") ??
    firstHeader(request.headers, "cf-connecting-ip") ??
    forwardedFor(request.headers) ??
    "unknown"
  );
}

export async function appendPublicSessionLog(
  input: PublicSessionLogInput,
): Promise<string> {
  const now = new Date();
  const visitorId = safeSegment(input.visitorId, `visitor-${randomUUID()}`);
  const conversationId = safeSegment(
    input.conversationId,
    `conversation-${randomUUID()}`,
  );
  const date = kstDatePath(now);
  const rel = path.join(
    date,
    PUBLIC_LOG_DIR,
    `${visitorId}_${conversationId}.jsonl`,
  );
  const abs = path.join(SESSIONS_ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const entry = {
    time: readableKstTime(now),
    isoTime: now.toISOString(),
    kind: "public-query",
    actor: "public-user",
    visitorId,
    conversationId,
    request: {
      ip: clientIp(input.request),
      userAgent: input.request.headers.get("user-agent") ?? "unknown",
      referer: input.request.headers.get("referer") ?? null,
    },
    conversation: {
      message: input.rawMessage ?? input.question,
      question: input.question,
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
