/**
 * SsoPlugin — the public face of the SSO package.
 *
 * Host app usage:
 *
 *   import { SsoPlugin } from "./plugins/sso";
 *
 *   const sso = new SsoPlugin();
 *   sso.migrate(getDb());           // create tables
 *   sso.seed();                     // bootstrap from remi.toml (idempotent)
 *   sso.registerHttp(app);          // mount /api/auth/sso/* + /api/auth/me + host-info
 *   app.use("/api/*", sso.middleware()); // composable auth
 *
 *   // Optional: register extra provider plugins from outside
 *   sso.registerProviderType(META, factory);
 */

import type { Database } from "bun:sqlite";
import type { Hono, MiddlewareHandler } from "hono";
import { migrate as runMigrations } from "./db/migrations.js";
import { seedFromToml } from "./seed.js";
import { SsoProviderRegistry } from "./providers/registry.js";
import type {
  SsoProviderFactory,
  PluginTypeMeta,
} from "./providers/base.js";
import {
  BytedanceOidcProvider,
  BYTEDANCE_OIDC_META,
} from "./providers/bytedance-oidc.js";
import {
  GenericOidcProvider,
  GENERIC_OIDC_META,
} from "./providers/generic-oidc.js";
import { DevProvider, DEV_PROVIDER_META } from "./providers/dev.js";
import { registerSsoHandlers } from "./http/handlers.js";
import { ssoMiddleware } from "./http/middleware.js";

export interface SsoPluginOptions {
  /** If false, skip auto-registering bytedance-oidc + generic-oidc built-ins. */
  registerBuiltins?: boolean;
  /** Bootstrap admin email list — new users with these emails become admin on first login. */
  adminEmails?: string[];
}

export class SsoPlugin {
  readonly registry = new SsoProviderRegistry();
  private readonly _adminEmails: string[];

  constructor(opts: SsoPluginOptions = {}) {
    this._adminEmails = opts.adminEmails ?? [];
    if (opts.registerBuiltins !== false) {
      this.registry.register(
        BYTEDANCE_OIDC_META,
        (cfg) => new BytedanceOidcProvider(cfg),
      );
      this.registry.register(
        GENERIC_OIDC_META,
        (cfg) => new GenericOidcProvider(cfg),
      );
      // Dev provider — local fake login (refuses in production).
      this.registry.register(
        DEV_PROVIDER_META,
        (cfg) => new DevProvider(cfg),
      );
    }
  }

  /** Register an additional provider type (for external plugin packs). */
  registerProviderType(
    meta: PluginTypeMeta,
    factory: SsoProviderFactory,
  ): this {
    this.registry.register(meta, factory);
    return this;
  }

  /** Install all SSO tables. Idempotent. */
  migrate(db: Database): void {
    runMigrations(db);
  }

  /** Bootstrap from legacy remi.toml. Idempotent. */
  seed(): { seeded: { providers: number; clusters: number } } {
    return seedFromToml();
  }

  /** Mount HTTP routes on the host Hono app. */
  registerHttp(app: Hono): void {
    registerSsoHandlers(app, this.registry, {
      adminEmails: this._adminEmails,
    });
  }

  /** Hono middleware to gate non-public paths behind a session cookie. */
  middleware(): MiddlewareHandler {
    return ssoMiddleware();
  }
}
