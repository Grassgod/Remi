#!/usr/bin/env bun
/**
 * MUL-474 (MUL-383 S8e): capture the `GET /api/daemon/tasks/:id/status` golden.
 *
 * Run this on the commit whose response body is the contract. The harness is
 * implementation-agnostic, so running it on the pre-change commit and again after
 * the read-path change produces the same bytes whenever the body did not drift:
 *
 *   bun run tests/fixtures/multiremi/capture-daemon-task-poll-golden.ts
 *
 * `mul474-daemon-task-poll-count.test.ts` reads
 * `daemon-task-poll-golden.json` and fails on any difference. The two timestamps
 * the body echoes (`started_at`, `completed_at`) and the receipt id are pinned so
 * the comparison is exact rather than a shape check.
 */
import type { SQLQueryBindings } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  DAEMON_TASK_POLL_EXTERNAL_MESSAGE_ID,
  seedDaemonTaskPollFixture,
  seedDaemonTaskPollResultCases,
} from "./daemon-task-poll-fixture.js";

const OUT_PATH = join(import.meta.dir, "daemon-task-poll-golden.json");
const AUTH_TOKEN = "mul474-count-token";
const PINNED_STARTED_AT = "2026-09-27T00:00:00.000Z";

process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");

const db = openSqliteDatabase(":memory:");
const store = new MultiremiStore(db);
store.ensureLocalWorkspace();
const fixture = await seedDaemonTaskPollFixture(store, {
  run: (sql, params) => { db.run(sql, params as SQLQueryBindings[]); },
});
// Pin the one clock-dependent field the `status` body echoes.
db.run("UPDATE multiremi_tasks SET started_at = ? WHERE id = ?", [PINNED_STARTED_AT, fixture.taskId]);

const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
const response = await app.request(`/api/daemon/tasks/${fixture.taskId}/status`, {
  headers: { Authorization: `Bearer ${fixture.daemonToken}` },
});
if (response.status !== 200) throw new Error(`capture failed: HTTP ${response.status} ${await response.text()}`);
const statusBody = await response.json() as unknown;

// The stored-`result` shapes the projection's fallbacks have to survive. Their
// bodies are captured the same way as the running Task's above.
const resultCases = await seedDaemonTaskPollResultCases(store, (sql, params) => {
  db.run(sql, params as SQLQueryBindings[]);
});
const resultBodies: Array<{ label: string; taskId: string; body: unknown }> = [];
for (const testCase of resultCases) {
  const caseResponse = await app.request(`/api/daemon/tasks/${testCase.taskId}/status`, {
    headers: { Authorization: `Bearer ${fixture.daemonToken}` },
  });
  if (caseResponse.status !== 200) {
    throw new Error(`capture failed for ${testCase.label}: HTTP ${caseResponse.status} ${await caseResponse.text()}`);
  }
  resultBodies.push({ label: testCase.label, taskId: testCase.taskId, body: await caseResponse.json() });
}

const golden = {
  name: "MUL-474 daemon GET task status response",
  capturedAt: "<timestamp>",
  source: "pre-change implementation (parent commit of agent/MUL-474)",
  fixture: {
    taskId: fixture.taskId,
    promptBytes: fixture.promptBytes,
    receiptMessageId: DAEMON_TASK_POLL_EXTERNAL_MESSAGE_ID,
    startedAt: PINNED_STARTED_AT,
  },
  statusBody,
  resultBodies,
};
writeFileSync(OUT_PATH, `${JSON.stringify(golden, null, 2)}\n`);
console.log(`wrote ${OUT_PATH}`);
console.log(JSON.stringify(statusBody, null, 2));

db.close();
