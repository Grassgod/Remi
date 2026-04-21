#!/usr/bin/env bun
/**
 * Manually trigger an agent cron job by POSTing to the running Remi
 * daemon's board HTTP API (so the daemon's cron worker executes it).
 *
 * Usage: bun run scripts/trigger-agent.ts <agent-name>
 * Example: bun run scripts/trigger-agent.ts wiki-curate
 */

import { loadConfig } from "../src/config.js";

const agentName = process.argv[2];
if (!agentName) {
  console.error("Usage: bun run scripts/trigger-agent.ts <agent-name>");
  process.exit(1);
}

const config = loadConfig();
const handler = `agent:${agentName}`;
const cronJob = config.cronJobs.find((j) => j.handler === handler);
if (!cronJob) {
  console.error(`No cron job found with handler=${handler}`);
  console.error(`Available: ${config.cronJobs.map((j) => j.id).join(", ")}`);
  process.exit(1);
}

const res = await fetch("http://localhost:8090/api/internal/enqueue-cron", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jobId: cronJob.id,
    handler,
    handlerConfig: cronJob.handlerConfig ?? {},
  }),
});

if (!res.ok) {
  console.error(`HTTP ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const data = await res.json();
console.log(`✓ Enqueued ${handler}:`, data);
console.log(`Watch daemon logs: pm2 logs remi`);
