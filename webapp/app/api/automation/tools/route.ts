import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { detectAutomationTools } from "@/lib/automation/tools";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  try {
    return NextResponse.json(await detectAutomationTools());
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
