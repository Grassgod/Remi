/**
 * `remi chat` — Interactive CLI REPL (development/testing).
 */

import { loadConfig } from "../config.js";
import { Remi } from "../core.js";
import { CLIConnector } from "../connectors/cli.js";
import { setLogLevel, createLogger, initLogPersistence } from "../logger.js";

const log = createLogger("chat");

export async function runChat(_args: string[]): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  if (config.tracing.enabled) initLogPersistence(config.tracing.logsDir);

  const remi = Remi.boot(config);
  const cli = new CLIConnector();
  remi.addConnector(cli);

  try {
    await remi.start();
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      log.error("Error:", e);
      process.exit(1);
    }
  }
}
