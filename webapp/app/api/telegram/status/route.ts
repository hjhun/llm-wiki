import { NextResponse } from "next/server";
import { requireSession } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { getWebhookInfo } from "@/lib/telegram/api";
import { snapshotStats } from "@/lib/telegram/runtime-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const cfg = await loadConfig();
  const tg = cfg.telegram;
  const stats = snapshotStats();

  let webhook:
    | {
        url: string;
        pendingUpdateCount: number | null;
        lastErrorMessage: string | null;
        lastErrorAt: string | null;
      }
    | null = null;
  let webhookError: string | null = null;

  if (tg.botToken && tg.enabled) {
    try {
      const info = await getWebhookInfo(tg.botToken);
      webhook = {
        url: info.url,
        pendingUpdateCount: info.pendingUpdateCount ?? null,
        lastErrorMessage: info.lastErrorMessage ?? null,
        lastErrorAt:
          typeof info.lastErrorDate === "number"
            ? new Date(info.lastErrorDate * 1000).toISOString()
            : null,
      };
    } catch (err) {
      webhookError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({
    enabled: tg.enabled,
    mode: tg.mode,
    botTokenSet: typeof tg.botToken === "string" && tg.botToken.length > 0,
    webhookUrl: tg.webhookPublicUrl,
    webhookSecretSet:
      typeof tg.webhookSecret === "string" && tg.webhookSecret.length > 0,
    stats,
    webhook,
    webhookError,
    allowlistCount: tg.allowlist.length,
    pendingCount: tg.pending.length,
  });
}
