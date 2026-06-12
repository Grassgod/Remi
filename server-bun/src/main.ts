/**
 * Bun server entrypoint. `bun run src/main.ts` serves the Hono app.
 * (Bun reads the default export { port, fetch } and starts the server.)
 */

import { createApp } from "./http/app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { createLogger } from "./logger.js";
import { websocket } from "./http/ws.js";
import { SchedulerManager } from "./scheduler/manager.js";
import { sweepDueAutopilotTriggers } from "./agent/autopilotScheduler.js";

const log = createLogger("server");
const cfg = loadConfig();
const dbHandle = cfg.databaseUrl ? createDb(cfg.databaseUrl) : undefined;
const app = createApp(cfg, dbHandle?.db);

log.info(`Multimira (bun) server starting on :${cfg.port}`);
if (!cfg.jwtSecret) log.warn("JWT_SECRET is empty — auth will reject all tokens");
if (!dbHandle) log.warn("DATABASE_URL is empty — DB-backed routes disabled");

// Background cron: fire due scheduled autopilots. The sys_cron_executions
// lease makes this safe to run on every replica (only one wins each minute).
const schedulerAbort = new AbortController();
if (dbHandle) {
  const scheduler = new SchedulerManager(dbHandle.db, { tickIntervalMs: 60_000 });
  scheduler.register({
    name: "autopilot_schedule_sweep",
    cadenceMs: 60_000,
    handler: async () => {
      await sweepDueAutopilotTriggers(dbHandle.db);
    },
  });
  void scheduler.run(schedulerAbort.signal);
  process.on("SIGINT", () => schedulerAbort.abort());
  process.on("SIGTERM", () => schedulerAbort.abort());
}

export default {
  port: cfg.port,
  fetch: app.fetch,
  websocket,
};
