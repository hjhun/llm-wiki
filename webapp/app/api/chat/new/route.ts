import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { loadConfig } from "@/lib/config";
import { newSession } from "@/lib/sessions";

const Body = z.object({
  subject: z.string().min(1).max(120).optional(),
  agent: z.enum(["codex", "claude", "gemini", "cline"]).nullable().optional(),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("invalid body", 400);
  const cfg = await loadConfig();
  const agent =
    parsed.data.agent === undefined
      ? cfg.agent.default
      : parsed.data.agent;
  try {
    const ref = await newSession({
      subject: parsed.data.subject ?? "untitled",
      agent,
    });
    return NextResponse.json(ref);
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
