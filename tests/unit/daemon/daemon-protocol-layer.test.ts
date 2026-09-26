/**
 * MUL-417 — the connection layer's rules against the real store.
 *
 * `daemon-protocol-session.test.ts` proves the state machine with an injected
 * authorization answer. This file proves the answer itself, because the three
 * terminal close codes are only meaningful if the rules behind them are the same
 * rules the v1 HTTP path applies: daemon identity, then workspace, then the
 * owner's membership, plus retirement.
 *
 * The heartbeat half is here too: the acceptance item is that `hb` updates
 * `last_heartbeat_at` under `RUNTIME_HEARTBEAT_STALE_MS`'s rule and records the
 * drain acknowledgement, and both of those are store writes that only a real
 * store can show.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { MultiremiStore } from "@multiremi/store/store.js";
import { DAEMON_PROTOCOL_CLOSE_CODES } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonProtocolLayer } from "../../../packages/server/src/api/daemon-protocol/index.js";
import { DaemonProtocolSession } from "../../../packages/server/src/api/daemon-protocol/session.js";
import { DaemonSessionRegistry } from "../../../packages/server/src/api/daemon-protocol/session-registry.js";
import { ManualDaemonProtocolClock } from "../../../packages/server/src/api/daemon-protocol/clock.js";
import type { DaemonProtocolSocket } from "../../../packages/server/src/api/daemon-protocol/session.js";

class RecordingSocket implements DaemonProtocolSocket {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly closed: Array<{ code: number; reason: string }> = [];

  send(text: string): number {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
    return Buffer.byteLength(text, "utf8");
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code: code ?? 1000, reason: reason ?? "" });
  }

  lastOfType(type: string): Record<string, unknown> | null {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      if (this.sent[index]!.t === type) return this.sent[index]!;
    }
    return null;
  }
}

const databases: Database[] = [];

/** The raw handle behind a store, for the one case that simulates an out-of-band write. */
function databaseFor(store: MultiremiStore): Database {
  return (store as unknown as { db: Database }).db;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const database = new Database(":memory:");
  databases.push(database);
  const store = new MultiremiStore(database);
  store.ensureLocalWorkspace();
  store.createWorkspaceMember({ workspaceId: "local", userId: "owner-1", name: "Owner", role: "owner" });
  return { store };
}

/** Drive one `hello` through a real layer and report what the session did. */
async function runHello(
  layer: DaemonProtocolLayer,
  hello: { daemonId: string; runtimeIds: string[]; accessToken: unknown | null; masterToken?: boolean },
): Promise<{ socket: RecordingSocket; session: DaemonProtocolSession }> {
  const socket = new RecordingSocket();
  const session = new DaemonProtocolSession({
    sessionId: "dws_layer",
    socket,
    registry: layer.registry,
    serverVersion: "0.2.83",
    clock: new ManualDaemonProtocolClock(),
    ownerAccessToken: hello.accessToken as never,
    authorizeRuntime: (daemonId, runtimeId) =>
      layer.authorizeRuntimeForTest({ accessToken: hello.accessToken as never, masterToken: hello.masterToken ?? false }, daemonId, runtimeId),
  });
  await session.handleMessage(JSON.stringify({
    v: 2,
    t: "hello",
    ts: 1,
    p: {
      protocol: 2,
      daemon_id: hello.daemonId,
      cli_version: "0.2.83",
      launched_by: null,
      runtimes: hello.runtimeIds.map((runtimeId) => ({
        runtime_id: runtimeId,
        provider: "codex",
        max_concurrency: 1,
        active_task_ids: [],
      })),
      caps: [],
    },
  }));
  return { socket, session };
}

describe("MUL-417 daemon protocol layer — per-runtime authorization", () => {
  it("accepts a daemon token serving its own runtime", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_own", name: "own", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const token = await store.createAccessToken({
      name: "daemon a", type: "daemon", workspaceId: "local", daemonId: "dmn_a", userId: "owner-1",
    });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const { socket, session } = await runHello(layer, { daemonId: "dmn_a", runtimeIds: ["rt_own"], accessToken: token });
    expect(socket.lastOfType("welcome")).not.toBeNull();
    expect(session.isClosed).toBe(false);
    expect(layer.registry.get("dmn_a")).toBe(session);
  });

  it("closes 4403 when the token belongs to a different daemon", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_own", name: "own", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const token = await store.createAccessToken({
      name: "daemon b", type: "daemon", workspaceId: "local", daemonId: "dmn_b", userId: "owner-1",
    });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const { socket } = await runHello(layer, { daemonId: "dmn_a", runtimeIds: ["rt_own"], accessToken: token });
    expect(socket.lastOfType("welcome")).toBeNull();
    expect(socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.forbidden);
    expect(layer.registry.size).toBe(0);
  });

  it("closes 4403 when the daemon advertises a runtime nobody registered", async () => {
    const { store } = fixture();
    const token = await store.createAccessToken({
      name: "daemon a", type: "daemon", workspaceId: "local", daemonId: "dmn_a", userId: "owner-1",
    });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const { socket } = await runHello(layer, { daemonId: "dmn_a", runtimeIds: ["rt_missing"], accessToken: token });
    expect(socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.forbidden);
  });

  it("closes 4401 when the daemon owner is not a workspace member", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_own", name: "own", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    // A daemon credential whose owner has no membership: the token itself is
    // valid and bound to the right daemon, so this is purely the membership
    // rule, which is the one that used to answer HTTP 403.
    const token = await store.createAccessToken({
      name: "daemon a", type: "daemon", workspaceId: "local", daemonId: "dmn_a", userId: "ghost-1",
    });
    expect(store.getUserRoleInWorkspace("ghost-1", "local")).toBeNull();
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const { socket } = await runHello(layer, { daemonId: "dmn_a", runtimeIds: ["rt_own"], accessToken: token });
    expect(socket.lastOfType("welcome")).toBeNull();
    expect(socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked);
  });

  it("closes 4410 for a retired daemon even on the master credential", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_own", name: "own", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const plan = store.getDaemonRetirementPlan("local", "dmn_a");
    store.retireDaemon("local", "dmn_a", plan.snapshot, "owner-1");
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const { socket } = await runHello(layer, { daemonId: "dmn_a", runtimeIds: ["rt_own"], accessToken: null, masterToken: true });
    expect(socket.closed[0]!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired);
  });

  it("closes 4401 mid-connection when the owner loses membership at the next heartbeat", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_own", name: "own", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const token = await store.createAccessToken({
      name: "daemon a", type: "daemon", workspaceId: "local", daemonId: "dmn_a", userId: "owner-1",
    });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const socket = new RecordingSocket();
    const session = new DaemonProtocolSession({
      sessionId: "dws_hb",
      socket,
      registry: layer.registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      ownerAccessToken: token,
      authorizeRuntime: (daemonId, runtimeId) =>
        layer.authorizeRuntimeForTest({ accessToken: token, masterToken: false }, daemonId, runtimeId),
      onHeartbeat: (heartbeat) => layer.handleHeartbeatForTest(heartbeat),
    });
    await session.handleMessage(JSON.stringify({
      v: 2, t: "hello", ts: 1,
      p: {
        protocol: 2, daemon_id: "dmn_a", cli_version: "0.2.83", launched_by: null,
        runtimes: [{ runtime_id: "rt_own", provider: "codex", max_concurrency: 1, active_task_ids: [] }],
        caps: [],
      },
    }));
    expect(session.isClosed).toBe(false);

    await session.handleMessage(JSON.stringify({ v: 2, t: "hb", ts: 2, p: { active_task_count: 0 } }));
    expect(session.isClosed).toBe(false);

    // The store refuses to archive a member who still owns a live daemon (that
    // invariant is what keeps the two in step), so the removal is simulated the
    // way it actually arrives: out of band, while the socket is already open.
    databaseFor(store).run("UPDATE multiremi_workspace_members SET archived_at = ? WHERE user_id = 'owner-1'", [new Date().toISOString()]);
    expect(store.getUserRoleInWorkspace("owner-1", "local")).toBeNull();

    await session.handleMessage(JSON.stringify({ v: 2, t: "hb", ts: 3, p: { active_task_count: 0 } }));
    expect(session.isClosed).toBe(true);
    expect(socket.closed.at(-1)!.code).toBe(DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked);
  });
});

describe("MUL-417 daemon protocol layer — heartbeat effects", () => {
  it("stamps every advertised runtime and records the drain acknowledgement", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_one", name: "one", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    store.registerRuntime({ id: "rt_two", name: "two", provider: "claude", daemonId: "dmn_a", workspaceId: "local" });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });

    layer.handleHeartbeatForTest({
      daemonId: "dmn_a",
      runtimeIds: ["rt_one", "rt_two"],
      payload: { active_task_count: 3, drain_ack_generation: 4 },
    });

    expect(store.getRuntime("rt_one")?.lastHeartbeatAt).not.toBeNull();
    expect(store.getRuntime("rt_two")?.lastHeartbeatAt).not.toBeNull();
    const drain = store.getPlatformDrainStatus();
    // Both runtimes are now counted as acknowledged for the requested generation,
    // which is what the deploy gate reads.
    expect(drain.pendingRuntimes.map((entry) => entry.id)).not.toContain("rt_one");
    expect(drain.pendingRuntimes.map((entry) => entry.id)).not.toContain("rt_two");
  });

  it("tolerates a heartbeat that carries no drain acknowledgement", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_one", name: "one", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    layer.handleHeartbeatForTest({ daemonId: "dmn_a", runtimeIds: ["rt_one"], payload: { active_task_count: 0 } });
    expect(store.getRuntime("rt_one")?.lastHeartbeatAt).not.toBeNull();
  });

  it("reports a runtime that vanished as runtime_gone instead of throwing", () => {
    const { store } = fixture();
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const reply = layer.handleHeartbeatForTest({
      daemonId: "dmn_a",
      runtimeIds: ["rt_gone"],
      payload: { active_task_count: 0, drain_ack_generation: 1 },
    });
    expect(reply.runtime_acks).toEqual([{
      runtime_id: "rt_gone",
      status: "runtime_gone",
      runtime_gone: true,
    }]);
  });

  it("orders runtime acks the way the hello advertised its runtimes", () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_one", name: "one", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    store.registerRuntime({ id: "rt_three", name: "three", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const reply = layer.handleHeartbeatForTest({
      daemonId: "dmn_a",
      runtimeIds: ["rt_one", "rt_two", "rt_three"],
      payload: { active_task_count: 0 },
    });
    // One ack per advertised runtime, in the advertised order: the daemon pairs
    // them positionally as well as by id.
    expect(reply.runtime_acks.map((ack) => ack.runtime_id)).toEqual(["rt_one", "rt_two", "rt_three"]);
    expect(reply.runtime_acks.map((ack) => ack.status)).toEqual(["ok", "runtime_gone", "ok"]);
  });
});

describe("MUL-417 daemon protocol layer — one gone runtime must not close the socket", () => {
  /**
   * The rule the whole per-runtime ack exists for. One socket serves a daemon's
   * whole process, so deleting one runtime row is a fact about that runtime. A
   * close code here would either strand the healthy runtimes (4410 stops
   * reconnecting; 4001 loops) or, if reported as `authority_revoked`, stop the
   * daemon from ever registering the missing runtime again.
   */
  it("keeps the socket and the sibling runtime working when one runtime row is deleted", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_keep", name: "keep", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    store.registerRuntime({ id: "rt_drop", name: "drop", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const token = await store.createAccessToken({
      name: "daemon a", type: "daemon", workspaceId: "local", daemonId: "dmn_a", userId: "owner-1",
    });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const socket = new RecordingSocket();
    const session = new DaemonProtocolSession({
      sessionId: "dws_two",
      socket,
      registry: layer.registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      ownerAccessToken: token,
      authorizeRuntime: (daemonId, runtimeId) =>
        layer.authorizeRuntimeForTest({ accessToken: token, masterToken: false }, daemonId, runtimeId),
      onHeartbeat: (heartbeat) => layer.handleHeartbeatForTest(heartbeat),
    });
    await session.handleMessage(JSON.stringify({
      v: 2, t: "hello", ts: 1,
      p: {
        protocol: 2, daemon_id: "dmn_a", cli_version: "0.2.83", launched_by: null,
        runtimes: [
          { runtime_id: "rt_keep", provider: "codex", max_concurrency: 1, active_task_ids: [] },
          { runtime_id: "rt_drop", provider: "codex", max_concurrency: 1, active_task_ids: [] },
        ],
        caps: [],
      },
    }));
    expect(socket.lastOfType("welcome")).not.toBeNull();

    // The runtime row disappears between two heartbeats, exactly as an operator
    // deleting or a retirement cleaning up would leave it.
    databaseFor(store).run("DELETE FROM multiremi_runtimes WHERE id = ?", ["rt_drop"]);
    expect(store.getRuntimeLite("rt_drop")).toBeNull();

    await session.handleMessage(JSON.stringify({
      v: 2, t: "hb", id: "hb-1", ts: 2,
      p: { active_task_count: 0, drain_ack_generation: 2 },
    }));

    // 1. the deleted runtime is reported as gone, in the reply, not as a close.
    const reply = socket.lastOfType("res")!;
    expect(reply.re).toBe("hb-1");
    const acks = (reply.p as { runtime_acks: Array<Record<string, unknown>> }).runtime_acks;
    expect(acks.find((ack) => ack.runtime_id === "rt_drop")).toMatchObject({
      status: "runtime_gone",
      runtime_gone: true,
    });
    // 2. the healthy runtime is still acknowledged and still stamped.
    expect(acks.find((ack) => ack.runtime_id === "rt_keep")).toMatchObject({ status: "ok" });
    expect(store.getRuntime("rt_keep")?.lastHeartbeatAt).not.toBeNull();
    // 3. the socket is open, still registered, and still carries traffic with an ack.
    expect(session.isClosed).toBe(false);
    expect(socket.closed).toEqual([]);
    expect(layer.registry.get("dmn_a")).toBe(session);
    const seq = session.sendEvent({ t: "task.offer", rt: "rt_keep", p: { task_id: "t1" } });
    expect(seq).toBe(1);
    await session.handleMessage(JSON.stringify({ v: 2, t: "ack", ts: 3, p: { ack: 1 } }));
    expect(session.unacknowledgedFrameCount).toBe(0);
    expect(session.isClosed).toBe(false);
  });

  it("answers a heartbeat even when no id was supplied", async () => {
    const { store } = fixture();
    store.registerRuntime({ id: "rt_one", name: "one", provider: "codex", daemonId: "dmn_a", workspaceId: "local" });
    const layer = new DaemonProtocolLayer({ store, serverVersion: "0.2.83" });
    const socket = new RecordingSocket();
    const session = new DaemonProtocolSession({
      sessionId: "dws_noid",
      socket,
      registry: layer.registry,
      serverVersion: "0.2.83",
      clock: new ManualDaemonProtocolClock(),
      authorizeRuntime: (daemonId, runtimeId) =>
        layer.authorizeRuntimeForTest({ accessToken: null, masterToken: true }, daemonId, runtimeId),
      onHeartbeat: (heartbeat) => layer.handleHeartbeatForTest(heartbeat),
    });
    await session.handleMessage(JSON.stringify({
      v: 2, t: "hello", ts: 1,
      p: {
        protocol: 2, daemon_id: "dmn_a", cli_version: "0.2.83", launched_by: null,
        runtimes: [{ runtime_id: "rt_one", provider: "codex", max_concurrency: 1, active_task_ids: [] }],
        caps: [],
      },
    }));
    await session.handleMessage(JSON.stringify({ v: 2, t: "hb", ts: 2, p: { active_task_count: 0 } }));
    const reply = socket.lastOfType("res")!;
    expect(reply.re).toBeUndefined();
    expect(reply.p).toMatchObject({ runtime_acks: [{ runtime_id: "rt_one", status: "ok" }] });
  });
});
