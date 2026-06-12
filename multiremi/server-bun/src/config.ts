/** Runtime config, mirroring the Go server's env contract for parity. */

export interface Config {
  port: number;
  jwtSecret: string;
  authTokenTtlSeconds: number;
  databaseUrl: string;
  frontendOrigin?: string;
  allowedEmailDomains: string[];
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : def;
}

function splitAndTrim(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(): Config {
  return {
    port: envInt("PORT", 8080),
    jwtSecret: process.env.JWT_SECRET ?? "",
    // Mirrors Go auth.AuthTokenTTL() default (30 days).
    authTokenTtlSeconds: envInt("AUTH_TOKEN_TTL", 30 * 24 * 60 * 60),
    databaseUrl: process.env.DATABASE_URL ?? "",
    frontendOrigin: process.env.FRONTEND_ORIGIN || undefined,
    allowedEmailDomains: splitAndTrim(process.env.ALLOWED_EMAIL_DOMAINS),
  };
}
