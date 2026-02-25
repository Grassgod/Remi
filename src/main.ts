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

function runCli(): void {
  const config = loadConfig();

  const daemon = new RemiDaemon(config);
  const remi = daemon._buildRemi();

  const cli = new CLIConnector();
  remi.addConnector(cli);

  remi.start().catch((e: Error) => {
    if (e.name !== "AbortError") {
      console.error("Error:", e);
      process.exit(1);
    }
  });
}

function runServe(): void {
  const config = loadConfig();

  const daemon = new RemiDaemon(config);
  daemon.run().catch((e: Error) => {
    console.error("Daemon error:", e);
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
    default:
      console.log("Usage: bun run src/main.ts [chat|serve]");
      console.log("  chat   — Interactive CLI REPL (default)");
      console.log("  serve  — Daemon mode with connectors + scheduler");
      process.exit(1);
  }
}

main();
