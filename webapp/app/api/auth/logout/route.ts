import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, isHttpsRequest } from "@/lib/auth";

export async function POST(req: Request) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: isHttpsRequest(req),
    path: "/",
    maxAge: 0,
  });
  return NextResponse.json({ ok: true });
}
