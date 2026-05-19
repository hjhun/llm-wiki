import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { readSession, renameSession } from "@/lib/sessions";

export const dynamic = "force-dynamic";

const PatchBody = z.object({
  path: z.string().min(1),
  title: z.string().min(1).max(120),
});

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

export async function PATCH(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;
  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }
  try {
    const ref = await renameSession(parsed.data.path, parsed.data.title);
    return NextResponse.json(ref);
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
