/**
 * Unified `remi` agent boot.
 *
 * One process that brings up whichever input channels are configured:
 *   - the multiremi-server WORKER channel (pull tasks → run via the shared core),
 *     when a server + provider are available, and
 *   - the FEISHU channel (push messages → Remi core), when Feishu creds exist.
 *
 * Both channels share the same execution core (AgentRuntime / AgentSession /
 * AcpProvider / LaneScheduler). The worker keeps its own machine-orchestration
 * responsibilities (repo checkout, workspace GC, heartbeat); it is co-resident,
 * not shoehorned through the Connector interface.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../shared/logger.js";
import { resolveWorkerDaemons, type CliOptions } from "./multiremi.js";

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
    const { loadConfig } = require("../shared/config.js");
    const cfg = loadConfig();
    return Boolean(cfg.feishu?.appId && cfg.feishu?.appSecret);
  } catch {
    return false;
  }
}

/**
 * Boot the agent in the foreground: start the worker channel (if any provider is
 * healthy) and the Feishu channel (if configured), in this single process.
 * Resolves when all started channels exit.
 */
export async function runAgentForeground(options: CliOptions): Promise<void> {
  const daemons = await resolveWorkerDaemons(options);
  const wantFeishu = feishuConfigured();

  if (daemons.length === 0 && !wantFeishu) {
    throw new Error(
      "Nothing to start. Configure the multiremi server (run `remi setup`) and/or Feishu, then run `remi start`.",
    );
  }

  const starts: Promise<void>[] = [];
  let remi: { stop: () => Promise<void> } | null = null;

  if (daemons.length > 0) {
    log.info(`Starting multiremi worker channel (${daemons.length} runtime${daemons.length > 1 ? "s" : ""})`);
    for (const daemon of daemons) starts.push(daemon.start());
  }

  if (wantFeishu) {
    const { Remi } = await import("../remi/core.js");
    const { loadConfig } = await import("../shared/config.js");
    const booted = Remi.boot(loadConfig());
    remi = booted;
    log.info("Starting Feishu channel");
    starts.push(booted.start());
  }

  const stopAll = (): void => {
    for (const daemon of daemons) daemon.stop();
    remi?.stop().catch(() => {});
  };
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);

  await Promise.all(starts);
}
