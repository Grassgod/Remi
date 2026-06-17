/**
 * JWT issue/verify. Wire-compatible with the Go server's auth.issueJWT:
 * HS256, secret from JWT_SECRET, claims { sub, email, name, iat, exp }.
 * A token issued here verifies in Go and vice versa.
 */

import { SignJWT, jwtVerify } from "jose";

export interface AuthClaims {
  /** Multiremi user id (JWT `sub`). */
  sub: string;
  email: string;
  name: string;
}

const ALG = "HS256";
const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

function key(secret: string): Uint8Array {
  if (!secret) throw new Error("JWT_SECRET is not set");
  return new TextEncoder().encode(secret);
}

export async function issueJWT(
  claims: AuthClaims,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: claims.email, name: claims.name })
    .setProtectedHeader({ alg: ALG, typ: "JWT" })
    .setSubject(claims.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(key(secret));
}

export async function verifyJWT(token: string, secret: string): Promise<AuthClaims> {
  const { payload } = await jwtVerify(token, key(secret), { algorithms: [ALG] });
  return {
    sub: typeof payload.sub === "string" ? payload.sub : "",
    email: typeof payload.email === "string" ? payload.email : "",
    name: typeof payload.name === "string" ? payload.name : "",
  };
}
