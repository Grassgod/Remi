/**
 * Configuration loading from environment variables and remi.toml.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
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
  /** @deprecated Use `allowedGroups` + `monitorGroups` instead. */
  autoReplyGroups: string[];
  /** Whitelist of group chat IDs allowed to interact with Remi. Empty = no restriction. */
  allowedGroups: string[];
  /** Group chat IDs where Remi reads all messages without requiring @mention. */
  monitorGroups: string[];
  /** User open_ids that trigger bot replies when @mentioned in allowed groups. */
  triggerUserIds: string[];
}

export interface ScheduledSkillConfig {
  /** Skill name — maps to .claude/skills/{name}/SKILL.md under Remi data dir. */
  name: string;
  enabled: boolean;
  /** Hour to generate the report (0-23). */
  generateHour: number;
  /** Hour to push the report (0-23). */
  pushHour: number;
  /** Minute within pushHour to push. */
  pushMinute: number;
  /** Chat IDs to push the report to. */
  pushTargets: string[];
  /** Connector name to use for pushing (default: "feishu"). */
  connectorName: string;
  /** Directory to store generated report files. */
  outputDir: string;
  /** Max content length before truncation on push (default: 4000). */
  maxPushLength: number;
}

export interface SchedulerConfig {
  memoryCompactCron: string;
  heartbeatInterval: number;
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
 * Bot profile — configurable bot persona for specific groups.
 * Each profile overrides provider defaults (cwd, tools, system prompt)
 * and can control reply behavior (thread vs direct).
 */
export interface BotProfile {
  /** Unique identifier for this bot profile. */
  id: string;
  /** Display name. */
  name: string;
  /** Group chat IDs where this bot profile is active. */
  groups: string[];
  /** Working directory for Claude Code (loads CLAUDE.md from here). */
  cwd: string;
  /** Allowed tools whitelist. Empty = use global default. */
  allowedTools: string[];
  /** Additional directories to add (--add-dir). */
  addDirs: string[];
  /** Reply mode: "thread" = reply under user's message, "direct" = reply in chat. */
  replyMode: "thread" | "direct";
  /** Override system prompt. Empty = use default. */
  systemPrompt: string;
}

export interface ByteDanceSSOConfig {
  clientId: string;
  ssoHost: string;
  bytecloudHost: string;
  scopes: string[];
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

export interface TracingConfig {
  enabled: boolean;
  logsDir: string;
  tracesDir: string;
  retentionDays: number;
  langsmithApiKey: string;
  langsmithEndpoint: string;
  langsmithProject: string;
}

export interface RemiConfig {
  provider: ProviderConfig;
  feishu: FeishuConfig;
  /** ByteDance SSO config (optional). */
  bytedanceSso?: ByteDanceSSOConfig;
  /** Token sync rules for distributing tokens to external tools. */
  tokenSync: TokenSyncRuleConfig[];
  /** @deprecated Use `cronJobs` instead. Kept for migration compatibility. */
  scheduler: SchedulerConfig;
  /** @deprecated Use `cronJobs` instead. Kept for migration compatibility. */
  scheduledSkills: ScheduledSkillConfig[];
  /** Unified cron jobs — the new scheduler config. */
  cronJobs: CronJobConfig[];
  /** Registered services managed by PM2. */
  services: ServiceConfig[];
  /** Registered project aliases: alias → absolute path. */
  projects: Record<string, string>;
  /** Configurable bot profiles for specific groups. */
  bots: BotProfile[];
  /** Bot menu config (千人千面菜单). */
  botMenu: BotMenuConfig;
  /** Proxy settings for outbound HTTP requests. */
  proxy: ProxyConfig;
  /** Embedding config for vector search (optional). */
  embedding?: EmbeddingConfig;
  /** Google API config for Gemini image generation (optional). */
  google?: GoogleConfig;
  tracing: TracingConfig;
  memoryDir: string;
  pidFile: string;
  logLevel: string;
  contextWarnThreshold: number;
  queueDir: string;
  sessionsFile: string;
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
    allowedGroups: [],
    monitorGroups: [],
    triggerUserIds: [],
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
    tokenSync: [],
    scheduler: defaultSchedulerConfig(),
    scheduledSkills: [],
    cronJobs: [],
    services: [],
    projects: {},
    bots: [],
    botMenu: {},
    proxy: { http: "", noProxy: "" },
    tracing: {
      enabled: true,
      logsDir: join(homedir(), ".remi", "logs"),
      tracesDir: join(homedir(), ".remi", "traces"),
      retentionDays: 60,
      langsmithApiKey: "",
      langsmithEndpoint: "https://api.smith.langchain.com",
      langsmithProject: "Remi",
    },
    memoryDir: DEFAULT_MEMORY_DIR,
    pidFile: join(homedir(), ".remi", "remi.pid"),
    logLevel: "INFO",
    contextWarnThreshold: 6000,
    queueDir: join(homedir(), ".remi", "queue"),
    sessionsFile: join(homedir(), ".remi", "sessions.json"),
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
  const bytedanceSsoData = fileData.bytedance_sso as Record<string, unknown> | undefined;
  const tokenSyncData = (fileData.token_sync ?? []) as Array<Record<string, unknown>>;
  const schedulerData = (fileData.scheduler ?? {}) as Record<string, unknown>;
  const scheduledSkillsData = (fileData.scheduled_skills ?? []) as Array<Record<string, unknown>>;
  const cronData = (fileData.cron ?? {}) as Record<string, unknown>;
  const cronJobsData = (cronData.jobs ?? []) as Array<Record<string, unknown>>;
  const servicesData = (fileData.services ?? []) as Array<Record<string, unknown>>;
  const botsData = (fileData.bots ?? []) as Array<Record<string, unknown>>;
  const proxyData = (fileData.proxy ?? {}) as Record<string, unknown>;
  const embeddingData = fileData.embedding as Record<string, unknown> | undefined;
  const googleData = fileData.google as Record<string, unknown> | undefined;
  const projectsData = (fileData.projects ?? {}) as Record<string, string>;
  const botMenuData = (fileData.bot_menu ?? {}) as Record<string, unknown>;

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
      allowedGroups: (feishuData.allowed_groups as string[]) ?? [],
      monitorGroups: (feishuData.monitor_groups as string[]) ??
                     (feishuData.auto_reply_groups as string[]) ?? [],
      triggerUserIds: (feishuData.trigger_user_ids as string[]) ?? [],
    },
    bytedanceSso: bytedanceSsoData
      ? {
          clientId: env.BYTEDANCE_SSO_CLIENT_ID ?? (bytedanceSsoData.client_id as string) ?? "",
          ssoHost: env.BYTEDANCE_SSO_HOST ?? (bytedanceSsoData.sso_host as string) ?? "https://sso.bytedance.com",
          bytecloudHost: env.BYTEDANCE_BYTECLOUD_HOST ?? (bytedanceSsoData.bytecloud_host as string) ?? "https://cloud.bytedance.net",
          scopes: (bytedanceSsoData.scopes as string[]) ?? ["read", "ciam.device.read"],
        }
      : undefined,
    tokenSync: tokenSyncData.map((r) => ({
      name: (r.name as string) ?? "",
      source: (r.source as string) ?? "",
      target: (r.target as string) ?? "",
      format: (r.format as string) ?? "raw",
      key: (r.key as string) ?? undefined,
      extraKeys: (r.extra_keys as Record<string, string>) ?? undefined,
    })),
    scheduler: {
      memoryCompactCron: (schedulerData.memory_compact_cron as string) ?? "0 3 * * *",
      heartbeatInterval: parseInt(
        env.REMI_HEARTBEAT ?? String(schedulerData.heartbeat_interval ?? 300),
        10,
      ),
    },
    scheduledSkills: scheduledSkillsData.map((s) => ({
      name: (s.name as string) ?? "",
      enabled: (s.enabled as boolean) ?? true,
      generateHour: parseInt(String(s.generate_hour ?? 6), 10),
      pushHour: parseInt(String(s.push_hour ?? 9), 10),
      pushMinute: parseInt(String(s.push_minute ?? 0), 10),
      pushTargets: (s.push_targets as string[]) ?? [],
      connectorName: (s.connector_name as string) ?? "feishu",
      outputDir: (s.output_dir as string) ?? join(homedir(), ".remi", "skill-reports", (s.name as string) ?? "unknown"),
      maxPushLength: parseInt(String(s.max_push_length ?? 4000), 10),
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
    proxy: {
      http: (proxyData.http as string) ?? "",
      noProxy: (proxyData.no_proxy as string) ?? "",
    },
    projects: projectsData,
    bots: botsData.map((b) => ({
      id: (b.id as string) ?? "",
      name: (b.name as string) ?? "",
      groups: (b.groups as string[]) ?? [],
      cwd: (b.cwd as string) ?? "",
      allowedTools: (b.allowed_tools as string[]) ?? [],
      addDirs: (b.add_dirs as string[]) ?? [],
      replyMode: ((b.reply_mode as string) ?? "direct") as BotProfile["replyMode"],
      systemPrompt: (b.system_prompt as string) ?? "",
    })),
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
        logsDir: (t.logs_dir as string) ?? join(homedir(), ".remi", "logs"),
        tracesDir: (t.traces_dir as string) ?? join(homedir(), ".remi", "traces"),
        retentionDays: parseInt(String(t.retention_days ?? 60), 10),
        langsmithApiKey: (t.langsmith_api_key as string) ?? "",
        langsmithEndpoint: (t.langsmith_endpoint as string) ?? "https://api.smith.langchain.com",
        langsmithProject: (t.langsmith_project as string) ?? "Remi",
      };
    })(),
    memoryDir: env.REMI_MEMORY_DIR ?? DEFAULT_MEMORY_DIR,
    pidFile: join(homedir(), ".remi", "remi.pid"),
    logLevel: env.REMI_LOG_LEVEL ?? (fileData.log_level as string) ?? "INFO",
    contextWarnThreshold: 6000,
    queueDir: join(homedir(), ".remi", "queue"),
    sessionsFile: join(homedir(), ".remi", "sessions.json"),
  };
}

/**
 * Get the effective cron jobs list.
 * If `config.cronJobs` is populated (new format), use it directly.
 * Otherwise, fall back to legacy migration from [scheduler] + [[scheduled_skills]].
 */
export function migrateToCronJobs(config: RemiConfig): CronJobConfig[] {
  if (config.cronJobs.length > 0) {
    return config.cronJobs;
  }

  // Legacy fallback — auto-migrate from old format
  return _legacyToCronJobs(config);
}

function _legacyToCronJobs(config: RemiConfig): CronJobConfig[] {
  const jobs: CronJobConfig[] = [];
  const compactHour = parseCronHourFromExpr(config.scheduler.memoryCompactCron);

  jobs.push(
    { id: "builtin:heartbeat", name: "Heartbeat", handler: "builtin:heartbeat", every: `${config.scheduler.heartbeatInterval}s` },
    { id: "builtin:compaction", name: "Memory Compaction", handler: "builtin:compaction", cron: config.scheduler.memoryCompactCron },
    { id: "builtin:cleanup", name: "Cleanup", handler: "builtin:cleanup", cron: `1 ${compactHour} * * *` },
    { id: "builtin:cli-metrics", name: "CLI Metrics", handler: "builtin:cli-metrics", cron: `2 ${compactHour} * * *` },
  );

  for (const skill of config.scheduledSkills) {
    if (!skill.name) continue;
    jobs.push({
      id: `skill:${skill.name}:gen`, name: `${skill.name} (generate)`,
      handler: "skill:gen", enabled: skill.enabled,
      cron: `0 ${skill.generateHour} * * *`,
      handlerConfig: { skillName: skill.name, outputDir: skill.outputDir },
    });
    jobs.push({
      id: `skill:${skill.name}:push`, name: `${skill.name} (push)`,
      handler: "skill:push", enabled: skill.enabled,
      cron: `${skill.pushMinute} ${skill.pushHour} * * *`,
      handlerConfig: {
        skillName: skill.name, outputDir: skill.outputDir,
        connectorName: skill.connectorName, pushTargets: skill.pushTargets,
        maxPushLength: skill.maxPushLength,
      },
    });
  }

  return jobs;
}

/**
 * Write-through migration: rewrite remi.toml from old format to new [[cron.jobs]].
 *
 * - Detects if old [scheduler] or [[scheduled_skills]] sections exist
 * - Converts them to [[cron.jobs]]
 * - Removes old sections from the file
 * - Backs up the original as remi.toml.bak
 *
 * Returns true if migration was performed, false if already migrated or no file found.
 */
export function migrateConfigFile(configPath?: string): boolean {
  const filePath = configPath ?? findConfigPath();
  if (!filePath) return false;

  const raw = readFileSync(filePath, "utf-8");

  // Check if already migrated: has [[cron.jobs]] and no [scheduler] or [[scheduled_skills]]
  const hasCronJobs = /^\[\[cron\.jobs\]\]/m.test(raw);
  const hasScheduler = /^\[scheduler\]/m.test(raw);
  const hasScheduledSkills = /^\[\[scheduled_skills\]\]/m.test(raw);

  if (hasCronJobs && !hasScheduler && !hasScheduledSkills) {
    return false; // Already migrated
  }

  if (!hasScheduler && !hasScheduledSkills) {
    return false; // Nothing to migrate
  }

  // Parse the old config to get migration data
  const config = loadConfig(filePath);
  const cronJobs = _legacyToCronJobs(config);

  // Backup original
  const bakPath = filePath + ".bak";
  copyFileSync(filePath, bakPath);

  // Remove old sections from raw text and append new [[cron.jobs]]
  let newRaw = raw;

  // Remove [scheduler] section (header + all subsequent lines until next section header)
  newRaw = newRaw.replace(/^\[scheduler\]\r?\n(?:(?!\[)[^\r\n]*\r?\n?)*/gm, "");

  // Remove all [[scheduled_skills]] blocks (header + all subsequent lines until next section header)
  newRaw = newRaw.replace(/^\[\[scheduled_skills\]\]\r?\n(?:(?!\[)[^\r\n]*\r?\n?)*/gm, "");

  // Clean up excessive blank lines
  newRaw = newRaw.replace(/\n{3,}/g, "\n\n").trimEnd();

  // Build [[cron.jobs]] TOML text
  const cronText = buildCronJobsToml(cronJobs);

  newRaw += "\n\n# ── Cron Jobs (migrated from [scheduler] + [[scheduled_skills]]) ──\n\n" + cronText;

  writeFileSync(filePath, newRaw, "utf-8");
  return true;
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

/**
 * Build TOML text for [[cron.jobs]] entries.
 */
function buildCronJobsToml(jobs: CronJobConfig[]): string {
  const lines: string[] = [];

  for (const job of jobs) {
    lines.push("[[cron.jobs]]");
    lines.push(`id = ${tomlStr(job.id)}`);
    if (job.name) lines.push(`name = ${tomlStr(job.name)}`);
    lines.push(`handler = ${tomlStr(job.handler)}`);
    if (job.enabled === false) lines.push(`enabled = false`);
    if (job.cron) lines.push(`cron = ${tomlStr(job.cron)}`);
    if (job.tz) lines.push(`tz = ${tomlStr(job.tz)}`);
    if (job.every) lines.push(`every = ${tomlStr(String(job.every))}`);
    if (job.at) lines.push(`at = ${tomlStr(job.at)}`);
    if (job.timeoutMs) lines.push(`timeout_ms = ${job.timeoutMs}`);
    if (job.deleteAfterRun) lines.push(`delete_after_run = true`);

    // handler_config as a sub-table
    if (job.handlerConfig && Object.keys(job.handlerConfig).length > 0) {
      lines.push("");
      lines.push("[cron.jobs.handler_config]");
      for (const [k, v] of Object.entries(job.handlerConfig)) {
        const key = k; // Keep camelCase keys as-is to match handler expectations
        if (typeof v === "string") {
          lines.push(`${key} = ${tomlStr(v)}`);
        } else if (typeof v === "number") {
          lines.push(`${key} = ${v}`);
        } else if (typeof v === "boolean") {
          lines.push(`${key} = ${v}`);
        } else if (Array.isArray(v)) {
          lines.push(`${key} = [${v.map((s) => tomlStr(String(s))).join(", ")}]`);
        }
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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

function parseCronHourFromExpr(cronExpr: string): number {
  const parts = cronExpr.split(" ");
  if (parts.length >= 2) {
    const hour = parseInt(parts[1], 10);
    if (!isNaN(hour)) return hour;
  }
  return 3;
}
