/**
 * Feishu channel boot helper for the unified `remi` agent.
 *
 * The agent (one process) brings up whichever channels are configured: the
 * multiremi-server WORKER channel (handled in multiremi.ts) and the FEISHU
 * channel (here). Both share the execution core (AgentRuntime / AgentSession /
 * AcpProvider / LaneScheduler). This module is a leaf — it never imports the
 * worker CLI — so the worker foreground path can import it without a cycle.
 */

import { loadConfig, type RemiConfig } from "@shared/config.js";
import { createLogger } from "@shared/logger.js";
import type {
  BotMenuPublishResult,
  MultiremiAgent,
  MultiremiDaemonBotProject,
  ResolvedBotMenuConfig,
} from "@multiremi/contracts/types.js";

const log = createLogger("agent");

/**
 * Is the Feishu channel configured? A partial credential pair is an error so a
 * requested bot cannot silently degrade into a worker-only process.
 */
export function feishuConfigured(): boolean {
  const config = loadConfig();
  const missing = missingFeishuEnvironment(config);
  const anyCredential = Boolean(config.feishu.appId || config.feishu.appSecret);
  if (anyCredential && missing.length > 0) {
    throw new Error(`Feishu channel cannot start; missing env: ${missing.join(", ")}`);
  }
  return missing.length === 0;
}

/**
 * Overlay control-plane credentials onto the local config. Only the five bot
 * identity fields move; ports, tracing and menu settings stay local, because
 * they describe this machine rather than the bot.
 */
function withFeishuCredentials(config: RemiConfig, credentials?: FeishuChannelCredentials): RemiConfig {
  if (!credentials) return config;
  return {
    ...config,
    feishu: {
      ...config.feishu,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: credentials.domain,
      verificationToken: credentials.verificationToken ?? "",
      encryptKey: credentials.encryptKey ?? "",
    },
  };
}

function missingFeishuEnvironment(config: RemiConfig): string[] {
  const missing: string[] = [];
  if (!config.feishu.appId) missing.push("FEISHU_APP_ID");
  if (!config.feishu.appSecret) missing.push("FEISHU_APP_SECRET");
  return missing;
}

/**
 * Credentials handed down from the control plane (MUL-206) instead of read
 * from `FEISHU_APP_*` on this machine. Present only in memory, for as long as
 * the channel runs.
 */
export interface FeishuChannelCredentials {
  appId: string;
  appSecret: string;
  domain: RemiConfig["feishu"]["domain"];
  verificationToken?: string | null;
  encryptKey?: string | null;
}

/** A running Feishu channel that can be stopped. */
export interface FeishuChannelHandle {
  start: Promise<void>;
  stop: () => Promise<void>;
  updateProjects: (projects: MultiremiDaemonBotProject[]) => void;
  publishBotMenu: (config: ResolvedBotMenuConfig, dryRun: boolean) => Promise<BotMenuPublishResult>;
}

/**
 * Boot the configured Feishu channel (Remi core + FeishuConnector). Remi is
 * loaded via dynamic import so worker/server paths do not pull in the monolith.
 *
 * `options.credentials` overrides the machine's `FEISHU_*` environment. That is
 * the MUL-206 path: an admin configures the bot in Workspace settings and the
 * control plane hands the decrypted credentials down per start, so nothing has
 * to be written to this machine's env to change which bot runs here.
 */
export async function bootFeishuChannel(
  agent: MultiremiAgent,
  projects: MultiremiDaemonBotProject[],
  authorizeSender: (senderOpenId: string) => Promise<boolean>,
  options: {
    daemonPort?: number;
    workspacesRoot?: string;
    ensureTopicWorkspace?: (sessionKey: string, topicId: string) => Promise<string | null>;
    credentials?: FeishuChannelCredentials;
  } = {},
): Promise<FeishuChannelHandle> {
  const config = withFeishuCredentials(loadConfig(), options.credentials);
  const missing = missingFeishuEnvironment(config);
  if (missing.length > 0) {
    throw new Error(
      options.credentials
        ? "Feishu channel cannot start; the configured bot is missing an App ID or App Secret"
        : `Feishu channel cannot start; missing env: ${missing.join(", ")}`,
    );
  }
  const { Remi } = await import("@remi/core.js");
  const remi = Remi.boot(config, agent, projects, {
    authorizeFeishuSender: authorizeSender,
    daemonPort: options.daemonPort,
    workspacesRoot: options.workspacesRoot,
    ensureTopicWorkspace: options.ensureTopicWorkspace,
  });
  const { MenuSyncer } = await import("@connectors/feishu/menu-sync.js");
  const menuSyncer = new MenuSyncer({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain,
  });
  log.info("Starting Feishu channel");
  return {
    start: remi.start(),
    stop: () => remi.stop(),
    updateProjects: (next) => remi.setBotProjects(next),
    publishBotMenu: (menu, dryRun) => menuSyncer.syncAll(menu, { dryRun }),
  };
}
