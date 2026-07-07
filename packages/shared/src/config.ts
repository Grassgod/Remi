/**
 * Configuration types and loading via ConfigStore (SQLite).
 */

import { homedir } from "node:os";
import { join } from "node:path";

const REMI_HOME = join(homedir(), ".remi");

export const MEMORY_DIR = join(REMI_HOME, "memory");
export const SESSIONS_FILE = join(REMI_HOME, "sessions.json");
export const PID_FILE = join(REMI_HOME, "remi.pid");
export const QUEUE_DIR = join(REMI_HOME, "queue");

/** Per-agent ACP configuration. */
export interface AcpAgentConfig {
  /** ACP agent executable path. Auto-detected if omitted. */
  executable?: string;
  /** Model override passed to the agent. */
  model?: string;
  /** Request timeout in seconds (default: 300). */
  timeout: number;
  /** Tool allowlist passed to the agent. */
  allowedTools: string[];
  /** Optional API key forwarded to compatible ACP wrappers. */
  apiKey?: string | null;
  /** Optional API base URL forwarded to compatible ACP wrappers. */
  baseUrl?: string | null;
}

export interface ProviderConfig {
  /** Default agent to use: "claude" | "codex". */
  default: "claude" | "codex";
  claude: AcpAgentConfig;
  codex: AcpAgentConfig;
}

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
 * New unified cron job config — replaces fragmented [scheduler] + [[scheduled_skills]].
 * Stored as cronJobs section in ConfigStore.
 */
export interface CronJobConfig {
  id: string;
  name?: string;
  handler: string;
  enabled?: boolean;
  /** Cron expression (5/6-field). Mutually exclusive with `every` and `at`. */
  cron?: string;
  /** Timezone for cron expression. */
  tz?: string;
  /** Fixed interval (e.g. "5m", "300s"). Mutually exclusive with `cron` and `at`. */
  every?: string | number;
  /** One-shot ISO timestamp. Mutually exclusive with `cron` and `every`. */
  at?: string;
  /** Timeout in ms (default: 300000). */
  timeoutMs?: number;
  /** Delete job after successful run (useful for one-shots). */
  deleteAfterRun?: boolean;
  /** Arbitrary config passed to the handler function. */
  handlerConfig?: Record<string, any>;
}

export interface ServiceConfig {
  /** Display name (used as PM2 app name). */
  name: string;
  /** Main script/file to run. */
  script: string;
  /** Runtime interpreter: bun, python3, node, etc. */
  interpreter: string;
  /** Arguments passed after the script. */
  args: string[];
  /** Working directory. */
  cwd: string;
  /** Optional shell command to run before starting (e.g. build step). */
  build: string;
  /** Optional port number (for display/monitoring). */
  port: number | null;
  /** Whether this service is enabled (default: true). */
  enabled: boolean;
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

export interface EmbeddingConfig {
  provider: string;
  apiKey: string;
  model?: string;
  dimensions?: number;
}

export interface GoogleConfig {
  apiKey: string;
  model: string;
}

export interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  agents?: string[];
}

export interface TracingConfig {
  enabled: boolean;
  logsDir: string;
  tracesDir: string;
  retentionDays: number;
}

export interface RemiConfig {
  provider: ProviderConfig;
  feishu: FeishuConfig;
  /** Plugin system settings. */
  plugins: PluginsConfig;
  /** Per-plugin config sub-tables keyed by plugin id (from [plugin.<id>]). */
  pluginConfigs: Record<string, Record<string, unknown>>;
  /** Auth bootstrap (who is admin on first login). */
  auth: AuthConfig;
  /** Token sync rules for distributing tokens to external tools. */
  tokenSync: TokenSyncRuleConfig[];
  /** Unified cron jobs. */
  cronJobs: CronJobConfig[];
  /** Registered services managed by PM2. */
  services: ServiceConfig[];
  /** Bot menu config (千人千面菜单). */
  botMenu: BotMenuConfig;
  /** Proxy settings for outbound HTTP requests. */
  proxy: ProxyConfig;
  /** Embedding config for vector search (optional). */
  embedding?: EmbeddingConfig;
  /** Google API config for Gemini image generation (optional). */
  google?: GoogleConfig;
  /** MCP servers to inject into ACP sessions. */
  mcp: McpServerEntry[];
  tracing: TracingConfig;
  logLevel: string;
}

function defaultAgentConfig(): AcpAgentConfig {
  return { timeout: 300, allowedTools: [], apiKey: null, baseUrl: null };
}

function defaultProviderConfig(): ProviderConfig {
  return {
    default: "claude",
    claude: defaultAgentConfig(),
    codex: defaultAgentConfig(),
  };
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
    provider: defaultProviderConfig(),
    feishu: defaultFeishuConfig(),
    tokenSync: [],
    cronJobs: [],
    services: [],
    botMenu: {},
    proxy: { http: "", noProxy: "" },
    plugins: { dir: join(homedir(), ".remi", "plugins"), enabled: [], allowExternal: true },
    pluginConfigs: {},
    auth: { adminEmails: [] },
    mcp: [],
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
