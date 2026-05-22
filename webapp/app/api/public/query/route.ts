import { NextResponse } from "next/server";
import { z } from "zod";
import { errorMessage, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { runPublicQuery } from "@/lib/public-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  message: z.string().min(1).max(20000),
});

export async function POST(req: Request) {
  const cfg = await loadConfig();
  if (!cfg.publicQuery.enabled) {
    return jsonError("public query is disabled", 404);
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("message required", 400);

  try {
    const result = await runPublicQuery(parsed.data.message, req.signal);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
