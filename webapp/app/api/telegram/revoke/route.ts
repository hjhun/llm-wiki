import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireSession } from "@/lib/api";
import { loadConfig, patchLocalConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  chatId: z.number(),
  /**
   * `target` decides whether to remove from the approved allowlist or
   * the pending queue. Default removes from both so the admin can use
   * one button when in doubt.
   */
  target: z.enum(["allowlist", "pending", "both"]).default("both"),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("chatId required", 400);

  const cfg = await loadConfig();
  const tg = cfg.telegram;
  const target = parsed.data.target;

  const nextAllowlist =
    target === "pending"
      ? tg.allowlist
      : tg.allowlist.filter(
          (entry) => entry.chatId !== parsed.data.chatId,
        );
  const nextPending =
    target === "allowlist"
      ? tg.pending
      : tg.pending.filter((entry) => entry.chatId !== parsed.data.chatId);

  await patchLocalConfig({
    telegram: {
      ...tg,
      allowlist: nextAllowlist,
      pending: nextPending,
    },
  });
  return NextResponse.json({ ok: true });
}
