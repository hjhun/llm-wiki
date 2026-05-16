import "server-only";

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { loadConfig, patchLocalConfig } from "./config";

export const SESSION_COOKIE = "lw_session";
const ISSUER = "llm-wiki";
const AUDIENCE = "local";

const BCRYPT_COST = 12;
const LONG_LIVED_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 365 * 10;

function secretToKey(secretB64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(secretB64, "base64"));
}

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 6) {
    throw new Error("비밀번호는 6자 이상이어야 합니다.");
  }
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/**
 * sessionSecret이 없으면 32바이트 랜덤을 생성해 local.json에 저장한다.
 * 이미 있으면 그대로 반환.
 */
export async function ensureSessionSecret(): Promise<string> {
  const cfg = await loadConfig();
  if (cfg.auth.sessionSecret) return cfg.auth.sessionSecret;
  const secret = randomBytes(32).toString("base64");
  await patchLocalConfig({ auth: { ...cfg.auth, sessionSecret: secret } });
  return secret;
}

export async function isFirstRun(): Promise<boolean> {
  const cfg = await loadConfig();
  return cfg.auth.passwordHash == null;
}

export async function setInitialPassword(plain: string): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.auth.passwordHash != null) {
    throw new Error("이미 비밀번호가 설정되어 있습니다.");
  }
  const hash = await hashPassword(plain);
  const secret =
    cfg.auth.sessionSecret ?? randomBytes(32).toString("base64");
  await patchLocalConfig({
    auth: {
      ...cfg.auth,
      passwordHash: hash,
      sessionSecret: secret,
    },
  });
}

export async function changePassword(
  current: string,
  next: string,
): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.auth.passwordHash) {
    throw new Error("아직 비밀번호가 설정되어 있지 않습니다.");
  }
  const ok = await verifyPassword(current, cfg.auth.passwordHash);
  if (!ok) throw new Error("현재 비밀번호가 일치하지 않습니다.");
  const hash = await hashPassword(next);
  await patchLocalConfig({
    auth: { ...cfg.auth, passwordHash: hash },
  });
}

export type SessionPayload = {
  v: 1;
  iat: number;
  exp?: number;
};

export async function createSessionToken(): Promise<{
  token: string;
  expSec: number;
}> {
  const cfg = await loadConfig();
  const secret = await ensureSessionSecret();
  const ttl = cfg.auth.sessionTtlSec;
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ v: 1 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now);
  if (ttl != null) {
    jwt = jwt.setExpirationTime(now + ttl);
  }
  const token = await jwt.sign(secretToKey(secret));
  return { token, expSec: ttl ?? LONG_LIVED_COOKIE_MAX_AGE_SEC };
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;
  const cfg = await loadConfig();
  if (!cfg.auth.sessionSecret) return null;
  try {
    const { payload } = await jwtVerify(token, secretToKey(cfg.auth.sessionSecret), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    return payload as unknown as SessionPayload;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(maxAgeSec: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  };
}
