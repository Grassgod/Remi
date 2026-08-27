/**
 * ConfigStore — SQLite-backed config storage.
 *
 * Each RemiConfig section is stored as a JSON blob in the remi_config table.
 * Environment variable overrides are applied on load (same as the old TOML path).
 */

import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  RemiConfig,
  FeishuConfig,
  PluginsConfig,
  AuthConfig,
  ProxyConfig,
  TracingConfig,
} from "../config.js";
import { defaultRemiConfig } from "../config.js";

const REMI_HOME = join(homedir(), ".remi");

const SECTIONS = [
  "feishu", "plugins", "pluginConfigs", "auth",
  "tokenSync", "botMenu", "proxy",
  "google", "tracing", "logLevel",
] as const;

type Section = (typeof SECTIONS)[number];

export class ConfigStore {
  constructor(private db: Database) {}

  isEmpty(): boolean {
    const row = this.db.query("SELECT COUNT(*) as cnt FROM remi_config").get() as { cnt: number };
    return row.cnt === 0;
  }

  getSection(section: string): unknown {
    const row = this.db.query(
      "SELECT value FROM remi_config WHERE section = ? AND key = ''",
    ).get(section) as { value: string } | null;
    if (!row) return undefined;
    return JSON.parse(row.value);
  }

  setSection(section: string, value: unknown): void {
    this.db.run(
      `INSERT INTO remi_config (section, key, value, updated_at)
       VALUES (?, '', ?, datetime('now'))
       ON CONFLICT(section, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [section, JSON.stringify(value)],
    );
  }

  save(config: RemiConfig): void {
    const tx = this.db.transaction(() => {
      for (const section of SECTIONS) {
        const value = config[section as keyof RemiConfig];
        if (value !== undefined) {
          this.setSection(section, value);
        }
      }
    });
    tx();
  }

  load(): RemiConfig {
    const defaults = defaultRemiConfig();
    const rows = this.db.query(
      "SELECT section, value FROM remi_config WHERE key = ''",
    ).all() as Array<{ section: string; value: string }>;

    const data: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        data[row.section] = JSON.parse(row.value);
      } catch { /* skip malformed */ }
    }

    const env = process.env;

    const feishu = (data.feishu ?? defaults.feishu) as FeishuConfig;

    if (env.FEISHU_APP_ID) feishu.appId = env.FEISHU_APP_ID;
    if (env.FEISHU_APP_SECRET) feishu.appSecret = env.FEISHU_APP_SECRET;
    if (env.FEISHU_VERIFICATION_TOKEN) feishu.verificationToken = env.FEISHU_VERIFICATION_TOKEN;
    if (env.FEISHU_ENCRYPT_KEY) feishu.encryptKey = env.FEISHU_ENCRYPT_KEY;
    if (env.FEISHU_PORT) feishu.port = parseInt(env.FEISHU_PORT, 10);
    if (env.FEISHU_DOMAIN) feishu.domain = env.FEISHU_DOMAIN as FeishuConfig["domain"];
    if (env.FEISHU_USER_ACCESS_TOKEN) feishu.userAccessToken = env.FEISHU_USER_ACCESS_TOKEN;

    const google = data.google as RemiConfig["google"] ?? defaults.google;
    if (google && env.GOOGLE_API_KEY) google.apiKey = env.GOOGLE_API_KEY;

    return {
      feishu,
      plugins: (data.plugins ?? defaults.plugins) as PluginsConfig,
      pluginConfigs: (data.pluginConfigs ?? defaults.pluginConfigs) as Record<string, Record<string, unknown>>,
      auth: (data.auth ?? defaults.auth) as AuthConfig,
      tokenSync: (data.tokenSync ?? defaults.tokenSync) as RemiConfig["tokenSync"],
      botMenu: (data.botMenu ?? defaults.botMenu) as RemiConfig["botMenu"],
      proxy: (data.proxy ?? defaults.proxy) as ProxyConfig,
      google,
      tracing: (data.tracing ?? defaults.tracing) as TracingConfig,
      logLevel: env.REMI_LOG_LEVEL ?? (data.logLevel as string) ?? defaults.logLevel,
    };
  }
}
