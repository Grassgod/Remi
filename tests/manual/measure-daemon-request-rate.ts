/**
 * Measure what one idle daemon actually sends per minute (MUL-377).
 *
 * The review asks for a first-hand number rather than an estimate, broken down
 * by lane. This runs a real `MultiremiDaemon` against a real Bun API server and
 * reads the counts from the API's own per-minute metrics line
 * (`api_minute_summary`, MUL-367), so the numbers are the requests the server
 * actually served — not an estimate or a wrapper the daemon could bypass.
 *
 *   bun run tests/manual/measure-daemon-request-rate.ts [seconds] [--concierge]
 *
 * `--concierge` simulates the control plane assigning the workspace bot to this
 * Runtime, which is the state the 3s heartbeat exists for. Without it the daemon
 * is the candidate host every machine runs: offered the host, never assigned.
 */

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import type { FeishuConciergeHost } from "../../packages/server/src/worker/feishu-concierge.js";

const args = process.argv.slice(2);
/**
 * `--host-only` attaches the concierge host without an assignment: exactly what
 * `attachControlPlaneConciergeHosts()` gives every long-running daemon, and the
 * condition that must NOT produce a 3s heartbeat. `--concierge` additionally
 * assigns the bot to this Runtime, which is the condition that must.
 */
const hostOnly = args.includes("--host-only");
const concierge = args.includes("--concierge");
const seconds = Number(args.find((arg) => /^\d+$/.test(arg)) ?? 60);

const db = new Database(":memory:");
const store = new MultiremiStore(db);
store.ensureLocalWorkspace();
const token = await store.createAccessToken({
  name: `Request rate probe${concierge ? " (concierge)" : hostOnly ? " (host only)" : ""}`,
  type: "daemon",
  workspaceId: "local",
  daemonId: `rate-${concierge ? "concierge" : hostOnly ? "host" : "plain"}`,
});

const root = mkdtempSync(join(tmpdir(), "remi-request-rate-"));


const server = startMultiremiServer({
  store,
  scheduler: null,
  authToken: "rate-probe-root",
  hostname: "127.0.0.1",
  port: 0,
});
const baseUrl = `http://127.0.0.1:${server.port}`;

const daemon = new MultiremiDaemon({
  serverUrl: baseUrl,
  token: token.token,
  daemonId: `rate-${concierge ? "concierge" : hostOnly ? "host" : "plain"}`,
  runtimeName: "Request rate probe",
  provider: "claude",
  workspaceId: "local",
  daemonPort: 0,
  gcEnabled: false,
  workspacesRoot: join(root, "workspaces"),
  repoCacheRoot: join(root, "repos"),
  pluginCacheRoot: join(root, "plugins"),
  providerFactory: () => ({
    async *sendStream() {},
    getLastResponse: () => null,
  }),
  sshMeshManager: {
    getHeartbeatStatus: () => ({ status: "disabled" }),
    reconcile: async () => {},
    cleanupForRetirement: async () => {},
  },
});

// Capture the API's own summary lines instead of re-counting requests: these
// are the requests the server actually served, per route.
interface MinuteSummaryLine {
  window_ms: number;
  requests: number;
  routes: Array<{ method: string; route: string; count: number }>;
}
const summaries: MinuteSummaryLine[] = [];
const originalLog = console.log;
let capture = true;
console.log = (...values: unknown[]) => {
  if (capture && typeof values[0] === "string" && values[0].includes('"api_minute_summary"')) {
    try {
      summaries.push(JSON.parse(values[0]) as MinuteSummaryLine);
      return;
    } catch {
      // Fall through to the real sink so a malformed line is still visible.
    }
  }
  originalLog(...values);
};

if (concierge || hostOnly) {
  // Advertise the concierge capability (as the real CLI does before start) and
  // answer a start with an online bot, so an assignment would take.
  const host: FeishuConciergeHost = {
    start: async () => ({ botName: "probe-bot", botOpenId: "ou_probe" }),
    stop: async () => {},
  };
  daemon.setFeishuConciergeHost(host);
}

/** Save the workspace bot pointing at `runtimeId`; retried until the daemon can host it. */
async function putBotConfig(
  app: ReturnType<typeof createMultiremiApp>,
  agentId: string,
  runtimeId: string,
): Promise<Response> {
  return app.request("/api/workspaces/local/feishu-bot", {
    method: "PUT",
    headers: { Authorization: "Bearer rate-probe-root", "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      runtime_id: runtimeId,
      app_id: "cli_rateprobe000001",
      domain: "feishu",
      enabled: true,
      app_secret: "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA",
    }),
  });
}

const startedAt = Date.now();
const run = daemon.start();

if (concierge) {
  // Point the workspace bot at this Runtime so the control plane really hands
  // it the bot. Without an assignment the daemon is merely a candidate host and
  // correctly stays on the slow cadence, which is the other case.
  const internal = daemon as unknown as { options: { runtimeId: string | null } };
  const waitStart = Date.now();
  while (!internal.options.runtimeId && Date.now() - waitStart < 20_000) await Bun.sleep(100);
  const runtimeId = internal.options.runtimeId;
  if (!runtimeId) throw new Error("daemon never registered a runtime id");
  const agent = store.createAgent({ name: "Rate probe host", provider: "claude", workspaceId: "local" });
  const app = createMultiremiApp({ store, authToken: "rate-probe-root" });
  // The daemon advertises concierge support on its first heartbeat, so the
  // assignment has to wait for that metadata rather than racing registration.
  let saved = await putBotConfig(app, agent.id, runtimeId);
  const retryStart = Date.now();
  while (saved.status !== 200 && Date.now() - retryStart < 20_000) {
    await Bun.sleep(250);
    saved = await putBotConfig(app, agent.id, runtimeId);
  }
  if (saved.status !== 200) throw new Error(`bot config failed: ${saved.status} ${await saved.text()}`);
  console.log(`[probe] bot assigned to ${runtimeId}`);
}

await Bun.sleep(seconds * 1000);
const elapsedMs = Date.now() - startedAt;
daemon.stop();
await run.catch(() => {});
// Let the final window flush so a shorter run still reports.
await Bun.sleep(100);
capture = false;
console.log = originalLog;

function laneOf(route: string): string {
  if (route === "/api/daemon/heartbeat") return "heartbeat";
  if (route.endsWith("/tasks/claim")) return "claim";
  if (route.endsWith("/agent-plugins/desired")) return "desired";
  if (route.endsWith("/agent-plugins/state")) return "plugin state";
  return route.replace("/api/daemon/", "");
}

const totals = new Map<string, number>();
for (const summary of summaries) {
  for (const entry of summary.routes) {
    const lane = laneOf(entry.route);
    totals.set(lane, (totals.get(lane) ?? 0) + entry.count);
  }
}

const windowMs = summaries.reduce((sum, summary) => sum + summary.window_ms, 0);
const minutes = Math.max(0.05, windowMs / 60_000);
const measured = summaries.reduce((sum, summary) => sum + summary.requests, 0);
const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);

const lines: string[] = [];
lines.push(`# Idle daemon request rate${concierge ? " (concierge assigned)" : hostOnly ? " (host attached, unassigned)" : " (no host)"}`);
lines.push("");
lines.push(`window: ${(elapsedMs / 1000).toFixed(1)}s across ${summaries.length} metric window(s)`);
lines.push(`heartbeat interval in effect: ${(daemon as unknown as { heartbeatIntervalMs(): number }).heartbeatIntervalMs()}ms`);
lines.push("");
lines.push("| lane | requests | per minute |");
lines.push("|---|---|---|");
for (const [lane, count] of rows) {
  lines.push(`| ${lane} | ${count} | ${(count / minutes).toFixed(1)} |`);
}
lines.push(`| **total** | **${measured}** | **${(measured / minutes).toFixed(1)}** |`);

console.log("");
console.log(lines.join("\n"));
console.log("");

daemon.stop();
server.stop(true);
db.close();
rmSync(root, { recursive: true, force: true });
