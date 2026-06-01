import { timingSafeEqual } from "node:crypto";

/**
 * Decide whether a public-query request may proceed given the configured
 * access passphrase and the value the caller supplied (the `x-clio-access-token`
 * header). Pure and constant-time:
 *
 * - `configToken == null` (or empty) → the endpoint is fully open; allow.
 * - otherwise the provided value must equal the configured one, compared in
 *   constant time so a timing side channel can't reveal the passphrase.
 *
 * Extracted as a standalone helper so the security check is unit-testable
 * without an HTTP harness.
 */
export function publicQueryAccessAllowed(
  configToken: string | null | undefined,
  provided: string | null | undefined,
): boolean {
  if (!configToken) return true;
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(configToken, "utf8");
  const b = Buffer.from(provided, "utf8");
  // timingSafeEqual throws on length mismatch; guard first. The length check
  // itself leaks only the length, which is not the secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
