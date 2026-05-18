import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { getAutomationManager } from "@/lib/automation/manager";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Params) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const { id } = await ctx.params;
  try {
    const runtime = await getAutomationManager().planNow(id);
    return NextResponse.json({ runtime });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
