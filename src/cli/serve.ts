/**
 * `remi serve` — Production daemon mode (PM2 subprocess).
 */

import { loadConfig, migrateConfigFile, migrateToCronJobs } from "../config.js";
import { Remi } from "../core.js";
import { setLogLevel, createLogger, initLogPersistence } from "../logger.js";
import { MissionStore } from "../mission/store.js";
import { startBoardServer } from "../../web/board/server.js";
import { registerMissionActionHandler } from "../connectors/feishu/card-actions.js";
import { createFeishuClient } from "../connectors/feishu/client.js";
import { sendToThread } from "../connectors/feishu/thread.js";
import { getDb } from "../db/index.js";

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

  // Wire mission enqueue to Feishu connector (for mission thread routing)
  const feishuConnector = remi.getFeishuConnector();
  if (feishuConnector) {
    feishuConnector.setQueueRef((data) => remi.queue.enqueueMission(data));
  }

  // Register cron schedulers from config (replaces CronTimer)
  const cronJobs = migrateToCronJobs(config);
  await remi.queue.setupSchedulers(cronJobs, remi);

  // Start Mission Board web server (port 8090)
  try {
    const missionStore = new MissionStore();
    const feishuClient = config.feishu.appId
      ? createFeishuClient({
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          domain: config.feishu.domain,
        })
      : undefined;
    startBoardServer({
      config,
      missionStore,
      authToken: process.env.REMI_WEB_AUTH_TOKEN,
      feishuClient,
      enqueueMission: (data) => remi.queue.enqueueMission(data),
      enqueueCron: (data) => remi.queue.enqueueCron(data),
    });

    // Register mission approve/reject handler for Feishu card buttons
    registerMissionActionHandler((actionType, missionId) => {
      const mission = missionStore.getById(missionId);
      if (!mission) return;

      if (actionType === "mission_approve") {
        missionStore.updateStatus(missionId, "in_progress");
        remi.queue.enqueueMission({ missionId, step: "rfc" }).catch((err) => {
          log.error(`Failed to enqueue mission ${missionId}:`, err);
        });
        log.info(`Mission ${missionId} approved, pipeline started`);
        if (mission.threadId) {
          sendToThread(mission.chatId, mission.threadId, "**Mission 已审批通过** — 开始执行 RFC 阶段").catch(() => {});
        }
      } else if (actionType === "mission_reject") {
        missionStore.updateStatus(missionId, "rejected");
        log.info(`Mission ${missionId} rejected`);
        if (mission.threadId) {
          sendToThread(mission.chatId, mission.threadId, "**Mission 已驳回**").catch(() => {});
        }
      }
    });
  } catch (err) {
    log.warn(`Board server failed to start: ${(err as Error).message}`);
  }

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
