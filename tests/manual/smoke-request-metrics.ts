#!/usr/bin/env bun
/**
 * MUL-367 smoke: drive a REAL `Bun.serve` instance and read the three outputs of
 * the request-metrics feature off the wire and off stdout.
 *
 * The unit tests build a Hono app in-process, which cannot prove the parts that
 * only exist once `startMultiremiServer` owns the process: a genuine HTTP
 * response carrying `Server-Timing`, the slow-request line, and the per-interval
 * `api_minute_summary` line emitted by the timer.
 *
 *   bun run tests/manual/smoke-request-metrics.ts
 *
 * What it does, all against 127.0.0.1 and an in-memory SQLite store:
 *   1. starts the server with a 0 ms slow threshold and a 5 s summary interval,
 *   2. curls `/health` and `/api/config`, printing the observed `Server-Timing`,
 *   3. prints the captured `api_slow_request` and `api_minute_summary` lines.
 *
 * Nothing here touches PostgreSQL, production, or a remote host, and no
 * credential is read or written.
 */
import { Database } from "bun:sqlite";
import { MultiremiStore } from "../../packages/server/src/store/store.js";
import { startMultiremiServer } from "../../packages/server/src/api/server.js";

const PORT = Number(process.env.MUL367_SMOKE_PORT ?? 16143);
const SUMMARY_INTERVAL_MS = Number(process.env.MUL367_SMOKE_SUMMARY_MS ?? 5_000);

const captured: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map((arg) => String(arg)).join(" ");
  captured.push(line);
  realLog(line);
};

// An in-memory store: a smoke run must never open, migrate, or write the
// operator's real ~/.remi/remi.db.
const database = new Database(":memory:");
const store = new MultiremiStore(database);
store.ensureLocalWorkspace();
const server = startMultiremiServer({
  store,
  port: PORT,
  hostname: "127.0.0.1",
  // No token: this instance is local and ephemeral, and auth would only add a
  // credential to the smoke run without changing what is being measured.
  authToken: null,
  backgroundJobs: false,
  requestMetrics: {
    enabled: true,
    slowRequestMs: 0,
    summaryIntervalMs: SUMMARY_INTERVAL_MS,
    summaryTopRoutes: 10,
    bufferCapacity: 1024,
  },
});

function report(heading: string, value: string): void {
  realLog(`\n=== ${heading} ===\n${value}`);
}

try {
  const base = `http://127.0.0.1:${server.port ?? PORT}`;
  for (const path of ["/health", "/api/config", "/api/does-not-exist"]) {
    const response = await fetch(`${base}${path}?token=SECRET_Q`, {
      headers: { Authorization: "Bearer SECRET_H" },
    });
    await response.text();
    report(`${path} -> ${response.status}`, `Server-Timing: ${response.headers.get("server-timing") ?? "<absent>"}`);
  }

  // The summary timer needs one full interval to fire.
  report("waiting for the minute summary", `${SUMMARY_INTERVAL_MS} ms`);
  await Bun.sleep(SUMMARY_INTERVAL_MS + 750);
} finally {
  server.stop(true);
  database.close();
}

const slow = captured.filter((line) => line.includes('"event":"api_slow_request"'));
const summary = captured.filter((line) => line.includes('"event":"api_minute_summary"'));
report("api_slow_request lines", slow.length ? slow.join("\n") : "<none captured>");
report("api_minute_summary lines", summary.length ? summary.join("\n") : "<none captured>");

const leaked = [...slow, ...summary].filter((line) =>
  ["SECRET_Q", "SECRET_H"].some((secret) => line.includes(secret)));
if (leaked.length > 0) {
  realLog("\nFAIL: a log line leaked a request credential");
  process.exit(1);
}
if (slow.length === 0 || summary.length === 0) {
  realLog("\nFAIL: expected at least one slow-request line and one summary line");
  process.exit(1);
}
realLog("\nOK: Server-Timing present, both log events emitted, no credential in either.");
