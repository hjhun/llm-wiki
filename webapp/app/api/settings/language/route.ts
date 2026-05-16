import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig, patchLocalConfig, type Config } from "@/lib/config";

export const dynamic = "force-dynamic";

const Body = z.object({
  language: z.enum(["ko", "en"]),
});

export async function PUT(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }

  try {
    const current = await loadConfig();
    const patch = {
      ui: {
        ...current.ui,
        language: parsed.data.language,
      },
    } satisfies Partial<Config>;
    const next = await patchLocalConfig(patch);
    return NextResponse.json({ language: next.ui.language });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
