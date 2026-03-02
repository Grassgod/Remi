#!/usr/bin/env bun
/**
 * Entry point: bun run src/main.ts [serve]
 *
 * - No args / "chat": Interactive CLI REPL (development/testing)
 * - "serve":          Daemon mode (production, with connectors + scheduler)
 */

import { loadConfig } from "./config.js";
import { CLIConnector } from "./connectors/cli.js";
import { RemiDaemon } from "./daemon.js";
import { setLogLevel, createLogger } from "./logger.js";
import { runAuth } from "./auth/oauth-cli.js";
import { pm2Start, pm2Stop } from "./pm2.js";

const log = createLogger("main");

function runCli(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const daemon = new RemiDaemon(config);
  const remi = daemon._buildRemi();

  const cli = new CLIConnector();
  remi.addConnector(cli);

  remi.start().catch((e: Error) => {
    if (e.name !== "AbortError") {
      log.error("Error:", e);
      process.exit(1);
    }
  });
}

function runServe(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const daemon = new RemiDaemon(config);
  daemon.run().catch((e: Error) => {
    log.error("Daemon error:", e);
    process.exit(1);
  });
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
      runServe();
      break;
    case "auth":
      runAuth().catch((e: Error) => {
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
      log.info("  serve  — Daemon mode with connectors + scheduler");
      log.info("  auth   — Feishu OAuth authorization (obtain user_access_token)");
      log.info("  pm2    — Manage all services with PM2 (start/stop)");
      process.exit(1);
  }
}

main();
