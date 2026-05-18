import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { installAutomationTool } from "@/lib/automation/tools";

export const dynamic = "force-dynamic";

const Body = z.object({
  tool: z.enum(["agent-browser"]),
  confirmed: z.literal(true),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("invalid install request", 400);
  }
  try {
    const result = await installAutomationTool(parsed.data.tool);
    return NextResponse.json(result);
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
