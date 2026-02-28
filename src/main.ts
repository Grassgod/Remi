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
    default:
      log.info("Usage: bun run src/main.ts [chat|serve|auth]");
      log.info("  chat   — Interactive CLI REPL (default)");
      log.info("  serve  — Daemon mode with connectors + scheduler");
      log.info("  auth   — Feishu OAuth authorization (obtain user_access_token)");
      process.exit(1);
  }
}

main();
