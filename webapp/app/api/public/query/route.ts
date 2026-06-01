import { NextResponse } from "next/server";
import { z } from "zod";
import { errorMessage, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { runPublicQuery } from "@/lib/public-query";
import { appendPublicSessionLog } from "@/lib/public-session-log";
import { publicQueryAccessAllowed } from "@/lib/public-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  message: z.string().min(1).max(20000),
  visitorId: z.string().min(1).max(200).optional(),
  conversationId: z.string().min(1).max(200).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      }),
    )
    .max(24)
    .optional(),
});

export async function POST(req: Request) {
  const cfg = await loadConfig();
  if (!cfg.publicQuery.enabled) {
    return jsonError("public query is disabled", 404);
  }

  // Optional access passphrase. When configured, the /clio page prompts the
  // visitor and sends it back as this header; an unauthenticated request that
  // omits or mismatches it is refused before any expensive CLI work runs.
  if (
    !publicQueryAccessAllowed(
      cfg.publicQuery.accessToken,
      req.headers.get("x-clio-access-token"),
    )
  ) {
    return jsonError("access passphrase required", 401);
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("message required", 400);

  try {
    const result = await runPublicQuery(
      parsed.data.message,
      parsed.data.history ?? [],
      req.signal,
    );
    await appendPublicSessionLog({
      request: req,
      visitorId: parsed.data.visitorId,
      conversationId: parsed.data.conversationId,
      rawMessage: parsed.data.message,
      question: result.question,
      answer: result.answer,
      sources: result.sources,
      agent: result.agent,
      durationMs: result.durationMs,
      ok: true,
    }).catch((err) => {
      console.warn("[public-query] failed to write session log:", err);
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = errorMessage(err);
    await appendPublicSessionLog({
      request: req,
      visitorId: parsed.data.visitorId,
      conversationId: parsed.data.conversationId,
      rawMessage: parsed.data.message,
      question: parsed.data.message,
      ok: false,
      error: message,
    }).catch((logErr) => {
      console.warn("[public-query] failed to write session log:", logErr);
    });
    return jsonError(message, 400);
  }
}
