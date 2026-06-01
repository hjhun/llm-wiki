import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, requireSession } from "@/lib/api";
import { loadConfig, patchLocalConfig } from "@/lib/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BodySchema = z.object({
  chatId: z.number(),
  permission: z.enum(["query", "trusted"]).default("query"),
  /** Optional human-readable label override. */
  label: z.string().max(120).optional(),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("chatId required", 400);

  const cfg = await loadConfig();
  const tg = cfg.telegram;

  const pendingEntry = tg.pending.find(
    (entry) => entry.chatId === parsed.data.chatId,
  );
  const existingApproved = tg.allowlist.find(
    (entry) => entry.chatId === parsed.data.chatId,
  );

  if (!pendingEntry && !existingApproved) {
    return jsonError("chat is not pending and not already approved", 404);
  }

  const kind = pendingEntry?.kind ?? existingApproved?.kind ?? "private";
  const label =
    parsed.data.label?.trim() ||
    pendingEntry?.label ||
    existingApproved?.label ||
    "";

  const nextAllowlist = tg.allowlist.filter(
    (entry) => entry.chatId !== parsed.data.chatId,
  );
  nextAllowlist.push({
    chatId: parsed.data.chatId,
    kind,
    label,
    permission: parsed.data.permission,
    approvedAt: new Date().toISOString(),
  });

  const nextPending = tg.pending.filter(
    (entry) => entry.chatId !== parsed.data.chatId,
  );

  await patchLocalConfig({
    telegram: {
      ...tg,
      allowlist: nextAllowlist,
      pending: nextPending,
    },
  });

  return NextResponse.json({ ok: true });
}
