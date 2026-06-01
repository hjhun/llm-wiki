import { NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { dispatchUpdate } from "@/lib/telegram/handlers";
import {
  noteError,
  noteWebhookRequest,
} from "@/lib/telegram/runtime-state";
import { TelegramUpdate } from "@/lib/telegram/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

/**
 * Telegram webhook callback. Telegram POSTs every Update to this endpoint
 * with the secret token we passed to setWebhook in the
 * `X-Telegram-Bot-Api-Secret-Token` header. Anything that fails validation
 * returns a 401 but with no body — Telegram will retry, but we don't want
 * to leak whether the route exists.
 *
 * Dispatch is intentionally fire-and-forget after the secret check: we
 * return 200 quickly so Telegram doesn't drop the update, then process
 * in the background. Errors land in the in-memory runtime stats and the
 * Settings status panel surfaces them.
 */
export async function POST(req: Request) {
  noteWebhookRequest();
  const cfg = await loadConfig();
  const tg = cfg.telegram;
  if (!tg.enabled) {
    return new NextResponse(null, { status: 200 });
  }

  const expectedSecret = tg.webhookSecret;
  const presentedSecret = req.headers.get(TELEGRAM_SECRET_HEADER);
  if (!expectedSecret || expectedSecret !== presentedSecret) {
    return new NextResponse(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return jsonError("invalid JSON", 400);
  }

  const parsed = TelegramUpdate.safeParse(payload);
  if (!parsed.success) {
    // Acknowledge so Telegram doesn't retry this exact malformed packet,
    // but keep a trace for debugging.
    noteError("update failed schema validation");
    return new NextResponse(null, { status: 200 });
  }

  // Fire-and-forget; the handler swallows its own errors.
  void dispatchUpdate(parsed.data);

  return new NextResponse(null, { status: 200 });
}
