/**
 * Configuration types and loading via ConfigStore (SQLite).
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const REMI_HOME = join(homedir(), ".remi");

export const SESSIONS_FILE = join(REMI_HOME, "sessions.json");
export const PID_FILE = join(REMI_HOME, "remi.pid");

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  port: number;
  domain: "feishu" | "lark" | "bytedance";
  connectionMode: "websocket";
  userAccessToken: string;
}

/**
 * Plugin system settings.
 * Per-plugin config lives in [plugin.<id>] sub-tables (see RemiConfig.pluginConfigs).
 */
export interface PluginsConfig {
  /** Directory scanned for external drop-in plugins. Default ~/.remi/plugins. */
  dir: string;
  /** Plugin ids explicitly enabled (allowlist; complements [plugin.<id>].enabled). */
  enabled: string[];
  /** Load external plugins from `dir`. Default true. */
  allowExternal: boolean;
}

// SSO inbound login (web Authorization Code / OIDC) is managed by
// the SSO plugin's DB tables (sso_providers / sso_settings).
// On first boot the SSO plugin seeds itself from a legacy [sso] section if found
// (see src/plugins/sso/seed.ts), then ignores it on subsequent boots.
//
// Clusters are similarly DB-managed (clusters table).

/**
 * Auth config — bootstrap-only. Determines who is auto-promoted to admin
 * on first login. After bootstrap, role changes happen via DB (admin UI later).
 */
export interface AuthConfig {
  adminEmails: string[];
}

export interface TokenSyncRuleConfig {
  name: string;
  source: string;
  target: string;
  format: string;
  key?: string;
  extraKeys?: Record<string, string>;
}

export interface ProxyConfig {
  /** HTTP/HTTPS proxy URL. Empty = no proxy. */
  http: string;
  /** Comma-separated list of hosts/CIDRs that bypass the proxy. */
  noProxy: string;
}

export interface GoogleConfig {
  apiKey: string;
  model: string;
}

export interface TracingConfig {
  enabled: boolean;
  logsDir: string;
  tracesDir: string;
  retentionDays: number;
}

export interface RemiConfig {
  feishu: FeishuConfig;
  /** Plugin system settings. */
  plugins: PluginsConfig;
  /** Per-plugin config sub-tables keyed by plugin id (from [plugin.<id>]). */
  pluginConfigs: Record<string, Record<string, unknown>>;
  /** Auth bootstrap (who is admin on first login). */
  auth: AuthConfig;
  /** Token sync rules for distributing tokens to external tools. */
  tokenSync: TokenSyncRuleConfig[];
  /** Proxy settings for outbound HTTP requests. */
  proxy: ProxyConfig;
  /** Google API config for Gemini image generation (optional). */
  google?: GoogleConfig;
  tracing: TracingConfig;
  logLevel: string;
}

function defaultFeishuConfig(): FeishuConfig {
  return {
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    port: 9000,
    domain: "feishu",
    connectionMode: "websocket",
    userAccessToken: "",
  };
}

export function defaultRemiConfig(): RemiConfig {
  return {
    feishu: defaultFeishuConfig(),
    tokenSync: [],
    proxy: { http: "", noProxy: "" },
    plugins: { dir: join(homedir(), ".remi", "plugins"), enabled: [], allowExternal: true },
    pluginConfigs: {},
    auth: { adminEmails: [] },
    tracing: {
      enabled: true,
      logsDir: join(REMI_HOME, "logs"),
      tracesDir: join(REMI_HOME, "traces"),
      retentionDays: 60,
    },
    logLevel: "INFO",
  };
}

/**
 * Load configuration from ConfigStore (SQLite).
 * Environment variable overrides are applied by ConfigStore.load().
 */
export function loadConfig(): RemiConfig {
  const { ConfigStore } = require("./db/config-store.js");
  const { getDb } = require("./db/index.js");
  return new ConfigStore(getDb()).load();
}
