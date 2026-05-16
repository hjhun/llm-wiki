import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { readSession } from "@/lib/sessions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const { searchParams } = new URL(req.url);
  const p = searchParams.get("path");
  if (!p) return jsonError("path required", 400);
  try {
    const data = await readSession(p);
    return NextResponse.json({ path: p, ...data });
  } catch (err) {
    return jsonError(errorMessage(err), 404);
  }
}
