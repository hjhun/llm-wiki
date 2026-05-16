import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { readGraphState } from "@/lib/graph";

export const dynamic = "force-dynamic";

export async function GET() {
  const unauth = await requireSession();
  if (unauth) return unauth;

  try {
    const state = await readGraphState();
    return NextResponse.json(state);
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
