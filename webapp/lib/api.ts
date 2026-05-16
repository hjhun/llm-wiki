import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./auth";

/**
 * API 라우트에서 호출. 세션이 없으면 401 응답 객체를 돌려준다.
 * ```ts
 * const unauth = await requireSession();
 * if (unauth) return unauth;
 * ```
 */
export async function requireSession(): Promise<NextResponse | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);
  if (!session) {
    return NextResponse.json(
      { error: "unauthorized" },
      { status: 401 },
    );
  }
  return null;
}

export function jsonError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
