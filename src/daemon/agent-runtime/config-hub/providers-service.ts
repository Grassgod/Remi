/**
 * ProvidersService — provider preset management with apply-to-auth.
 *
 * Stores provider configurations (API key / endpoint / model presets) per tool
 * in config-hub.db's `providers` table, and — when a preset is switched to
 * "current" — applies it to that tool's native auth/config files via the
 * tool adapter's applyProvider() (Claude→settings.json env, Codex→config.toml
 * + auth.json, Gemini→.env). Read-merge-atomic-write, foreign content preserved.
 */

import type { Database } from "bun:sqlite";
import type { AppType, ProviderSettings, ProviderApplyResult } from "./types.js";
import type { AdapterRegistry } from "./adapters/base.js";
import { createLogger } from "@shared/logger.js";

const log = createLogger("config-hub");

export interface ProviderRow {
  id: string;
  appType: AppType;
  name: string;
  settingsConfig: any;
  category: string | null;
  isCurrent: boolean;
}

export class ProvidersService {
  constructor(
    private readonly db: Database,
    private readonly adapters?: AdapterRegistry,
  ) {}

  list(app?: AppType): ProviderRow[] {
    const rows = app
      ? (this.db
          .query(
            `SELECT id, app_type, name, settings_config, category, is_current
             FROM providers WHERE app_type = ?
             ORDER BY COALESCE(sort_index, 0), id`,
          )
          .all(app) as any[])
      : (this.db
          .query(
            `SELECT id, app_type, name, settings_config, category, is_current
             FROM providers
             ORDER BY app_type, COALESCE(sort_index, 0), id`,
          )
          .all() as any[]);
    return rows.map((r) => ({
      id: r.id,
      appType: r.app_type as AppType,
      name: r.name,
      settingsConfig: safeJson(r.settings_config),
      category: r.category ?? null,
      isCurrent: !!r.is_current,
    }));
  }

  current(app: AppType): ProviderRow | null {
    return this.list(app).find((p) => p.isCurrent) ?? null;
  }

  upsert(opts: {
    id: string;
    appType: AppType;
    name: string;
    settingsConfig: unknown;
    category?: string;
  }): void {
    this.db.run(
      `INSERT INTO providers (id, app_type, name, settings_config, category, created_at, sort_index)
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(id, app_type) DO UPDATE SET
         name=excluded.name,
         settings_config=excluded.settings_config,
         category=excluded.category`,
      [opts.id, opts.appType, opts.name, JSON.stringify(opts.settingsConfig ?? {}), opts.category ?? null, Date.now()],
    );
  }

  /**
   * Make a preset current AND apply it to the tool's auth files.
   * Returns what was written (or null if no adapter / no applyProvider).
   */
  switchTo(id: string, app: AppType): ProviderApplyResult | null {
    const tx = this.db.transaction(() => {
      this.db.run(`UPDATE providers SET is_current = 0 WHERE app_type = ?`, [app]);
      this.db.run(`UPDATE providers SET is_current = 1 WHERE id = ? AND app_type = ?`, [id, app]);
    });
    tx();
    return this.apply(app);
  }

  /** (Re)apply the current preset for `app` to its auth files. */
  apply(app: AppType): ProviderApplyResult | null {
    const cur = this.current(app);
    if (!cur) return null;
    const adapter = this.adapters?.get(app);
    if (!adapter?.applyProvider) return null;
    const settings = normalizeSettings(cur.settingsConfig);
    try {
      const result = adapter.applyProvider(settings, cur.id);
      if (result) log.info(`[providers:${app}] applied '${cur.id}' → ${result.files.join(", ")}`);
      return result;
    } catch (e: any) {
      log.error(`[providers:${app}] apply failed: ${e?.message ?? e}`);
      throw e;
    }
  }

  delete(id: string, app: AppType): void {
    this.db.run(`DELETE FROM providers WHERE id = ? AND app_type = ?`, [id, app]);
  }
}

function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Map a stored settings blob onto the normalized ProviderSettings shape (tolerant of key aliases). */
function normalizeSettings(cfg: any): ProviderSettings {
  if (!cfg || typeof cfg !== "object") return {};
  return {
    baseUrl: cfg.baseUrl ?? cfg.base_url ?? cfg.url ?? undefined,
    apiKey: cfg.apiKey ?? cfg.api_key ?? cfg.key ?? cfg.token ?? undefined,
    model: cfg.model ?? undefined,
    wireApi: cfg.wireApi ?? cfg.wire_api ?? undefined,
  };
}
