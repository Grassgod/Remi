/**
 * Feishu channel boot helper for the Multiremi Task bridge.
 *
 * The connector owns transport and cards only. Agent execution remains in the
 * worker's standard Task -> AgentSession -> ACP path.
 */

import { loadConfig, type RemiConfig } from "@shared/config.js";
import { createLogger } from "@shared/logger.js";
import type {
  BotMenuPublishResult,
  ResolvedBotMenuConfig,
} from "@multiremi/contracts/types.js";
import { FeishuConnector } from "@connectors/feishu/index.js";
import { MenuSyncer } from "@connectors/feishu/menu-sync.js";
import type { TaskStreamingHandler } from "@connectors/base.js";

const log = createLogger("agent");

/** Apply the control-plane identity while retaining local transport settings. */
function withFeishuCredentials(config: RemiConfig, credentials: FeishuChannelCredentials): RemiConfig {
  return {
    ...config,
    feishu: {
      ...config.feishu,
      appId: credentials.appId,
      appSecret: credentials.appSecret,
      domain: credentials.domain,
    },
  };
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
}

/** A running Feishu channel that can be stopped. */
export interface FeishuChannelHandle {
  start: Promise<void>;
  stop: () => Promise<void>;
  publishBotMenu: (config: ResolvedBotMenuConfig, dryRun: boolean) => Promise<BotMenuPublishResult>;
  sendProactiveThreadReply: (input: {
    chatId: string;
    replyToMessageId?: string;
    body: string;
    idempotencyKey: string;
  }) => Promise<{ messageId: string }>;
}

export async function waitForFeishuConnectorStart(
  connector: Pick<FeishuConnector, "waitUntilReady" | "stop">,
  start: Promise<void>,
): Promise<void> {
  const stoppedBeforeReady = start.then(() => {
    throw new Error("Feishu connector stopped before becoming ready");
  });
  try {
    await Promise.race([connector.waitUntilReady(), stoppedBeforeReady]);
  } catch (error) {
    await connector.stop();
    throw error;
  }
}

/**
 * Workspace settings are the only credential source. The control plane hands
 * the decrypted identity down for this start; it is never persisted locally.
 */
export async function bootFeishuChannel(
  authorizeSender: (senderOpenId: string) => Promise<boolean>,
  options: {
    daemonPort?: number;
    workspacesRoot?: string;
    ensureTopicWorkspace?: (sessionKey: string, topicId: string) => Promise<string | null>;
    credentials: FeishuChannelCredentials;
    taskHandler: TaskStreamingHandler;
    abortTask?: (sessionKey: string) => Promise<void>;
  },
): Promise<FeishuChannelHandle> {
  const config = withFeishuCredentials(loadConfig(), options.credentials);
  if (!config.feishu.appId || !config.feishu.appSecret) {
    throw new Error("Feishu channel cannot start; the configured bot is missing an App ID or App Secret");
  }
  const connector = new FeishuConnector(config.feishu, undefined, authorizeSender);
  if (options.abortTask) connector.setAbortHandler(options.abortTask);
  const menuSyncer = new MenuSyncer({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    domain: config.feishu.domain,
  });
  log.info("Starting Feishu channel");
  const start = connector.startTask(options.taskHandler);
  await waitForFeishuConnectorStart(connector, start);
  return {
    start,
    stop: () => connector.stop(),
    publishBotMenu: (menu, dryRun) => menuSyncer.syncAll(menu, { dryRun }),
    sendProactiveThreadReply: (input) => connector.sendProactiveThreadReply(input),
  };
}
