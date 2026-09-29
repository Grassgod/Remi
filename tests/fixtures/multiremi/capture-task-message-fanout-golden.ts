#!/usr/bin/env bun
/**
 * MUL-474 (MUL-383 S8e): capture the browser task-message fan-out golden.
 *
 * Run this on the commit whose frames are the contract. The harness is
 * implementation-agnostic — it imports whatever
 * `notifyBrowserTaskMessages(store, workspaceRegistry, scopeRegistry, task, messages)`
 * the checkout provides — so running it on the pre-change commit and again after
 * the subject narrowing produces the same bytes whenever the payload did not
 * drift:
 *
 *   bun run tests/fixtures/multiremi/capture-task-message-fanout-golden.ts
 *
 * `mul474-daemon-task-poll-count.test.ts` reads
 * `task-message-fanout-golden.json` and fails on any difference.
 */
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { notifyBrowserTaskMessages } from "@multiremi/api/realtime.js";
import {
  driveTaskMessageFanout,
  fanoutFixtureStore,
  installDeterministicFanoutClock,
} from "./task-message-fanout-fixture.js";

const OUT_PATH = join(import.meta.dir, "task-message-fanout-golden.json");

const restoreClock = installDeterministicFanoutClock();
const db = openSqliteDatabase(":memory:");
try {
  const store = fanoutFixtureStore(db);
  const frames = driveTaskMessageFanout(store, notifyBrowserTaskMessages);
  const golden = {
    name: "MUL-474 browser task-message fan-out frames",
    capturedAt: "<timestamp>",
    source: "pre-change implementation (parent commit of the subject narrowing)",
    ...frames,
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(golden, null, 2)}\n`);
  console.log(`wrote ${OUT_PATH}`);
  console.log(`workspace frames: ${frames.workspaceFrames.length}, chat frames: ${frames.chatFrames.length}, denied: ${frames.deniedFrames.length}`);
  for (const frame of frames.workspaceFrames) console.log(`  ${frame}`);
  for (const frame of frames.chatFrames) console.log(`  ${frame}`);
} finally {
  restoreClock();
  db.close();
}
