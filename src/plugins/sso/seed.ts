/**
 * Bootstrap migration: copy [sso] / [[clusters]] from remi.toml into DB on first boot.
 * Idempotent — re-running does nothing once rows exist.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { createLogger } from "../../logger.js";
import { countProviders, createProvider, getProvider } from "./db/providers.js";
import { countClusters, createCluster } from "./db/clusters.js";

const log = createLogger("sso-seed");

const TOML_CANDIDATES = [
  join(process.cwd(), "remi.toml"),
  join(homedir(), ".remi", "remi.toml"),
];

function loadTomlIfPresent(): Record<string, unknown> | null {
  for (const p of TOML_CANDIDATES) {
    if (existsSync(p)) {
      try {
        return parseToml(readFileSync(p, "utf-8")) as Record<string, unknown>;
      } catch (e) {
        log.warn(`failed to parse ${p}:`, e);
        return null;
      }
    }
  }
  return null;
}

/** Run seed if DB tables are empty AND remi.toml has the legacy sections. */
export function seedFromToml(): { seeded: { providers: number; clusters: number } } {
  const out = { seeded: { providers: 0, clusters: 0 } };
  const toml = loadTomlIfPresent();
  if (!toml) return out;

  // ── sso_providers ──
  if (countProviders() === 0) {
    const sso = toml.sso as Record<string, unknown> | undefined;
    if (sso && sso.client_id && sso.client_secret) {
      try {
        createProvider({
          id: "bytedance",
          type: "bytedance-oidc",
          name: "ByteDance SSO",
          icon: "🅱",
          enabled: true,
          sortOrder: 10,
          config: {
            issuer: sso.issuer ?? "https://sso.bytedance.com",
            client_id: sso.client_id,
            client_secret: sso.client_secret,
            scopes: sso.scopes ?? ["openid", "profile", "email"],
          },
        });
        out.seeded.providers++;
        log.info(`seeded SSO provider: bytedance (type=bytedance-oidc)`);
      } catch (e) {
        log.warn("failed to seed bytedance SSO provider:", e);
      }
    }
  }

  // ── clusters ──
  if (countClusters() === 0) {
    const clusters = (toml.clusters ?? []) as Array<Record<string, unknown>>;
    for (const c of clusters) {
      if (!c.id || !c.hostname) continue;
      try {
        createCluster({
          id: String(c.id),
          name: String(c.name ?? c.id),
          hostname: String(c.hostname),
          port: c.port != null ? parseInt(String(c.port), 10) : 6120,
          protocol: ((c.protocol as string) ?? "http") as "http" | "https",
          isDefault: Boolean(c.is_default),
          description: c.description != null ? String(c.description) : undefined,
        });
        out.seeded.clusters++;
      } catch (e) {
        log.warn(`failed to seed cluster ${c.id}:`, e);
      }
    }
    if (out.seeded.clusters > 0) {
      log.info(`seeded ${out.seeded.clusters} cluster(s) from remi.toml`);
    }
  }

  if (out.seeded.providers > 0 || out.seeded.clusters > 0) {
    log.info(
      "✓ seed complete. The [sso] and [[clusters]] sections in remi.toml are now redundant — " +
        "they will be ignored on subsequent boots. You may delete them.",
    );
  }

  // ── Auto-seed Dev provider in non-production if it doesn't exist ──
  // So a fresh dev machine has *some* working login out of the box.
  if (
    process.env.NODE_ENV !== "production" &&
    !getProvider("dev")
  ) {
    try {
      createProvider({
        id: "dev",
        type: "dev",
        name: "Dev (Local)",
        icon: "🧪",
        enabled: true,
        sortOrder: 1,
        config: {
          username: "dev",
          email: "dev@localhost",
          name: "Dev User",
          nickname: "本地开发",
        },
      });
      out.seeded.providers++;
      log.info(
        "seeded dev SSO provider (id=dev) — local fake login, " +
          "refuses to load in production",
      );
    } catch (e) {
      log.warn("failed to seed dev SSO provider:", e);
    }
  }

  return out;
}
