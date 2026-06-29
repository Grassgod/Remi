/**
 * `remi serve` — Production daemon mode (PM2 subprocess).
 */

import { loadConfig } from "../shared/config.js";
import { Remi } from "../remi/core.js";
import { setLogLevel, createLogger, initLogPersistence } from "../shared/logger.js";
import { startWebDashboard, stopWebDashboard } from "../remi/admin/server.js";

const log = createLogger("serve");

export async function runServe(_args: string[]): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  if (config.tracing.enabled) initLogPersistence(config.tracing.logsDir);

  const remi = Remi.boot(config);

  // PM2 sends SIGTERM to stop — must exit promptly to avoid SIGKILL zombie processes
  const gracefulShutdown = async (signal: string) => {
    log.info(`${signal} received — shutting down gracefully...`);
    try {
      await Promise.race([
        (async () => {
          try { stopWebDashboard(); } catch { /* ignore */ }
          await remi.queue.stop();
          await remi.stop();
        })(),
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

  // Register cron schedulers from config
  await remi.queue.setupSchedulers(config.cronJobs, remi);

  // ── Start the unified Web Dashboard HTTP server in this same process ──
  try {
    const { port } = startWebDashboard({
      port: parseInt(process.env.REMI_WEB_PORT ?? "6120", 10),
      authToken: process.env.REMI_WEB_AUTH_TOKEN,
    });
    log.info(`Web Dashboard mounted on :${port} (same process as daemon)`);
  } catch (err) {
    log.error("Failed to start Web Dashboard:", err);
  }

  log.info("=".repeat(60));
  log.info(`Remi starting at ${new Date().toISOString()} (pid=${process.pid}, provider=${`acp:${config.provider.default}`})`);

  // Send restart notification after connectors have time to initialize
  setTimeout(() => remi.sendRestartNotify(), 5000);

  try {
    await remi.start();
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      throw e;
    }
  } finally {
    try { stopWebDashboard(); } catch { /* ignore */ }
    await remi.queue.stop();
    await remi.stop();
    log.info("Remi stopped.");
  }
}
