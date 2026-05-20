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

const CLI_TOKEN_PREFIX = "clio_";

function newCliTokenValue(): string {
  return CLI_TOKEN_PREFIX + randomBytes(32).toString("hex");
}

/**
 * cliToken이 없으면 32바이트 랜덤 토큰을 만들어 local.json에 저장하고
 * 반환한다. 이미 있으면 그대로 반환. 로컬 `clio` CLI가 웹앱 HTTP API에
 * 인증하기 위해 사용한다.
 */
export async function ensureCliToken(): Promise<string> {
  const cfg = await loadConfig();
  if (cfg.auth.cliToken) return cfg.auth.cliToken;
  const token = newCliTokenValue();
  await patchLocalConfig({ auth: { ...cfg.auth, cliToken: token } });
  return token;
}

/**
 * cliToken을 새로 발급해 기존 값을 덮어쓴다. Settings UI 또는
 * `clio auth rotate` 호출 시 사용. 반환값은 새 토큰이다.
 */
export async function rotateCliToken(): Promise<string> {
  const cfg = await loadConfig();
  const token = newCliTokenValue();
  await patchLocalConfig({ auth: { ...cfg.auth, cliToken: token } });
  return token;
}

/**
 * 주어진 Bearer 토큰이 저장된 cliToken과 일치하는지 검증.
 * 시간차 공격을 막기 위해 길이가 다르면 즉시 false.
 */
export async function verifyCliToken(
  token: string | undefined | null,
): Promise<boolean> {
  if (!token) return false;
  const cfg = await loadConfig();
  const expected = cfg.auth.cliToken;
  if (!expected || expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Authorization 헤더에서 Bearer 토큰을 추출. 형식이 맞지 않으면 null.
 */
export function extractBearerToken(
  authHeader: string | null | undefined,
): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1].trim() : null;
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

/**
 * Detect whether the inbound request is actually being served over HTTPS so
 * we only stamp `Secure` on the auth cookie when the browser will accept it.
 * Modern browsers reject `Set-Cookie: ...; Secure` on plain HTTP, which broke
 * LAN logins (host bound to 0.0.0.0 + no TLS proxy).
 */
export function isHttpsRequest(req: Request): boolean {
  try {
    if (new URL(req.url).protocol === "https:") return true;
  } catch {
    // Fall through to header sniffing.
  }
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp) {
    return xfp.split(",")[0].trim().toLowerCase() === "https";
  }
  return false;
}

export function sessionCookieOptions(
  maxAgeSec: number,
  opts: { secure?: boolean } = {},
) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: opts.secure ?? false,
    path: "/",
    maxAge: maxAgeSec,
  };
}
