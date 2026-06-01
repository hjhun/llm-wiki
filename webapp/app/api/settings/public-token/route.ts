import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, jsonError } from "@/lib/api";
import { loadConfig, patchLocalConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  /** Non-empty string to set the passphrase; empty string or null to clear. */
  token: z.string().max(500).nullable(),
});

/**
 * Persist the public-query access passphrase in `config/local.json`. Kept on a
 * dedicated authenticated route — never round-tripped through the GET settings
 * payload — exactly like the Telegram bot token. Clearing it (null/empty)
 * returns /clio to its fully open, passwordless behavior.
 */
export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("token required", 400);

  const cfg = await loadConfig();
  const next =
    parsed.data.token && parsed.data.token.length > 0
      ? parsed.data.token
      : null;
  await patchLocalConfig({
    publicQuery: { ...cfg.publicQuery, accessToken: next },
  });
  return NextResponse.json({ ok: true, set: next != null });
}
