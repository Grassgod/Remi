/**
 * Configuration loading from environment variables and remi.toml.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

const REMI_HOME = join(homedir(), ".remi");
const CONFIG_FILENAME = "remi.toml";

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
  /** Optional explicit provider name for tests/legacy integrations. Prefer `default`. */
  name?: string;
  /** Optional fallback provider name for tests/legacy integrations. */
  fallback?: string | null;
  /** Legacy provider-wide tool allowlist. Prefer per-agent `allowedTools`. */
  allowedTools?: string[];
  /** Legacy provider-wide model. Prefer per-agent `model`. */
  model?: string | null;
  /** Legacy provider-wide timeout. Prefer per-agent `timeout`. */
  timeout?: number;
  /** Legacy provider-wide API key. Prefer per-agent `apiKey`. */
  apiKey?: string | null;
  /** Legacy provider-wide API base URL. Prefer per-agent `baseUrl`. */
  baseUrl?: string | null;
  /** Legacy provider-wide executable. Prefer per-agent `executable`. */
  executable?: string | null;
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
 * Can be specified as [[cron.jobs]] in remi.toml.
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
 * Plugin system settings — [plugins] in remi.toml.
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
// the SSO plugin's DB tables (sso_providers / sso_settings) — not via remi.toml.
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
  /** Plugin system settings ([plugins] in remi.toml). */
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
    name: undefined,
    fallback: null,
    allowedTools: [],
    model: null,
    timeout: 300,
    apiKey: null,
    baseUrl: null,
    executable: null,
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
 * Load configuration. Priority: ConfigStore (SQLite) > remi.toml > defaults.
 * Environment variable overrides are applied by ConfigStore.load().
 *
 * The configPath parameter forces TOML loading (used by migration and tests).
 */
export function loadConfig(configPath?: string | null): RemiConfig {
  // Try ConfigStore (DB) first — the primary path after migration
  if (!configPath) {
    try {
      const { ConfigStore } = require("./db/config-store.js");
      const { getDb } = require("./db/index.js");
      const store = new ConfigStore(getDb());
      if (!store.isEmpty()) {
        return store.load();
      }
    } catch { /* DB not available — fall through to TOML */ }
  }

  // Fallback: parse remi.toml (pre-migration or explicit path)
  return loadConfigFromToml(configPath);
}

/**
 * Parse config from remi.toml. Used for TOML→DB migration and as fallback.
 */
export function loadConfigFromToml(configPath?: string | null): RemiConfig {
  let fileData: Record<string, unknown> = {};

  if (configPath && existsSync(configPath)) {
    fileData = parseToml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } else {
    const candidates = [
      join(process.cwd(), CONFIG_FILENAME),
      join(homedir(), ".remi", CONFIG_FILENAME),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        fileData = parseToml(readFileSync(candidate, "utf-8")) as Record<string, unknown>;
        break;
      }
    }
  }

  const providerData = (fileData.provider ?? {}) as Record<string, unknown>;
  const feishuData = (fileData.feishu ?? {}) as Record<string, unknown>;
  const pluginsData = (fileData.plugins ?? {}) as Record<string, unknown>;
  const rawPluginData = (fileData.plugin ?? {}) as Record<string, unknown>;
  const pluginConfigsData: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(rawPluginData)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      pluginConfigsData[k] = v as Record<string, unknown>;
    }
  }
  const authData = (fileData.auth ?? {}) as Record<string, unknown>;
  const tokenSyncData = (fileData.token_sync ?? []) as Array<Record<string, unknown>>;
  const cronData = (fileData.cron ?? {}) as Record<string, unknown>;
  const cronJobsData = (cronData.jobs ?? []) as Array<Record<string, unknown>>;
  const servicesData = (fileData.services ?? []) as Array<Record<string, unknown>>;
  const mcpData = (fileData.mcp ?? {}) as Record<string, unknown>;
  const mcpServersData = (mcpData.servers ?? []) as Array<Record<string, unknown>>;
  const proxyData = (fileData.proxy ?? {}) as Record<string, unknown>;
  const embeddingData = fileData.embedding as Record<string, unknown> | undefined;
  const googleData = fileData.google as Record<string, unknown> | undefined;
  const botMenuData = (fileData.bot_menu ?? {}) as Record<string, unknown>;

  const env = process.env;

  const parseAgentConfig = (data: Record<string, unknown>, legacy: Record<string, unknown> = {}): AcpAgentConfig => ({
    executable: (data.executable ?? legacy.executable) as string | undefined,
    model: (env.REMI_MODEL ?? data.model ?? legacy.model) as string | undefined,
    timeout: parseInt(env.REMI_TIMEOUT ?? String(data.timeout ?? legacy.timeout ?? 300), 10),
    allowedTools: ((data.allowed_tools ?? legacy.allowed_tools) as string[]) ?? [],
    apiKey: (env.REMI_API_KEY ?? data.api_key ?? legacy.api_key ?? null) as string | null,
    baseUrl: (env.REMI_BASE_URL ?? data.base_url ?? legacy.base_url ?? null) as string | null,
  });

  const claudeData = (providerData.claude ?? {}) as Record<string, unknown>;
  const codexData = (providerData.codex ?? {}) as Record<string, unknown>;

  return {
    provider: {
      default: (env.REMI_PROVIDER ?? (providerData.default as string) ?? providerData.name ?? "claude") as "claude" | "codex",
      claude: parseAgentConfig(claudeData, providerData),
      codex: parseAgentConfig(codexData),
      name: (env.REMI_PROVIDER ?? providerData.name) as string | undefined,
      fallback: (env.REMI_FALLBACK ?? providerData.fallback ?? null) as string | null,
      allowedTools: ((providerData.allowed_tools as string[]) ?? []),
      model: (env.REMI_MODEL ?? providerData.model ?? null) as string | null,
      timeout: parseInt(env.REMI_TIMEOUT ?? String(providerData.timeout ?? 300), 10),
      apiKey: (env.REMI_API_KEY ?? providerData.api_key ?? null) as string | null,
      baseUrl: (env.REMI_BASE_URL ?? providerData.base_url ?? null) as string | null,
      executable: (providerData.executable ?? null) as string | null,
    },
    feishu: {
      appId: env.FEISHU_APP_ID ?? (feishuData.app_id as string) ?? "",
      appSecret: env.FEISHU_APP_SECRET ?? (feishuData.app_secret as string) ?? "",
      verificationToken: env.FEISHU_VERIFICATION_TOKEN ?? (feishuData.verification_token as string) ?? "",
      encryptKey: env.FEISHU_ENCRYPT_KEY ?? (feishuData.encrypt_key as string) ?? "",
      port: parseInt(env.FEISHU_PORT ?? String(feishuData.port ?? 9000), 10),
      domain: (env.FEISHU_DOMAIN ?? (feishuData.domain as string) ?? "feishu") as FeishuConfig["domain"],
      connectionMode: "websocket" as const,
      userAccessToken: env.FEISHU_USER_ACCESS_TOKEN ?? (feishuData.user_access_token as string) ?? "",
      triggerUserIds: (feishuData.trigger_user_ids as string[]) ?? [],
    },
    plugins: {
      dir: (typeof pluginsData.dir === "string" ? pluginsData.dir : join(homedir(), ".remi", "plugins")).replace(
        /^~(?=\/|$)/,
        homedir(),
      ),
      enabled: Array.isArray(pluginsData.enabled) ? (pluginsData.enabled as string[]) : [],
      allowExternal: (pluginsData.allow_external as boolean) ?? true,
    },
    pluginConfigs: pluginConfigsData,
    auth: {
      adminEmails: ((authData.admin_emails as string[]) ?? [])
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    },
    tokenSync: tokenSyncData.map((r) => ({
      name: (r.name as string) ?? "",
      source: (r.source as string) ?? "",
      target: (r.target as string) ?? "",
      format: (r.format as string) ?? "raw",
      key: (r.key as string) ?? undefined,
      extraKeys: (r.extra_keys as Record<string, string>) ?? undefined,
    })),
    cronJobs: cronJobsData.map((j) => ({
      id: (j.id as string) ?? "",
      name: (j.name as string) ?? undefined,
      handler: (j.handler as string) ?? "",
      enabled: (j.enabled as boolean) ?? true,
      cron: (j.cron as string) ?? undefined,
      tz: (j.tz as string) ?? undefined,
      every: (j.every as string | number) ?? undefined,
      at: (j.at as string) ?? undefined,
      timeoutMs: j.timeout_ms != null ? parseInt(String(j.timeout_ms), 10) : undefined,
      deleteAfterRun: (j.delete_after_run as boolean) ?? undefined,
      handlerConfig: (j.handler_config as Record<string, any>) ?? undefined,
    })),
    services: servicesData.map((s) => ({
      name: (s.name as string) ?? "unnamed",
      script: (s.script as string) ?? "",
      interpreter: (s.interpreter as string) ?? "bun",
      args: (s.args as string[]) ?? [],
      cwd: (s.cwd as string) ?? homedir(),
      build: (s.build as string) ?? "",
      port: (s.port as number) ?? null,
      enabled: (s.enabled as boolean) ?? true,
    })),
    mcp: mcpServersData.map((s) => ({
      name: (s.name as string) ?? "",
      command: (s.command as string) ?? "",
      args: (s.args as string[]) ?? undefined,
      env: (s.env as Record<string, string>) ?? undefined,
      agents: (s.agents as string[]) ?? undefined,
    })),
    proxy: {
      http: (proxyData.http as string) ?? "",
      noProxy: (proxyData.no_proxy as string) ?? "",
    },
    botMenu: parseBotMenuConfig(botMenuData),
    embedding: embeddingData
      ? {
          provider: (embeddingData.provider as string) ?? "voyage",
          apiKey: (embeddingData.api_key as string) ?? "",
          model: (embeddingData.model as string) ?? undefined,
          dimensions: embeddingData.dimensions != null ? parseInt(String(embeddingData.dimensions), 10) : undefined,
        }
      : undefined,
    google: googleData
      ? {
          apiKey: env.GOOGLE_API_KEY ?? (googleData.api_key as string) ?? "",
          model: (googleData.model as string) ?? "gemini-3.1-flash-image-preview",
        }
      : undefined,
    tracing: (() => {
      const t = (fileData.tracing ?? {}) as Record<string, unknown>;
      return {
        enabled: (t.enabled as boolean) ?? true,
        logsDir: (t.logs_dir as string) ?? join(REMI_HOME, "logs"),
        tracesDir: (t.traces_dir as string) ?? join(REMI_HOME, "traces"),
        retentionDays: parseInt(String(t.retention_days ?? 60), 10),
      };
    })(),
    logLevel: env.REMI_LOG_LEVEL ?? (fileData.log_level as string) ?? "INFO",
  };
}


/**
 * Locate the remi.toml config file.
 */
export function findConfigPath(): string | null {
  const candidates = [
    join(process.cwd(), CONFIG_FILENAME),
    join(homedir(), ".remi", CONFIG_FILENAME),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ── Bot Menu TOML parsing ────────────────────────────────────

function parseBotMenuBehavior(b: Record<string, unknown>): BotMenuBehavior {
  return {
    type: (b.type as BotMenuBehavior["type"]) ?? "send_message",
    url: (b.url as string) ?? undefined,
    eventKey: (b.event_key as string) ?? undefined,
    isPrimary: (b.is_primary as boolean) ?? undefined,
  };
}

function parseBotMenuIcon(icon: Record<string, unknown>): BotMenuIcon {
  return {
    token: (icon.token as string) ?? undefined,
    color: (icon.color as string) ?? undefined,
    fileKey: (icon.file_key as string) ?? undefined,
  };
}

function parseBotMenuItem(item: Record<string, unknown>): BotMenuItemConfig {
  const behaviors = (item.behaviors as Array<Record<string, unknown>> | undefined)?.map(parseBotMenuBehavior);
  const children = (item.children as Array<Record<string, unknown>> | undefined)?.map(parseBotMenuItem);
  const icon = item.icon ? parseBotMenuIcon(item.icon as Record<string, unknown>) : undefined;

  return {
    name: (item.name as string) ?? "",
    i18nName: (item.i18n_name as Record<string, string>) ?? undefined,
    icon,
    tag: (item.tag as string) ?? undefined,
    behaviors,
    children,
  };
}

function parseBotMenuConfig(data: Record<string, unknown>): BotMenuConfig {
  const defaultItems = (data.default as Array<Record<string, unknown>> | undefined)?.map(parseBotMenuItem);
  const usersData = data.users as Array<Record<string, unknown>> | undefined;

  const users = usersData?.map((u) => ({
    userId: (u.user_id as string) ?? "",
    userIdType: (u.user_id_type as BotMenuUserConfig["userIdType"]) ?? "open_id",
    label: (u.label as string) ?? undefined,
    items: ((u.items as Array<Record<string, unknown>>) ?? []).map(parseBotMenuItem),
  }));

  return { default: defaultItems, users };
}

