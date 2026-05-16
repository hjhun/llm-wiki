import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import {
  SESSION_COOKIE,
  createSessionToken,
  isFirstRun,
  isHttpsRequest,
  sessionCookieOptions,
  setInitialPassword,
} from "@/lib/auth";

const BodySchema = z.object({
  password: z.string().min(6, "비밀번호는 6자 이상이어야 합니다."),
});

export async function POST(req: Request) {
  if (!(await isFirstRun())) {
    return NextResponse.json(
      { error: "이미 비밀번호가 설정되어 있습니다." },
      { status: 409 },
    );
  }

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "잘못된 입력" },
      { status: 400 },
    );
  }

  try {
    await setInitialPassword(parsed.data.password);
    const { token, expSec } = await createSessionToken();
    const jar = await cookies();
    jar.set(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(expSec, { secure: isHttpsRequest(req) }),
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "setup failed" },
      { status: 500 },
    );
  }
}
