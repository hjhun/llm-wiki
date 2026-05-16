import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, errorMessage, jsonError } from "@/lib/api";
import { changePassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

const Body = z.object({
  current: z.string().min(1),
  next: z.string().min(6, "비밀번호는 6자 이상이어야 합니다."),
});

export async function POST(req: Request) {
  const unauth = await requireSession();
  if (unauth) return unauth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "invalid body", 400);
  }

  try {
    await changePassword(parsed.data.current, parsed.data.next);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(errorMessage(err), 400);
  }
}
