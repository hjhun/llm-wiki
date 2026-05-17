import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { getAutoLintManager } from "@/lib/auto-lint/manager";

export const dynamic = "force-dynamic";

export async function POST() {
  const unauth = await requireSession();
  if (unauth) return unauth;
  try {
    const runtime = await getAutoLintManager().runNow();
    return NextResponse.json({ runtime });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
