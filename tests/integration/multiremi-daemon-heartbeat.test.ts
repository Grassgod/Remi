import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiDaemon } from "@multiremi/daemon.js";
import { MultiremiStore } from "@multiremi/store.js";

type Fault = "heartbeat-headers" | "heartbeat-body" | "plugins" | "claim" | "unavailable";

// Real Bun HTTP transport and daemon polling against an isolated API/database.
// No production Runtime, provider credentials, or operating-system service is used.
async function faultTestBed(fault: Fault, requestTimeoutMs = 250) {
  const root = mkdtempSync(join(tmpdir(), "remi-heartbeat-recovery-"));
  const db = new Database(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const token = await store.createAccessToken({
    name: "Heartbeat recovery test", type: "daemon", workspaceId: "local", daemonId: "heartbeat-test",
  });
  const app = createMultiremiApp({ store, authToken: "heartbeat-test-root" });
  const state = { armed: false, failures: 0, heartbeats: 0, claims: 0, registrations: 0 };
  const pending: Array<() => void> = [];
  const serve = (port: number) => Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      const heartbeat = path === "/api/daemon/heartbeat";
      const claim = path.endsWith("/tasks/claim");
      const matches = fault === "plugins" ? path.endsWith("/agent-plugins/desired")
        : fault === "claim" ? claim : heartbeat;
      if (state.armed && matches) {
        state.failures++;
        if (fault === "unavailable") return Response.json({ error: "temporarily unavailable" }, { status: 503 });
        if (fault === "heartbeat-body") {
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              // Send headers and an incomplete JSON body, then leave the connection open.
              controller.enqueue(new TextEncoder().encode('{"status":"' + " ".repeat(8192)));
              pending.push(() => { try { controller.close(); } catch {} });
            },
          }), { headers: { "Content-Type": "application/json" } });
        }
        return new Promise<Response>((resolve) => {
          pending.push(() => resolve(Response.json({})));
        });
      }
      const response = await app.fetch(request);
      if (response.ok) {
        if (heartbeat) state.heartbeats++;
        if (claim) state.claims++;
        if (path === "/api/daemon/register") state.registrations++;
      }
      return response;
    },
  });
  let server = serve(0);
  const port = server.port!;
  const daemon = new MultiremiDaemon({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: token.token,
    daemonId: "heartbeat-test",
    runtimeName: "Heartbeat recovery test",
    provider: "claude",
    workspaceId: "local",
    daemonPort: 0,
    pollIntervalMs: 20,
    requestTimeoutMs,
    gcEnabled: false,
    workspacesRoot: join(root, "workspaces"),
    repoCacheRoot: join(root, "repos"),
    pluginCacheRoot: join(root, "plugins"),
    providerFactory: () => ({ async *sendStream() {}, getLastResponse: () => null }),
    sshMeshManager: {
      getHeartbeatStatus: () => ({ status: "disabled" }),
      reconcile: async () => {},
      cleanupForRetirement: async () => {},
    },
  });
  let settled = false;
  let runError: unknown;
  const run = daemon.start().catch((error) => { runError = error; }).finally(() => { settled = true; });
  return {
    state, store, daemon, run,
    isSettled: () => settled,
    error: () => runError,
    disconnect: () => server.stop(true),
    reconnect: () => { server = serve(port); },
    async close() {
      daemon.stop();
      for (const release of pending) release();
      await run;
      server.stop(true);
      db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function waitUntil(check: () => boolean, description: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

describe("daemon heartbeat network recovery", () => {
  it("reconnects when the API socket closes and later listens again", async () => {
    const bed = await faultTestBed("heartbeat-headers");
    try {
      await waitUntil(() => bed.state.claims > 0, "initial healthy polling");
      await bed.disconnect();
      await Bun.sleep(150);
      expect(bed.isSettled()).toBe(false);
      const heartbeatCount = bed.state.heartbeats;
      const claimCount = bed.state.claims;
      bed.reconnect();
      await waitUntil(() => bed.state.heartbeats >= heartbeatCount + 3 && bed.state.claims >= claimCount + 3,
        "reconnection after connection refusal");
      expect(bed.error()).toBeUndefined();
      expect(bed.state.registrations).toBe(1);
    } finally {
      await bed.close();
    }
  }, 10_000);

  it.each(["heartbeat-headers", "heartbeat-body", "plugins", "claim", "unavailable"] as const)(
    "resumes heartbeats and task claims after repeated %s failures without restarting",
    async (fault) => {
      const bed = await faultTestBed(fault);
      try {
        await waitUntil(() => bed.state.claims > 0, "initial healthy polling");
        const runtimeId = bed.store.listRuntimes()[0]!.id;
        const previousHeartbeat = bed.store.listRuntimes()[0]!.lastHeartbeatAt;
        bed.state.armed = true;
        await waitUntil(() => bed.state.failures >= 2, "two failed requests");
        expect(bed.isSettled()).toBe(false);
        const heartbeatCount = bed.state.heartbeats;
        const claimCount = bed.state.claims;
        bed.state.armed = false;
        await waitUntil(() => bed.state.heartbeats >= heartbeatCount + 3 && bed.state.claims >= claimCount + 3,
          "three recovered heartbeat/claim cycles");
        expect(bed.error()).toBeUndefined();
        expect(bed.isSettled()).toBe(false);
        expect(bed.state.registrations).toBe(1);
        expect(bed.store.listRuntimes()).toHaveLength(1);
        expect(bed.store.listRuntimes()[0]!.id).toBe(runtimeId);
        expect(bed.store.listRuntimes()[0]!.lastHeartbeatAt).not.toBe(previousHeartbeat);
      } finally {
        await bed.close();
      }
    }, 10_000,
  );

  it.each(["heartbeat-headers", "heartbeat-body", "plugins"] as const)(
    "stops cleanly during a stalled %s request without waiting for its deadline",
    async (fault) => {
      const bed = await faultTestBed(fault, 30_000);
      try {
        await waitUntil(() => bed.state.claims > 0, "initial healthy polling");
        bed.state.armed = true;
        await waitUntil(() => bed.state.failures > 0, "stalled request");
        bed.daemon.stop();
        await waitUntil(bed.isSettled, "daemon shutdown", 1_000);
        expect(bed.error()).toBeUndefined();
      } finally {
        await bed.close();
      }
    }, 10_000,
  );
});
