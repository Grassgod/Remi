/**
 * `remi serve` — Production daemon mode (PM2 subprocess).
 */

import { loadConfig, migrateConfigFile, migrateToCronJobs } from "../config.js";
import { Remi } from "../core.js";
import { setLogLevel, createLogger, initLogPersistence } from "../logger.js";

const log = createLogger("serve");

export async function runServe(_args: string[]): Promise<void> {
  let config = loadConfig();
  setLogLevel(config.logLevel);
  if (config.tracing.enabled) initLogPersistence(config.tracing.logsDir);

  // One-time migration: [scheduler] + [[scheduled_skills]] → [[cron.jobs]]
  if (migrateConfigFile()) {
    log.info("Config migrated: [scheduler] + [[scheduled_skills]] → [[cron.jobs]]");
    config = loadConfig();
  }

  const remi = Remi.boot(config);

  // PM2 sends SIGTERM to stop — must exit promptly to avoid SIGKILL zombie processes
  const gracefulShutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down gracefully...`);
    try {
      await Promise.race([
        (async () => { await remi.queue.stop(); await remi.stop(); })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 10_000)),
      ]);
    } catch {
      log.warn("Shutdown timed out, forcing exit");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => void gracefulShutdown("SIGINT"));

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
