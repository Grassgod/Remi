import { describe, expect, it, jest } from "bun:test";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMultiremiApp } from "@multiremi/api.js";
import { TestMultiremiDaemon as MultiremiDaemon } from "../fixtures/daemon-protocol.js";
import { DaemonProtocolLayer, type DaemonProtocolIdentity } from "@multiremi/api/daemon-protocol/index.js";
import type { DaemonProtocolSession } from "@multiremi/api/daemon-protocol/session.js";
import { ManualDaemonProtocolClock } from "@multiremi/api/daemon-protocol/clock.js";
import { MultiremiStore } from "@multiremi/store.js";
import { DaemonTaskOffers, prepareTaskOffer } from "@multiremi/api/daemon-protocol/task-offers.js";
import { DaemonDownlinks } from "@multiremi/api/daemon-protocol/downlinks.js";
import { runtimeInputSnapshot } from "@multiremi/api/daemon-protocol/runtime-input-snapshot.js";
import { daemonAgentPluginDesiredResponse } from "@multiremi/api/wire/agent-plugins.js";
import { createProjectKnowledgeServiceFromEnv } from "@multiremi/project-knowledge/service.js";
import { createRepositoryWikiServiceFromEnv } from "@multiremi/repository-wiki/service.js";

type Fault = "heartbeat-headers" | "heartbeat-body" | "plugins" | "claim" | "unavailable" | "retired-body" | "register";
let pollingClock: ManualDaemonProtocolClock | null = null;
let advancePoll: (() => void) | null = null;
interface FaultSocketData { identity: DaemonProtocolIdentity; session: DaemonProtocolSession | null }

// Real HTTP registration and native v2 control traffic against an isolated DB.
// No production Runtime, provider credentials, or operating-system service is used.
async function faultTestBed(fault: Fault, requestTimeoutMs = 250) {
  const root = mkdtempSync(join(tmpdir(), "remi-heartbeat-recovery-"));
  const db = openSqliteDatabase(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const token = await store.createAccessToken({
    name: "Heartbeat recovery test", type: "daemon", workspaceId: "local", daemonId: "heartbeat-test",
  });
  const app = createMultiremiApp({ store, authToken: "heartbeat-test-root" });
  const protocol = new DaemonProtocolLayer({ store });
  const clock = new ManualDaemonProtocolClock();
  pollingClock = clock;
  let pollingNow = Date.now();
  const dateNow = jest.spyOn(Date, "now").mockImplementation(() => pollingNow);
  const state = { armed: false, failures: 0, heartbeats: 0, claims: 0, registrations: 0, cleanupCalls: 0, authorityStatus: 0 };
  const claimTask = store.claimTask.bind(store);
  const claimProbe = jest.spyOn(store, "claimTask").mockImplementation((...args) => { state.claims++; return claimTask(...args); });
  const pending: Array<() => void> = [];
  const knowledge = createProjectKnowledgeServiceFromEnv(store);
  const wiki = createRepositoryWikiServiceFromEnv(store);
  const offers = new DaemonTaskOffers({ store, layer: protocol, clock,
    prepare: task => prepareTaskOffer(store, task, knowledge, wiki) });
  const downlinks = new DaemonDownlinks({ layer: protocol, snapshot: (rt, session) => runtimeInputSnapshot(store, rt, session) });
  protocol.registerRpcHandler("plugin.desired", async frame => {
    return { ok: true, ...daemonAgentPluginDesiredResponse(store.getRuntimeAgentPluginDesiredSnapshot(frame.rt!)) };
  });
  const work = new Set<Promise<void>>();
  const sockets = new Set<Bun.ServerWebSocket<FaultSocketData>>();
  const serve = (port: number) => Bun.serve<FaultSocketData>({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    fetch: async (request, server) => {
      const path = new URL(request.url).pathname;
      if (path === "/api/daemon/register" && fault === "register" && state.armed) {
        state.failures++;
        return Response.json({ error: "registration unavailable" }, { status: 503 });
      }
      if (path === "/api/daemon/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const resolved = await protocol.resolveIdentity(request, "heartbeat-test-root");
        if ("response" in resolved) return resolved.response;
        if (server.upgrade(request, { data: { identity: resolved.identity, session: null } })) return;
        return new Response("upgrade failed", { status: 400 });
      }
      const heartbeat = path === "/api/daemon/heartbeat";
      const claim = path.endsWith("/tasks/claim");
      const matches = fault === "plugins" ? path.endsWith("/agent-plugins/desired")
        : fault === "retired-body" ? path.startsWith("/api/daemon/")
          : fault === "claim" ? claim : heartbeat;
      if (state.armed && matches && (fault === "plugins" || fault === "claim")) {
        state.failures++;
        return new Promise<Response>((resolve) => {
          pending.push(() => resolve(Response.json({})));
        });
      }
      const response = await app.fetch(request);
      if (state.armed && matches && fault === "retired-body" && !response.ok) {
        state.failures++;
        state.authorityStatus = response.status;
        const body = await response.text();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(" ".repeat(8192)));
            const release = () => {
              clearTimeout(timer);
              try { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } catch {}
            };
            const timer = setTimeout(release, requestTimeoutMs * 3);
            pending.push(release);
          },
        }), { status: response.status, headers: { "Content-Type": "application/json" } });
      }
      if (response.ok) {
        if (heartbeat) state.heartbeats++;
        if (claim) state.claims++;
        if (path === "/api/daemon/register") state.registrations++;
        const terminal = path.match(/^\/api\/daemon\/tasks\/([^/]+)\/(complete|fail)$/);
        if (terminal) offers.terminal(terminal[1]!, store.getTaskIdentity(terminal[1]!)?.runtimeId ?? null);
      }
      return response;
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.data.session = protocol.openSession({
          send(text) {
            const frame = JSON.parse(text);
            if (frame.t === "task.offer") {
              if (fault === "claim" && state.armed) { state.failures++; return text.length; }
            }
            return socket.send(text);
          },
          close(code, reason) { socket.close(code, reason); },
        }, socket.data.identity);
      },
      message(socket, message) {
        const frame = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
        if (frame.t === "plugin.desired" && fault === "plugins" && state.armed) { state.failures++; return; }
        if (frame.t === "hb" && state.armed) {
          if (["heartbeat-headers", "heartbeat-body", "unavailable"].includes(fault)) {
            state.failures++;
            if (fault === "heartbeat-headers") return;
            if (fault === "heartbeat-body") socket.send('{"t":"res","p":');
            else socket.send(JSON.stringify({ v: 2, t: "res", re: frame.id, ts: clock.now(), p: { ok: false, code: "server_error", retryable: true } }));
            return;
          }
        }
        const run = socket.data.session!.handleMessage(message).then(() => {
          if (frame.t === "hb") state.heartbeats++;
        });
        work.add(run);
        void run.finally(() => work.delete(run));
      },
      close(socket) { socket.data.session?.handleSocketClose(); sockets.delete(socket); },
    },
  });
  let server = serve(0);
  const port = server.port!;
  const daemon = new MultiremiDaemon({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: token.token,
    daemonId: "heartbeat-test",
    protocolClientOptions: { clock },
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
      cleanupForRetirement: async () => { state.cleanupCalls++; },
    },
  });
  let agentId: string | null = null;
  let pushedRevision = 0;
  advancePoll = () => {
    pollingNow += 1_000; daemon.wakeClaim();
    const runtime = store.listRuntimes()[0];
    if (!runtime || !protocol.registry.sessionForRuntime(runtime.id)) return;
    offers.kick(runtime.id);
    if (fault === "claim" && !agentId) agentId = store.createAgent({ name: "Network recovery no-op", provider: "claude", runtimeId: runtime.id }).id;
    if (fault === "claim" && store.listTaskRefs({ runtimeId: runtime.id, statuses: ["queued", "dispatched", "running"] }).length === 0) {
      const task = store.createTask({ agentId: agentId!, runtimeId: runtime.id, prompt: "No-op", maxAttempts: 1 });
      offers.enqueued(task);
    }
    downlinks.kick(runtime.id);
    // Invalidate the test's desired cache so the RPC fault is exercised without
    // reintroducing the deleted 30s HTTP fallback.
    if (fault === "plugins") {
      const session = [...sockets][0]?.data.session;
      session?.sendEvent({ t: "plugin.desired_revision", rt: runtime.id, p: { revision: `fault-${++pushedRevision}` } });
    }
  };
  let settled = false;
  let runError: unknown;
  const run = daemon.start().catch((error) => { runError = error; }).finally(() => { settled = true; });
  return {
    state, store, daemon, run,
    isSettled: () => settled,
    error: () => runError,
    disconnect: () => { for (const socket of sockets) socket.close(4001, "test disconnect"); server.stop(true); },
    reconnect: () => { server = serve(port); },
    async close() {
      daemon.stop();
      for (const release of pending) release();
      await run;
      await daemon.stopAndDrainTestWork();
      await Promise.allSettled([...work]);
      protocol.closeAll();
      await protocol.drain();
      server.stop(true);
      protocol.stop();
      db.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      pollingClock = null;
      advancePoll = null;
      dateNow.mockRestore();
      claimProbe.mockRestore();
    },
  };
}

async function waitUntil(check: () => boolean, description: string, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
    advancePoll?.();
    pollingClock?.advance(1_000);
  }
}

describe("daemon heartbeat network recovery", () => {
  it("cleans up a retired daemon on v2 close without waiting for an HTTP authority body", async () => {
    const bed = await faultTestBed("retired-body");
    try {
      await waitUntil(() => bed.state.claims > 0, "initial healthy polling");
      const plan = bed.store.getDaemonRetirementPlan("local", "heartbeat-test");
      expect(bed.store.retireDaemon("local", "heartbeat-test", plan.snapshot, "local").status).toBe("retired");
      bed.state.armed = true;
      // The v2 terminal close takes priority over an HTTP response whose body
      // would be delayed by this fixture; local cleanup still runs.
      await waitUntil(() => bed.state.cleanupCalls >= 1, "retirement cleanup after an incomplete authority response", 1_500);
      expect(bed.daemon.daemonProtocolClient().connectionState()).toBe("terminal");
      expect(bed.state.authorityStatus).toBe(0);
      expect(bed.state.failures).toBe(0);

      // Cleanup success no longer ends the process: exiting here is what let the
      // service manager's restart policy retry every few seconds. The daemon
      // stays alive and probes register instead.
      await waitUntil(() => !bed.isSettled() && bed.state.cleanupCalls >= 1, "keep-alive after retirement", 300);
      expect(bed.isSettled()).toBe(false);
      expect(bed.error()).toBeUndefined();
    } finally {
      await bed.close();
    }
  }, 10_000);

  it("stops within 1s during an online plugin RPC and can start again", async () => {
    const bed = await faultTestBed("plugins", 30_000);
    let restarted: Promise<void> | undefined;
    try {
      bed.state.armed = true;
      await waitUntil(() => bed.state.failures > 0, "online plugin RPC");
      expect(bed.isSettled()).toBe(false);
      bed.daemon.stop();
      await waitUntil(bed.isSettled, "online RPC cancellation", 1_000);
      expect(bed.error()).toBeUndefined();
      expect(bed.state.cleanupCalls).toBe(0);

      bed.state.armed = false;
      restarted = bed.daemon.start();
      await waitUntil(() => bed.state.claims >= 3, "offers after an online RPC cancellation");
    } finally {
      bed.daemon.stop();
      try {
        if (restarted) await restarted;
      } finally {
        await bed.close();
      }
    }
  }, 10_000);

  it("stops and cleans up after workspace ownership is lost during an online plugin RPC", async () => {
    const bed = await faultTestBed("plugins", 30_000);
    try {
      bed.state.armed = true;
      await waitUntil(() => bed.state.failures > 0, "online plugin RPC");
      expect(bed.isSettled()).toBe(false);
      bed.daemon.stopForWorkspaceOwnershipLoss(new Error("workspace ownership lost"));
      await waitUntil(bed.isSettled, "online RPC ownership loss", 1_000);
      expect(bed.error()).toBeUndefined();
      expect(bed.daemon.daemonProtocolClient().diagnostics().sockets).toBe(0);
      const heartbeatsAfterStop = bed.state.heartbeats;
      pollingClock?.advance(15_000);
      await Bun.sleep(30);
      expect(bed.state.heartbeats).toBe(heartbeatsAfterStop);
    } finally {
      await bed.close();
    }
  }, 10_000);

  it("still rejects startup when registration fails", async () => {
    const bed = await faultTestBed("register");
    try {
      bed.state.armed = true;
      await waitUntil(bed.isSettled, "registration failure");
      expect(bed.state.failures).toBeGreaterThan(0);
      expect(bed.error()).toBeInstanceOf(Error);
      expect(bed.state.registrations).toBe(0);
    } finally {
      await bed.close();
    }
  }, 10_000);

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
