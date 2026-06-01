import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, jsonError } from "@/lib/api";
import { loadConfig, patchLocalConfig } from "@/lib/config";
import { invalidate as invalidateBotIdentity } from "@/lib/telegram/bot-identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  /** Pass a non-empty string to set, an empty string to clear, or null to clear. */
  token: z.string().max(500).nullable(),
});

/**
 * Persist the Telegram bot token in `config/local.json`. The token is the
 * only secret in the telegram section; the rest of the config (mode,
 * allowlist, etc.) goes through the normal /api/settings PATCH flow. We
 * keep the token write isolated so it can never be round-tripped through
 * a GET payload.
 */
export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("token required", 400);

  const cfg = await loadConfig();
  const next = parsed.data.token && parsed.data.token.length > 0
    ? parsed.data.token
    : null;
  await patchLocalConfig({
    telegram: { ...cfg.telegram, botToken: next },
  });
  // Token swap invalidates any cached bot identity (we may now point at
  // a different bot account).
  invalidateBotIdentity();
  return NextResponse.json({ ok: true, set: next != null });
}
