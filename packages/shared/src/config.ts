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
  /** User open_ids that trigger bot replies when @mentioned in allowed groups. */
  triggerUserIds: string[];
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

// ── Bot Menu (千人千面菜单) ─────────────────────────────────

export interface BotMenuBehavior {
  type: "target" | "event_key" | "send_message";
  /** URL for type=target — maps to target.common_url. */
  url?: string;
  /** Event key for type=event_key. */
  eventKey?: string;
  isPrimary?: boolean;
}

export interface BotMenuIcon {
  /** Icon library token (e.g. "search_outlined"). */
  token?: string;
  /** Icon color (e.g. "blue"). */
  color?: string;
  /** Custom image key. */
  fileKey?: string;
}

export interface BotMenuItemConfig {
  name: string;
  i18nName?: Record<string, string>;
  icon?: BotMenuIcon;
  tag?: string;
  behaviors?: BotMenuBehavior[];
  children?: BotMenuItemConfig[];
}

export interface BotMenuUserConfig {
  userId: string;
  userIdType?: "open_id" | "union_id" | "user_id";
  /** Display label for Dashboard (not sent to API). */
  label?: string;
  items: BotMenuItemConfig[];
}

export interface BotMenuConfig {
  /** Global default menu items (visible to all users). */
  default?: BotMenuItemConfig[];
  /** Per-user personalized menus (千人千面). */
  users?: BotMenuUserConfig[];
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
  /** Bot menu config (千人千面菜单). */
  botMenu: BotMenuConfig;
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
    triggerUserIds: [],
  };
}

export function defaultRemiConfig(): RemiConfig {
  return {
    feishu: defaultFeishuConfig(),
    tokenSync: [],
    botMenu: {},
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
