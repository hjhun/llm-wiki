import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { jsonError, requireSession } from "@/lib/api";
import { loadConfig, patchLocalConfig } from "@/lib/config";
import {
  deleteWebhook,
  getWebhookInfo,
  setWebhook,
} from "@/lib/telegram/api";
import { rebootPolling, stop as stopPolling } from "@/lib/telegram/polling";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  action: z.enum(["register", "unregister", "info", "use-polling"]),
  /** Required for `register`. Must be the externally reachable HTTPS URL. */
  webhookUrl: z
    .string()
    .min(1)
    .max(1024)
    .url("Webhook URL must be a valid URL")
    .optional(),
});

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("action required", 400);

  const cfg = await loadConfig();
  const tg = cfg.telegram;
  if (!tg.botToken) {
    return jsonError("Bot token must be saved before setup.", 400);
  }

  if (parsed.data.action === "info") {
    try {
      const info = await getWebhookInfo(tg.botToken);
      return NextResponse.json({ ok: true, info });
    } catch (err) {
      return jsonError(
        err instanceof Error ? err.message : String(err),
        502,
      );
    }
  }

  if (parsed.data.action === "unregister") {
    try {
      await deleteWebhook(tg.botToken);
      await patchLocalConfig({
        telegram: { ...tg, webhookPublicUrl: null, mode: "polling" },
      });
      // Re-evaluate polling now that webhook is gone; the manager will
      // either start (if mode=polling and enabled) or stay stopped.
      void rebootPolling();
      return NextResponse.json({ ok: true });
    } catch (err) {
      return jsonError(
        err instanceof Error ? err.message : String(err),
        502,
      );
    }
  }

  if (parsed.data.action === "use-polling") {
    try {
      // Cleanest path: ask Telegram to drop any existing webhook, then
      // flip our config to polling and reboot the worker.
      try {
        await deleteWebhook(tg.botToken);
      } catch {
        // Telegram returns an error if no webhook is set, which is fine.
      }
      await patchLocalConfig({
        telegram: { ...tg, mode: "polling", webhookPublicUrl: null },
      });
      void rebootPolling();
      return NextResponse.json({ ok: true });
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err), 502);
    }
  }

  // register
  const url = parsed.data.webhookUrl;
  if (!url) return jsonError("webhookUrl required for register", 400);
  if (!isHttpsUrl(url)) {
    return jsonError("Webhook URL must use https://", 400);
  }
  // Rotate or generate a secret. Telegram secrets are 1..256 chars of
  // A-Z/a-z/0-9/_-, so a base64url-style token is safe.
  const secret =
    tg.webhookSecret && tg.webhookSecret.length >= 16
      ? tg.webhookSecret
      : randomBytes(32).toString("base64url");
  try {
    await setWebhook(tg.botToken, {
      url,
      secretToken: secret,
      allowedUpdates: ["message", "edited_message", "channel_post"],
    });
    await patchLocalConfig({
      telegram: {
        ...tg,
        webhookPublicUrl: url,
        webhookSecret: secret,
        mode: "webhook",
      },
    });
    // Webhook takes over delivery; stop the polling loop if it was
    // running. Telegram refuses to send updates through both channels
    // simultaneously, so leaving the poller alive would just rack up
    // 409s on every getUpdates call.
    void stopPolling();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err), 502);
  }
}
