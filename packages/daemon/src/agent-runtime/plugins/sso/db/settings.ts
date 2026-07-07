/**
 * sso_settings — typed accessors for global SSO operational settings.
 * Storage is key/value; this module gives typed getters/setters.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "@shared/db/index.js";

export interface SsoSettings {
  sessionTtl: number;        // seconds
  cookieName: string;
  cookieSecure: boolean;
  defaultProvider: string | null;
}

const DEFAULTS: SsoSettings = {
  sessionTtl: 7 * 24 * 3600,
  cookieName: "remi_session",
  cookieSecure: false,
  defaultProvider: null,
};

function get(key: string, db: Database = getDb()): string | null {
  const row = db
    .query("SELECT value FROM sso_settings WHERE key = ?")
    .get(key) as { value: string } | null;
  return row?.value ?? null;
}

function set(key: string, value: string, db: Database = getDb()): void {
  db.run(
    `INSERT INTO sso_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()],
  );
}

export function getSettings(db: Database = getDb()): SsoSettings {
  return {
    sessionTtl: parseInt(get("session_ttl", db) ?? String(DEFAULTS.sessionTtl), 10),
    cookieName: get("cookie_name", db) ?? DEFAULTS.cookieName,
    cookieSecure: (get("cookie_secure", db) ?? "false") === "true",
    defaultProvider: get("default_provider", db),
  };
}

export function updateSettings(
  patch: Partial<SsoSettings>,
  db: Database = getDb(),
): SsoSettings {
  if (patch.sessionTtl !== undefined) set("session_ttl", String(patch.sessionTtl), db);
  if (patch.cookieName !== undefined) set("cookie_name", patch.cookieName, db);
  if (patch.cookieSecure !== undefined) set("cookie_secure", String(patch.cookieSecure), db);
  if (patch.defaultProvider !== undefined) {
    if (patch.defaultProvider === null) {
      db.run("DELETE FROM sso_settings WHERE key = 'default_provider'");
    } else {
      set("default_provider", patch.defaultProvider, db);
    }
  }
  return getSettings(db);
}
