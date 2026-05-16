import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  SESSION_COOKIE,
  createSessionToken,
  isHttpsRequest,
  sessionCookieOptions,
  verifyPassword,
} from "@/lib/auth";
import { loadConfig } from "@/lib/config";

const BodySchema = z.object({
  password: z.string().min(1),
});

export async function POST(req: Request) {
  const cfg = await loadConfig();
  if (!cfg.auth.passwordHash) {
    return NextResponse.json(
      { error: "먼저 /setup에서 비밀번호를 설정하세요." },
      { status: 409 },
    );
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "잘못된 입력" }, { status: 400 });
  }

  const ok = await verifyPassword(parsed.data.password, cfg.auth.passwordHash);
  if (!ok) {
    return NextResponse.json(
      { error: "비밀번호가 일치하지 않습니다." },
      { status: 401 },
    );
  }

  const { token, expSec } = await createSessionToken();
  const jar = await cookies();
  jar.set(
    SESSION_COOKIE,
    token,
    sessionCookieOptions(expSec, { secure: isHttpsRequest(req) }),
  );
  return NextResponse.json({ ok: true });
}
