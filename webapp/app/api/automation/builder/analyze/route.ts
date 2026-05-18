import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { buildAutomationProposal } from "@/lib/automation/builder";

export const dynamic = "force-dynamic";

const Body = z.object({
  goal: z.string().min(1).max(20_000),
  schedulePreference: z.string().max(1000).default(""),
  selectedAgents: z
    .array(z.enum(["codex", "claude", "gemini", "cline"]))
    .min(1),
  analyzerAgent: z
    .enum(["codex", "claude", "gemini", "cline"])
    .nullable()
    .default(null),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }
  try {
    const proposal = await buildAutomationProposal(parsed.data);
    return NextResponse.json({ proposal });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
