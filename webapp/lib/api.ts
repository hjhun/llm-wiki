import "server-only";

import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  extractBearerToken,
  verifyCliToken,
  verifySessionToken,
} from "./auth";

/**
 * API 라우트에서 호출. 세션이 없으면 401 응답 객체를 돌려준다.
 *
 * 인증 우선순위:
 *   1) `Authorization: Bearer <cliToken>` — 로컬 `clio` CLI 용도.
 *   2) `lw_session` 쿠키 (JWT) — 웹 UI 용도.
 *
 * ```ts
 * const unauth = await requireSession();
 * if (unauth) return unauth;
 * ```
 */
export async function requireSession(): Promise<NextResponse | null> {
  const bearer = extractBearerToken(
    (await headers()).get("authorization"),
  );
  if (bearer && (await verifyCliToken(bearer))) return null;

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
