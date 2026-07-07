/**
 * SSO seed — auto-creates dev provider in non-production.
 * Kept for API compatibility with SsoPlugin.seed() calls from Multiremi.
 */

import { createLogger } from "@shared/logger.js";
import { getProvider, countProviders } from "./db/providers.js";
import { createProvider } from "./db/providers.js";

const log = createLogger("sso-seed");

export function seedFromToml(): { seeded: { providers: number; clusters: number } } {
  const out = { seeded: { providers: 0, clusters: 0 } };

  // Auto-seed Dev provider in non-production if it doesn't exist
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
      log.info("seeded dev SSO provider (id=dev)");
    } catch (e) {
      log.warn("failed to seed dev SSO provider:", e);
    }
  }

  return out;
}
