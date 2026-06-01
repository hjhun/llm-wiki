import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  /**
   * Token to validate. When `null`, the route falls back to the token saved
   * in `config/local.json`. The token itself is never persisted by this
   * endpoint — Settings has a dedicated save flow for that.
   */
  token: z.string().min(1).nullable().optional(),
});

const TelegramGetMeResponse = z.object({
  ok: z.boolean(),
  result: z
    .object({
      id: z.number(),
      is_bot: z.boolean(),
      first_name: z.string().optional(),
      username: z.string().optional(),
    })
    .optional(),
  description: z.string().optional(),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("token field required", 400);

  let token = parsed.data.token ?? null;
  if (!token) {
    const cfg = await loadConfig();
    token = cfg.telegram.botToken ?? null;
  }
  if (!token) {
    return jsonError(
      "Bot token is not configured. Paste a token first.",
      400,
    );
  }

  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "GET",
      // 8s is generous; getMe is a sub-100ms call when the token is valid.
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    return jsonError(
      `Telegram API unreachable: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  const body = await upstream.json().catch(() => null);
  const data = TelegramGetMeResponse.safeParse(body);
  if (!data.success) {
    return jsonError(
      `Unexpected Telegram response (HTTP ${upstream.status})`,
      502,
    );
  }
  if (!data.data.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: data.data.description ?? `getMe failed (HTTP ${upstream.status})`,
      },
      { status: 200 },
    );
  }
  const result = data.data.result;
  return NextResponse.json({
    ok: true,
    botUsername: result?.username ?? null,
    botName: result?.first_name ?? null,
  });
}
