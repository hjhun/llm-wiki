import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { collectDashboard } from "@/lib/dashboard";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;

  try {
    const data = await collectDashboard();
    return NextResponse.json(data);
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
