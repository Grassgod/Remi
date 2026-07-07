/**
 * Feishu channel boot helper for the unified `remi` agent.
 *
 * The agent (one process) brings up whichever channels are configured: the
 * multiremi-server WORKER channel (handled in multiremi.ts) and the FEISHU
 * channel (here). Both share the execution core (AgentRuntime / AgentSession /
 * AcpProvider / LaneScheduler). This module is a leaf — it never imports the
 * worker CLI — so the worker foreground path can import it without a cycle.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@shared/logger.js";

const log = createLogger("agent");

/**
 * Is the Feishu channel configured? Checks env first, then the monolith config
 * DB — but ONLY if it already exists, so a worker-only machine is never forced
 * to create `~/.remi/remi.db` just to answer "no".
 */
export function feishuConfigured(): boolean {
  if (process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET) return true;
  const dbPath = join(homedir(), ".remi", "remi.db");
  if (!existsSync(dbPath)) return false;
  try {
    const { loadConfig } = require("@shared/config.js");
    const cfg = loadConfig();
    return Boolean(cfg.feishu?.appId && cfg.feishu?.appSecret);
  } catch {
    return false;
  }
}

/** A running Feishu channel that can be stopped. */
export interface FeishuChannelHandle {
  start: Promise<void>;
  stop: () => Promise<void>;
}

/**
 * Boot the Feishu channel (Remi core + FeishuConnector) if configured.
 * Returns a handle whose `start` promise resolves when the channel exits, or
 * `null` when Feishu is not configured. Remi is loaded via dynamic import so the
 * worker/server paths don't eagerly pull in the monolith.
 */
export async function bootFeishuChannel(): Promise<FeishuChannelHandle | null> {
  if (!feishuConfigured()) return null;
  const { Remi } = await import("../remi/core.js");
  const { loadConfig } = await import("@shared/config.js");
  const remi = Remi.boot(loadConfig());
  log.info("Starting Feishu channel");
  return { start: remi.start(), stop: () => remi.stop() };
}
