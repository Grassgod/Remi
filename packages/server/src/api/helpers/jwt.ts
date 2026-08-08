// Dashboard JWT verification: HMAC algorithms, secret resolution, base64url decoding and the
// constant-time comparison the signature check relies on.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cleanString, isObjectRecord } from "../wire/index.js";

export const DEFAULT_JWT_SECRET = "multiremi-dev-secret-change-in-production";

export const JWT_HMAC_ALGORITHMS: Record<string, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

export function verifyJwtToken(token: string): { userId: string } | null {
  // No real secret configured (outside development) => reject every JWT rather
  // than validating against a publicly-known hardcoded default.
  const secret = jwtSecret();
  if (!secret) return null;
  const [encodedHeader, encodedClaims, signature, extra] = token.split(".");
  if (!encodedHeader || !encodedClaims || !signature || extra !== undefined) return null;
  const header = decodeBase64UrlJson(encodedHeader);
  const claims = decodeBase64UrlJson(encodedClaims);
  if (!isObjectRecord(header) || !isObjectRecord(claims)) return null;
  const digest = JWT_HMAC_ALGORITHMS[String(header.alg ?? "")];
  if (!digest) return null;
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const expected = base64UrlEncode(createHmac(digest, secret).update(signingInput).digest());
  if (!safeEqualText(signature, expected)) return null;
  const userId = cleanString(typeof claims.sub === "string" ? claims.sub : null);
  if (!userId || !jwtTimeClaimsAreValid(claims)) return null;
  return { userId };
}

// Returns the configured JWT signing secret, or null when none is set. The
// hardcoded dev default is only allowed in non-production dev/test environments;
// in production a missing JWT_SECRET means JWTs are rejected outright rather
// than validated against a publicly-known key.
export function jwtSecret(): string | null {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") return DEFAULT_JWT_SECRET;
  return null;
}

export function jwtTimeClaimsAreValid(claims: Record<string, unknown>, nowSeconds = Date.now() / 1000): boolean {
  const exp = numericDateClaim(claims.exp);
  if (exp !== null && nowSeconds >= exp) return false;
  const nbf = numericDateClaim(claims.nbf);
  if (nbf !== null && nowSeconds < nbf) return false;
  const iat = numericDateClaim(claims.iat);
  if (iat !== null && nowSeconds + 60 < iat) return false;
  return true;
}

export function numericDateClaim(value: unknown): number | null {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function decodeBase64UrlJson(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function base64UrlEncode(value: Buffer): string {
  return value.toString("base64url");
}

export function safeEqualText(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
