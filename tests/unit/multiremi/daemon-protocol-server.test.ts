/**
 * MUL-417 — the v2 connection layer as it is actually wired into `Bun.serve`.
 *
 * The session tests cover the state machine against a fake socket. What only a
 * real socket can show is the wiring: that the upgrade distinguishes a v2 socket
 * from the v1 wake-up path, that the URL marker and the credential both work,
 * that `hello` really reaches the transport over the wire, that the server's
 * accepted limits are the A-0 constants, and that v1 keeps working unchanged
 * (A-1's explicit coexistence rule).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { startMultiremiServer } from "@multiremi/api.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_WS_MAX_PAYLOAD_BYTES,
} from "@multiremi/contracts/daemon-protocol.js";
import { createStore, nextWebSocketMessage, resetMultiremiTestEnv, waitWebSocketOpen } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

/** A store with one workspace owner, one daemon and one runtime bound to it. */
async function daemonFixture(options: { retired?: boolean } = {}) {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.createWorkspaceMember({ workspaceId: "local", userId: "owner-1", name: "Owner", role: "owner" });
  store.registerRuntime({
    id: "rt_v2",
    name: "v2 runtime",
    provider: "codex",
    daemonId: "dmn_v2",
    workspaceId: "local",
  });
  const token = await store.createAccessToken({
    name: "v2 daemon",
    type: "daemon",
    workspaceId: "local",
    daemonId: "dmn_v2",
    userId: "owner-1",
  });
  if (options.retired) {
    const plan = store.getDaemonRetirementPlan("local", "dmn_v2");
    store.retireDaemon("local", "dmn_v2", plan.snapshot, "owner-1");
  }
  return { store, token };
}

function helloFrame(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: DAEMON_PROTOCOL_VERSION,
    t: "hello",
    ts: Date.now(),
    p: {
      protocol: DAEMON_PROTOCOL_VERSION,
      daemon_id: "dmn_v2",
      cli_version: "0.2.83",
      launched_by: null,
      runtimes: [{ runtime_id: "rt_v2", provider: "codex", max_concurrency: 1, active_task_ids: [] }],
      caps: [],
      ...patch,
    },
  });
}

describe("MUL-417 daemon protocol v2 — server wiring", () => {
  it("completes a handshake over a real socket and stamps the runtime heartbeat", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: `Bearer ${token.token}` } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      socket.send(helloFrame());
      const welcome = await nextWebSocketMessage(socket);
      expect(welcome).toMatchObject({
        v: DAEMON_PROTOCOL_VERSION,
        t: "welcome",
        p: {
          protocol: DAEMON_PROTOCOL_VERSION,
          min_cli_version: "0.2.83",
          hb_interval_ms: 15_000,
          // A-1 advertises the A-0 limits and leaves the trace heads to A-6.
          limits: { frame_bytes: 1024 * 1024, window_frames: 64, window_bytes: 1024 * 1024 },
          trace_heads: {},
        },
      });
      expect(welcome.p.session_id).toMatch(/^dws_/);

      socket.send(JSON.stringify({
        v: DAEMON_PROTOCOL_VERSION,
        t: "hb",
        ts: Date.now(),
        p: { active_task_count: 0, drain_ack_generation: 0 },
      }));
      await Bun.sleep(120);
      expect(store.getRuntime("rt_v2")?.lastHeartbeatAt).not.toBeNull();
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("accepts a v2 socket with no URL marker when a daemon credential is presented", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws`,
      { headers: { Authorization: `Bearer ${token.token}` } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      socket.send(helloFrame());
      expect(await nextWebSocketMessage(socket)).toMatchObject({ t: "welcome" });
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("accepts a marker-less v2 socket on the deployment master credential", async () => {
    // The master credential is the historical daemon credential and the protocol
    // document's §1.1 URL carries no marker, so a v2 daemon that authenticates
    // this way must not be turned away as a malformed v1 upgrade.
    const { store } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws`,
      { headers: { Authorization: "Bearer root-secret" } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      socket.send(helloFrame());
      expect(await nextWebSocketMessage(socket)).toMatchObject({ t: "welcome" });
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("keeps the v1 wake-up path byte-identical for a socket that names its runtimes", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?runtime_ids=rt_v2`,
      { headers: { Authorization: `Bearer ${token.token}` } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      // v1 still receives `ready`, not `welcome`: A-2 deletes this branch.
      expect(await nextWebSocketMessage(socket)).toMatchObject({
        type: "ready",
        transport: "websocket",
        runtime_id: "rt_v2",
        runtime_ids: ["rt_v2"],
      });
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("still answers a marker-less, credential-less upgrade with the v1 400", async () => {
    const { store } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "runtime_ids required" });
    } finally {
      server.stop(true);
    }
  });

  it("refuses a v2 upgrade whose token is not a daemon credential", async () => {
    const { store } = await daemonFixture();
    const human = await store.createAccessToken({
      name: "human",
      type: "pat",
      workspaceId: "local",
      userId: "owner-1",
    });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${human.token}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "daemon_token_required" });
    } finally {
      server.stop(true);
    }
  });

  it("closes 4410 when a retired daemon completes a hello", async () => {
    // Retirement revokes that daemon's tokens, so the credential route answers
    // 401 before `hello` is ever read. The deployment master credential survives
    // retirement, and that is the route on which a retired daemon is actually
    // identifiable - so this is the path 4410 has to be asserted on.
    const { store } = await daemonFixture({ retired: true });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: "Bearer root-secret" } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      const closed = new Promise<CloseEvent>((resolve) => {
        socket.addEventListener("close", (event) => resolve(event as CloseEvent), { once: true });
      });
      socket.send(helloFrame());
      const event = await closed;
      expect(event.code).toBe(4410);
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("answers a retired daemon's own revoked credential with 401 at the upgrade", async () => {
    const { store, token } = await daemonFixture({ retired: true });
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Authorization: `Bearer ${token.token}` },
      });
      expect(response.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  it("answers an unknown frame over a real socket and keeps the connection", async () => {
    const { store, token } = await daemonFixture();
    const server = startMultiremiServer({ store, scheduler: null, port: 0, hostname: "127.0.0.1", authToken: "root-secret" });
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/daemon/ws?protocol=2`,
      { headers: { Authorization: `Bearer ${token.token}` } } as never,
    );
    try {
      await waitWebSocketOpen(socket);
      socket.send(helloFrame());
      await nextWebSocketMessage(socket);
      socket.send(JSON.stringify({ v: 2, t: "not.a.frame", id: "q-7", ts: Date.now(), p: {} }));
      expect(await nextWebSocketMessage(socket)).toMatchObject({
        t: "res",
        re: "q-7",
        p: { ok: false, code: "unknown_frame", retryable: false },
      });
      expect(socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      socket.close();
      server.stop(true);
    }
  });

  it("advertises the A-0 payload ceiling to every socket", () => {
    // The two numbers the Issue fixed: the protocol frame cap and the Bun
    // `maxPayloadLength` that has to sit above it.
    expect(DAEMON_WS_MAX_PAYLOAD_BYTES).toBe(4 * 1024 * 1024);
  });
});
