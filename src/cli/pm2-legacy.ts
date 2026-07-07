/**
 * `remi pm2 [start|stop]` — Legacy PM2 management command.
 * Kept for backward compatibility. Users should prefer `remi start` / `remi stop`.
 */

import { loadConfig } from "@shared/config.js";
import { pm2Start, pm2Stop } from "../daemon/pm2.js";
import { setLogLevel, createLogger } from "@shared/logger.js";

const log = createLogger("pm2");

export async function runPm2Legacy(args: string[]): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);

  const sub = args[0] ?? "start";
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
