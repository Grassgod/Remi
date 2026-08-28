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

function missingFeishuEnvironment(config: RemiConfig): string[] {
  const missing: string[] = [];
  if (!config.feishu.appId) missing.push("FEISHU_APP_ID");
  if (!config.feishu.appSecret) missing.push("FEISHU_APP_SECRET");
  return missing;
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
 */
export async function bootFeishuChannel(
  agent: MultiremiAgent,
  projects: MultiremiDaemonBotProject[],
  authorizeSender: (senderOpenId: string) => Promise<boolean>,
): Promise<FeishuChannelHandle> {
  const config = loadConfig();
  const missing = missingFeishuEnvironment(config);
  if (missing.length > 0) {
    throw new Error(`Feishu channel cannot start; missing env: ${missing.join(", ")}`);
  }
  const { Remi } = await import("@remi/core.js");
  const remi = Remi.boot(config, agent, projects, { authorizeFeishuSender: authorizeSender });
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
