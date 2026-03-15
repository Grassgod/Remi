#!/usr/bin/env bun
/**
 * Entry point: bun run src/main.ts [serve]
 *
 * - No args / "chat": Interactive CLI REPL (development/testing)
 * - "serve":          Production mode (PM2 subprocess, with connectors + scheduler)
 */

import { loadConfig, migrateConfigFile, migrateToCronJobs } from "./config.js";
import { Remi } from "./core.js";
import { CLIConnector } from "./connectors/cli.js";
import { setLogLevel, createLogger, initLogPersistence } from "./logger.js";
import { runAuth } from "./auth/oauth-cli.js";
import { pm2Start, pm2Stop } from "./pm2.js";
import { initLangSmith } from "./langsmith-exporter.js";

const log = createLogger("main");

function runCli(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  if (config.tracing.enabled) initLogPersistence(config.tracing.logsDir);
  initLangSmith(config.tracing);

  const remi = Remi.boot(config);

  const cli = new CLIConnector();
  remi.addConnector(cli);

  remi.start().catch((e: Error) => {
    if (e.name !== "AbortError") {
      log.error("Error:", e);
      process.exit(1);
    }
  });
}

async function runServe(): Promise<void> {
  let config = loadConfig();
  setLogLevel(config.logLevel);
  if (config.tracing.enabled) initLogPersistence(config.tracing.logsDir);
  initLangSmith(config.tracing);

  // One-time migration: [scheduler] + [[scheduled_skills]] → [[cron.jobs]]
  if (migrateConfigFile()) {
    log.info("Config migrated: [scheduler] + [[scheduled_skills]] → [[cron.jobs]]");
    config = loadConfig();
  }

  const remi = Remi.boot(config);

  // PM2 sends SIGTERM to stop
  process.on("SIGTERM", () => { remi.queue.stop(); remi.stop(); });
  process.on("SIGINT", () => { remi.queue.stop(); remi.stop(); });

  // Start BunQueue workers (conversation + memory + cron)
  await remi.queue.start();

  // Register cron schedulers from config (replaces CronTimer)
  const cronJobs = migrateToCronJobs(config);
  await remi.queue.setupSchedulers(cronJobs, remi);

  log.info("=".repeat(60));
  log.info(`Remi starting at ${new Date().toISOString()} (pid=${process.pid}, provider=${config.provider.name})`);

  // Send restart notification after connectors have time to initialize
  setTimeout(() => remi.sendRestartNotify(), 5000);

  try {
    await remi.start();
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      throw e;
    }
  } finally {
    await remi.queue.stop();
    await remi.stop();
    log.info("Remi stopped.");
  }
}

function runPm2(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const sub = process.argv[3] ?? "start";
  switch (sub) {
    case "start":
      pm2Start(config);
      break;
    case "stop":
      pm2Stop();
      break;
    default:
      log.info("Usage: remi pm2 [start|stop]");
      log.info("  start — Build services, generate ecosystem config, start all with PM2");
      log.info("  stop  — Stop all PM2-managed services");
      process.exit(1);
  }
}

function main(): void {
  const cmd = process.argv[2] ?? "chat";

  switch (cmd) {
    case "chat":
    case "repl":
      runCli();
      break;
    case "serve":
      runServe().catch((e: Error) => {
        log.error("Serve error:", e);
        process.exit(1);
      });
      break;
    case "auth":
      runAuth(process.argv[3]).catch((e: Error) => {
        log.error("Auth error:", e);
        process.exit(1);
      });
      break;
    case "pm2":
      runPm2();
      break;
    default:
      log.info("Usage: bun run src/main.ts [chat|serve|auth|pm2]");
      log.info("  chat   — Interactive CLI REPL (default)");
      log.info("  serve  — Production mode with connectors + scheduler");
      log.info("  auth   — Feishu OAuth authorization (obtain user_access_token)");
      log.info("  pm2    — Manage all services with PM2 (start/stop)");
      process.exit(1);
  }
}

main();
