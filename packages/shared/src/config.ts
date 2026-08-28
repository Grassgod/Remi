/** Remi connector and plugin configuration assembled from defaults + env. */

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
 * Per-plugin config is supplied through REMI_PLUGIN_CONFIGS_JSON.
 */
export interface PluginsConfig {
  /** Directory scanned for external drop-in plugins. Default ~/.remi/plugins. */
  dir: string;
  /** Plugin ids explicitly enabled (allowlist; complements [plugin.<id>].enabled). */
  enabled: string[];
  /** Load external plugins from `dir`. Default true. */
  allowExternal: boolean;
}

export interface TokenSyncRuleConfig {
  name: string;
  source: string;
  target: string;
  format: "mirror" | "json_kv" | "bytedcli_token" | "raw" | "env";
  key?: string;
  extraKeys?: Record<string, string>;
}

export interface GoogleConfig {
  apiKey: string;
}

export interface RemiConfig {
  feishu: FeishuConfig;
  /** Plugin system settings. */
  plugins: PluginsConfig;
  /** Per-plugin config keyed by plugin id. */
  pluginConfigs: Record<string, Record<string, unknown>>;
  /** Token sync rules for distributing tokens to external tools. */
  tokenSync: TokenSyncRuleConfig[];
  /** Google API config for Gemini image generation (optional). */
  google?: GoogleConfig;
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
    plugins: { dir: join(homedir(), ".remi", "plugins"), enabled: [], allowExternal: true },
    pluginConfigs: {},
    logLevel: "INFO",
  };
}

type Environment = Record<string, string | undefined>;

function parseInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function parseJson<T>(
  name: string,
  value: string | undefined,
  fallback: T,
  valid: (input: unknown) => boolean,
): T {
  if (!value) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must contain valid JSON`, { cause: error });
  }
  if (!valid(parsed)) throw new Error(`${name} has an invalid JSON shape`);
  return parsed as T;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function isTokenSyncRule(input: unknown): boolean {
  if (!isRecord(input)) return false;
  const formats = ["mirror", "json_kv", "bytedcli_token", "raw", "env"];
  if (
    typeof input.name !== "string"
    || typeof input.source !== "string"
    || typeof input.target !== "string"
    || typeof input.format !== "string"
    || !formats.includes(input.format)
  ) return false;
  if (input.key !== undefined && typeof input.key !== "string") return false;
  if (input.extraKeys !== undefined) {
    if (!isRecord(input.extraKeys)) return false;
    if (!Object.values(input.extraKeys).every((value) => typeof value === "string")) return false;
  }
  return true;
}

/** Load configuration without reading or writing local state. */
export function loadConfig(env: Environment = process.env): RemiConfig {
  const defaults = defaultRemiConfig();
  const domain = env.FEISHU_DOMAIN || defaults.feishu.domain;
  if (domain !== "feishu" && domain !== "lark" && domain !== "bytedance") {
    throw new Error("FEISHU_DOMAIN must be feishu, lark, or bytedance");
  }

  const tokenSync = parseJson<TokenSyncRuleConfig[]>(
    "REMI_TOKEN_SYNC_RULES_JSON",
    env.REMI_TOKEN_SYNC_RULES_JSON,
    defaults.tokenSync,
    (input) => Array.isArray(input) && input.every(isTokenSyncRule),
  );
  const enabledPlugins = parseJson<string[]>(
    "REMI_PLUGINS_ENABLED_JSON",
    env.REMI_PLUGINS_ENABLED_JSON,
    defaults.plugins.enabled,
    (input) => Array.isArray(input) && input.every((item) => typeof item === "string"),
  );
  const pluginConfigs = parseJson<Record<string, Record<string, unknown>>>(
    "REMI_PLUGIN_CONFIGS_JSON",
    env.REMI_PLUGIN_CONFIGS_JSON,
    defaults.pluginConfigs,
    (input) => isRecord(input) && Object.values(input).every(isRecord),
  );

  return {
    feishu: {
      ...defaults.feishu,
      appId: env.FEISHU_APP_ID || defaults.feishu.appId,
      appSecret: env.FEISHU_APP_SECRET || defaults.feishu.appSecret,
      verificationToken: env.FEISHU_VERIFICATION_TOKEN || defaults.feishu.verificationToken,
      encryptKey: env.FEISHU_ENCRYPT_KEY || defaults.feishu.encryptKey,
      port: parseInteger("FEISHU_PORT", env.FEISHU_PORT, defaults.feishu.port),
      domain,
      userAccessToken: env.FEISHU_USER_ACCESS_TOKEN || defaults.feishu.userAccessToken,
    },
    tokenSync,
    plugins: {
      dir: env.REMI_PLUGINS_DIR || defaults.plugins.dir,
      enabled: enabledPlugins,
      allowExternal: parseBoolean(
        "REMI_PLUGINS_ALLOW_EXTERNAL",
        env.REMI_PLUGINS_ALLOW_EXTERNAL,
        defaults.plugins.allowExternal,
      ),
    },
    pluginConfigs,
    ...(env.GOOGLE_API_KEY ? { google: { apiKey: env.GOOGLE_API_KEY } } : {}),
    logLevel: env.REMI_LOG_LEVEL ?? defaults.logLevel,
  };
}
