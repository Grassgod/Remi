/**
 * Configuration loading from environment variables and remi.toml.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";

const DEFAULT_MEMORY_DIR = join(homedir(), ".remi", "memory");
const CONFIG_FILENAME = "remi.toml";

export interface ProviderConfig {
  name: string;
  fallback: string | null;
  allowedTools: string[];
  model: string | null;
  timeout: number;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  port: number;
  domain: "feishu" | "lark" | (string & {});
  connectionMode: "websocket";
  userAccessToken: string;
  /** Group chat IDs that don't require @mention to trigger a response. */
  autoReplyGroups: string[];
}

export interface SchedulerConfig {
  memoryCompactCron: string;
  heartbeatInterval: number;
}

export interface RemiConfig {
  provider: ProviderConfig;
  feishu: FeishuConfig;
  scheduler: SchedulerConfig;
  memoryDir: string;
  pidFile: string;
  logLevel: string;
  contextWarnThreshold: number;
  queueDir: string;
}

function defaultProviderConfig(): ProviderConfig {
  return {
    name: "claude_cli",
    fallback: null,
    allowedTools: [],
    model: null,
    timeout: 300,
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
    autoReplyGroups: [],
  };
}

function defaultSchedulerConfig(): SchedulerConfig {
  return {
    memoryCompactCron: "0 3 * * *",
    heartbeatInterval: 300,
  };
}

export function defaultRemiConfig(): RemiConfig {
  return {
    provider: defaultProviderConfig(),
    feishu: defaultFeishuConfig(),
    scheduler: defaultSchedulerConfig(),
    memoryDir: DEFAULT_MEMORY_DIR,
    pidFile: join(homedir(), ".remi", "remi.pid"),
    logLevel: "INFO",
    contextWarnThreshold: 6000,
    queueDir: join(homedir(), ".remi", "queue"),
  };
}

/**
 * Load configuration from environment variables and optional remi.toml.
 * Priority: environment variables > remi.toml > defaults.
 */
export function loadConfig(configPath?: string | null): RemiConfig {
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
  const schedulerData = (fileData.scheduler ?? {}) as Record<string, unknown>;

  const env = process.env;

  return {
    provider: {
      name: env.REMI_PROVIDER ?? (providerData.name as string) ?? "claude_cli",
      fallback: env.REMI_FALLBACK ?? (providerData.fallback as string) ?? null,
      allowedTools: (providerData.allowed_tools as string[]) ?? [],
      model: env.REMI_MODEL ?? (providerData.model as string) ?? null,
      timeout: parseInt(env.REMI_TIMEOUT ?? String(providerData.timeout ?? 300), 10),
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
      autoReplyGroups: (feishuData.auto_reply_groups as string[]) ?? [],
    },
    scheduler: {
      memoryCompactCron: (schedulerData.memory_compact_cron as string) ?? "0 3 * * *",
      heartbeatInterval: parseInt(
        env.REMI_HEARTBEAT ?? String(schedulerData.heartbeat_interval ?? 300),
        10,
      ),
    },
    memoryDir: env.REMI_MEMORY_DIR ?? DEFAULT_MEMORY_DIR,
    pidFile: join(homedir(), ".remi", "remi.pid"),
    logLevel: env.REMI_LOG_LEVEL ?? (fileData.log_level as string) ?? "INFO",
    contextWarnThreshold: 6000,
    queueDir: join(homedir(), ".remi", "queue"),
  };
}
