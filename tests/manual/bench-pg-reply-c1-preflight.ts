import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createMultiremiApp } from "../../packages/server/src/api/server.js";
import { percentile } from "../../packages/server/src/observability/request-metrics.js";
import {
  PostgresReplyTooLargeError,
  PostgresSyncDatabase,
  resetDbReplyLimitForTest,
} from "../../packages/server/src/store/db/postgres.js";
import { MultiremiStore } from "../../packages/server/src/store/store.js";

const samples = Number(process.env.MUL398_C1_SAMPLES ?? 31);
const warmups = 3;
const outIndex = process.argv.indexOf("--out");
const out = outIndex < 0 ? undefined : process.argv[outIndex + 1];
const adminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
if (!adminUrl || !out || !Number.isInteger(samples) || samples < 20) {
  throw new Error("A local PG target, --out, and at least 20 samples are required");
}
const url = new URL(adminUrl);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  throw new Error("This probe only accepts a loopback database");
}
const database = `mul398_c1_${process.pid}`;
const admin = new Bun.SQL(adminUrl, { max: 1 });
await admin.unsafe(`CREATE DATABASE ${database}`);
url.pathname = `/${database}`;
const db = new PostgresSyncDatabase(url.toString());
const originalLimit = process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
function useLimit(limit: "off" | "8mb"): void {
  process.env.MULTIREMI_PG_REPLY_MAX_BYTES = limit === "off" ? "0" : "8388608";
  resetDbReplyLimitForTest();
}
try {
  useLimit("off");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const agent = store.createAgent({ id: "agt_c1_probe", name: "C1 probe", provider: "codex", workspaceId: "local" });
  store.registerRuntime({
    id: "rt_c1_probe", name: "C1 probe", provider: "codex", workspaceId: "local",
    daemonId: "daemon-c1-probe", ownerId: "local",
  });
  const task = store.createTask({ id: "tsk_c1_probe", agentId: agent.id, workspaceId: "local", prompt: "C1 probe" });
  if (store.claimTask("rt_c1_probe")?.id !== task.id) throw new Error("Probe task was not claimed");
  store.startTask(task.id);
  const access = await store.createAccessToken({
    name: "C1 local probe", type: "daemon", workspaceId: "local", daemonId: "daemon-c1-probe",
  });
  const app = createMultiremiApp({
    store, authToken: crypto.randomUUID(), backgroundJobs: false,
    requestMetrics: {
      enabled: true, slowRequestMs: 500, summaryIntervalMs: 60_000,
      summaryTopRoutes: 10, bufferCapacity: 512, role: "all",
    },
  });
  const batches: unknown[] = [];
  for (const batchSize of [1, 10, 50]) {
    const times: Record<string, number[]> = { off: [], "8mb": [] };
    const queries: Record<string, number[]> = { off: [], "8mb": [] };
    const deltas: number[] = [];
    for (let index = 0; index < warmups + samples; index += 1) {
      const pair: Record<string, number> = {};
      // Alternate order to avoid attributing a warm cache or host load to a profile.
      const order: Array<"off" | "8mb"> = index % 2 ? ["8mb", "off"] : ["off", "8mb"];
      for (const profile of order) {
        useLimit(profile);
        const messages = Array.from({ length: batchSize }, (_, offset) => ({
          seq: offset + 1, type: "text", content: `${index}/${profile}/${offset} ${"x".repeat(1024)}`,
        }));
        const started = performance.now();
        const response = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${access.token}`, "content-type": "application/json" },
          body: JSON.stringify({ messages }),
        });
        await response.text();
        const elapsed = performance.now() - started;
        if (response.status !== 200) throw new Error(`Message batch status: ${response.status}`);
        const queryMatch = response.headers.get("Server-Timing")?.match(/dbq;desc="(\d+)"/);
        if (!queryMatch) throw new Error("Missing production query counter");
        pair[profile] = elapsed;
        if (index >= warmups) {
          times[profile]!.push(elapsed);
          queries[profile]!.push(Number(queryMatch[1]));
        }
      }
      if (index >= warmups) deltas.push(pair["8mb"]! - pair.off!);
    }
    batches.push({
      batchSize,
      baseline: { limit: 0, queries: [...new Set(queries.off)], p50Ms: percentile(times.off!, .5), p95Ms: percentile(times.off!, .95) },
      default8mbProbe: { limit: 8388608, queries: [...new Set(queries["8mb"])], p50Ms: percentile(times["8mb"]!, .5), p95Ms: percentile(times["8mb"]!, .95) },
      pairedExtraP95Ms: percentile(deltas, .95), times, deltas,
    });
  }

  useLimit("off");
  const autopilot = store.createAutopilot({
    id: "aut_c1_probe", title: "C1 background probe", workspaceId: "local",
    assigneeId: agent.id, status: "active", executionMode: "run_only",
  });
  const insert = db.prepare(`INSERT INTO multiremi_autopilot_runs
    (id, autopilot_id, source, status, triggered_at, created_at, schedule_batch_id, schedule_prompt, payload)
    VALUES (?, ?, 'schedule', 'queued', ?, ?, ?, ?, ?)`);
  const now = "2026-09-28T00:00:00.000Z";
  // The scheduler reads all queued prompts before validating any target.
  // 20 half-MiB prompts fit the existing 64-MiB bridge but not the proposed default.
  db.transaction(() => {
    for (let index = 0; index < 20; index += 1) {
      insert.run(`run_c1_${index}`, autopilot.id, now, now, "batch_c1", "x".repeat(512 * 1024), "{}");
    }
  })();
  let background: Record<string, unknown>;
  useLimit("8mb");
  try {
    store.advanceScheduledTargetRuns();
    background = { rejected: false };
  } catch (error) {
    if (!(error instanceof PostgresReplyTooLargeError)) throw error;
    background = { rejected: true, bytes: error.bytes, maxBytes: error.maxBytes, method: "<background>", route: "<background>" };
  }
  useLimit("off");
  store.advanceScheduledTargetRuns();
  background.baselineCompleted = true;
  const result = {
    stage: "preflight-main-limit-emulation", samples, warmups,
    fixture: { batchSizes: [1, 10, 50], contentBytes: 1024, scheduledRuns: 20, schedulePromptBytes: 512 * 1024 },
    batches, background,
  };
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    batches: batches.map((batch) => {
      const { times, deltas, ...summary } = batch as Record<string, unknown>;
      return summary;
    }),
    background,
  }));
} finally {
  if (originalLimit === undefined) delete process.env.MULTIREMI_PG_REPLY_MAX_BYTES;
  else process.env.MULTIREMI_PG_REPLY_MAX_BYTES = originalLimit;
  resetDbReplyLimitForTest();
  db.close();
  await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
  await admin.end();
}
