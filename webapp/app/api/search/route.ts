import { NextResponse } from "next/server";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { searchWiki } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const q = new URL(req.url).searchParams.get("q") ?? "";
  try {
    const hits = await searchWiki(q);
    return NextResponse.json({ q, hits });
  } catch (err) {
    return jsonError(errorMessage(err), 500);
  }
}
