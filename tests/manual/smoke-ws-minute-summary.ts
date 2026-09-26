#!/usr/bin/env bun
/**
 * MUL-417 smoke: prove `ws_minute_summary` is emitted by a real server.
 *
 * The unit tests drive the summary with an injected timer and a fake ring. What
 * only a real process shows is the wiring: `startMultiremiServer` starts the
 * timer, the session reports each frame, and the line reaches stdout with the
 * per-frame-type fields. This is the acceptance item "本地起 API 后
 * `ws_minute_summary` 有输出".
 *
 *   bun run tests/manual/smoke-ws-minute-summary.ts
 *
 * Everything is 127.0.0.1 and an in-memory SQLite: no PostgreSQL, no production,
 * no credential is read or written.
 */
import { Database } from "bun:sqlite";
import { startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { DAEMON_PROTOCOL_VERSION } from "@multiremi/contracts/daemon-protocol.js";

const PORT = Number(process.env.MUL417_SMOKE_PORT ?? 16_271);
const SUMMARY_INTERVAL_MS = Number(process.env.MUL417_SMOKE_SUMMARY_MS ?? 2_000);

const captured: string[] = [];
const realLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map((arg) => String(arg)).join(" ");
  captured.push(line);
  realLog(line);
};

const database = new Database(":memory:");
const store = new MultiremiStore(database);
store.ensureLocalWorkspace();
store.createWorkspaceMember({ workspaceId: "local", userId: "owner-1", name: "Owner", role: "owner" });
store.registerRuntime({ id: "rt_smoke", name: "smoke runtime", provider: "codex", daemonId: "dmn_smoke", workspaceId: "local" });
const token = await store.createAccessToken({
  name: "smoke daemon",
  type: "daemon",
  workspaceId: "local",
  daemonId: "dmn_smoke",
  userId: "owner-1",
});

const server = startMultiremiServer({
  store,
  scheduler: null,
  port: PORT,
  hostname: "127.0.0.1",
  authToken: "smoke-root",
  backgroundJobs: false,
  requestMetrics: {
    enabled: true,
    slowRequestMs: 500,
    summaryIntervalMs: SUMMARY_INTERVAL_MS,
    summaryTopRoutes: 10,
    bufferCapacity: 1024,
  },
});

try {
  const socket = new WebSocket(
    `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
    { headers: { Authorization: `Bearer ${token.token}` } } as never,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({
    v: DAEMON_PROTOCOL_VERSION,
    t: "hello",
    ts: Date.now(),
    p: {
      protocol: DAEMON_PROTOCOL_VERSION,
      daemon_id: "dmn_smoke",
      cli_version: "0.2.83",
      launched_by: null,
      runtimes: [{ runtime_id: "rt_smoke", provider: "codex", max_concurrency: 1, active_task_ids: [] }],
      caps: [],
    },
  }));
  await Bun.sleep(150);
  for (let index = 0; index < 3; index += 1) {
    socket.send(JSON.stringify({
      v: DAEMON_PROTOCOL_VERSION,
      t: "hb",
      ts: Date.now(),
      p: { active_task_count: 0, drain_ack_generation: 0 },
    }));
  }
  await Bun.sleep(200);

  realLog(`\nwaiting ${SUMMARY_INTERVAL_MS} ms for the ws summary window\n`);
  await Bun.sleep(SUMMARY_INTERVAL_MS + 500);
  socket.close();
} finally {
  await Bun.sleep(100);
  server.stop(true);
  database.close();
}

const wsLines = captured.filter((line) => line.includes('"event":"ws_minute_summary"'));
const apiLines = captured.filter((line) => line.includes('"event":"api_minute_summary"'));
realLog(`\n=== ws_minute_summary (${wsLines.length}) ===`);
for (const line of wsLines) realLog(line);
realLog(`\n=== api_minute_summary (${apiLines.length}, for the shared window) ===`);
for (const line of apiLines) realLog(line);

if (wsLines.length === 0) {
  realLog("\nFAIL: no ws_minute_summary line was emitted");
  process.exit(1);
}
const first = JSON.parse(wsLines[0]!) as { frames: number; types: Array<{ type: string; count: number }> };
const hb = first.types.find((entry) => entry.type === "hb");
realLog(`\nOK: frames=${first.frames}, hb.count=${hb?.count ?? 0}`);
if (!hb || hb.count < 3) {
  realLog("FAIL: hb frames were not summarised");
  process.exit(1);
}
