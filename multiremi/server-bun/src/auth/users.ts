/**
 * User provisioning — ports the Go server's findOrCreateUser + checkSignupAllowed
 * (server/internal/handler/auth.go) onto the Drizzle DB.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { user, type User } from "../db/schema.js";
import type { Config } from "../config.js";

export class SignupError extends Error {
  constructor(message = "signup not allowed") {
    super(message);
    this.name = "SignupError";
  }
}

/** Mirror of Go checkSignupAllowed: gate new signups by ALLOWED_EMAIL_DOMAINS. */
export function checkSignupAllowed(email: string, isNew: boolean, cfg: Config): void {
  if (!isNew) return; // existing users always allowed to log in
  const at = email.indexOf("@");
  const domain = at > 0 ? email.slice(at + 1).toLowerCase() : "";
  if (cfg.allowedEmailDomains.length > 0) {
    const ok = cfg.allowedEmailDomains.some((d) => d.toLowerCase() === domain);
    if (!ok) throw new SignupError(`signup not allowed for domain "${domain}"`);
  }
}

export async function findOrCreateUser(
  db: Db,
  email: string,
  cfg: Config,
  opts?: { displayName?: string; avatarUrl?: string },
): Promise<{ user: User; isNew: boolean }> {
  const normalized = email.trim().toLowerCase();
  const existing = await db.select().from(user).where(eq(user.email, normalized)).limit(1);
  if (existing.length > 0) {
    checkSignupAllowed(normalized, false, cfg);
    return { user: existing[0]!, isNew: false };
  }
  checkSignupAllowed(normalized, true, cfg);
  const at = normalized.indexOf("@");
  const fallbackName = at > 0 ? normalized.slice(0, at) : normalized;
  const name = opts?.displayName?.trim() || fallbackName;
  const [created] = await db
    .insert(user)
    .values({ name, email: normalized, avatarUrl: opts?.avatarUrl?.trim() || null })
    .returning();
  return { user: created!, isNew: true };
}
