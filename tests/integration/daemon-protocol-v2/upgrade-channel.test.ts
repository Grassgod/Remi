import { disabledSshMeshRuntime } from "../../helpers/ssh-mesh-isolation.js";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version as fixtureVersion } from "../../../package.json";
import { createMultiremiApp, startMultiremiServer } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { MultiremiDaemonClient } from "@multiremi/client.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import type { MultiremiDaemonHeartbeatAck } from "@multiremi/contracts/types.js";
import { multiremiVersion } from "@multiremi/version.js";
import { DaemonProtocolHarness, waitFor } from "./harness.js";
import { CommandRegistry } from "../../../apps/remi/cli/core/index.js";
import { operationsCommandSpecs } from "../../../apps/remi/cli/commands/operations.js";
import { TestMultiremiDaemon } from "../../fixtures/daemon-protocol.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function bed(cliVersion = "0.2.82") {
  const db = openSqliteDatabase(":memory:");
  const store = new MultiremiStore(db);
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: "rt_upgrade", name: "Upgrade test", provider: "claude", daemonId: "dmn_upgrade", metadata: { cli_version: cliVersion } });
  const app = createMultiremiApp({ store });
  cleanups.push(() => db.close());
  const rows = () => db.query("SELECT id, status, scope, target_version, error FROM multiremi_runtime_update_requests WHERE runtime_id = ?").all(runtime.id) as any[];
  const heartbeat = async () => {
    const response = await app.request("/api/daemon/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime_id: runtime.id }) });
    expect(response.status).toBe(200);
    return await response.json() as any;
  };
  return { db, store, runtime, rows, heartbeat, app };
}

describe("HTTP daemon protocol upgrade channel (real SQLite)", () => {
  it.each(["0.2.82", "0.2.84", "0.2.85", "0.2.86", "unreadable", ""])("automatically requests the server CLI version for %s", async version => {
    const b = bed(version);
    const ack = await b.heartbeat();
    expect(ack.pending_update).toMatchObject({ id: expect.any(String), scope: "cli", target_version: multiremiVersion });
    expect(b.rows()).toHaveLength(1);
    expect(b.rows()[0]).toMatchObject({ scope: "cli", target_version: multiremiVersion });
  });

  it.each([DAEMON_MIN_CLI_VERSION, "v1.0.0"])("does not queue an upgrade at or above the minimum (%s)", async version => {
    const b = bed(version);
    expect((await b.heartbeat()).pending_update).toBeUndefined();
    expect(b.rows()).toEqual([]);
  });

  it("concurrent heartbeats keep one pending while the existing physical-daemon idle gate is closed", async () => {
    const b = bed();
    const agent = b.store.createAgent({ name: "Busy", provider: "claude", runtimeId: b.runtime.id });
    const task = b.store.createTask({ agentId: agent.id, runtimeId: b.runtime.id, prompt: "Keep the existing update gate closed" });
    expect(b.store.claimTask(b.runtime.id)?.id).toBe(task.id);
    b.store.startTask(task.id);
    const replies = await Promise.all([b.heartbeat(), b.heartbeat()]);
    expect(replies.every(ack => !ack.pending_update)).toBeTrue();
    expect(b.rows()).toHaveLength(1);
    expect(b.rows()[0].status).toBe("pending");
    for (let attempt = 0; attempt < 3; attempt++) await b.heartbeat();
    expect(b.rows()).toHaveLength(1);
    b.store.completeTask(task.id, { output: "done" });
    expect((await b.heartbeat()).pending_update.id).toBe(b.rows()[0].id);
  });

  it("rebuilds a failed CLI upgrade at the next heartbeat without deleting its failure history", async () => {
    const b = bed();
    const first = (await b.heartbeat()).pending_update;
    b.store.reportRuntimeUpdateResult(b.runtime.id, first.id, { status: "failed", error: "fixture download failed" });
    expect(b.store.getRuntime(b.runtime.id)?.protocol).toMatchObject({ version: 1, state: "upgrade_failed", last_error: "fixture download failed" });
    const second = (await b.heartbeat()).pending_update;
    expect(second.id).not.toBe(first.id);
    expect(b.rows()).toHaveLength(2);
    expect(b.store.getRuntimeUpdateRequest(b.runtime.id, first.id)?.status).toBe("failed");
    expect(b.store.getRuntime(b.runtime.id)?.protocol).toMatchObject({ state: "upgrade_pending", last_error: null });
    await b.heartbeat();
    expect(b.rows()).toHaveLength(2);
  });

  it("does not supersede an active ACP update or swallow unexpected storage failures", async () => {
    const b = bed();
    const acp = b.store.createRuntimeUpdateRequest(b.runtime.id, { scope: "acp" });
    expect((await b.heartbeat()).pending_update).toMatchObject({ id: acp.id, scope: "acp" });
    expect(b.rows()).toHaveLength(1);
    const create = spyOn(b.store, "createRuntimeUpdateRequest").mockImplementation(() => { throw new Error("fixture database unavailable"); });
    try {
      const response = await b.app.request("/api/daemon/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime_id: b.runtime.id }) });
      expect(response.status).toBe(500);
    } finally { create.mockRestore(); }
  });

  it("a v2 daemon rejected with 4426 receives the automatic pending_update on its 60s probe", async () => {
    const targets: string[] = [];
    const heartbeat = spyOn(MultiremiDaemonClient.prototype, "heartbeatRuntime");
    cleanups.push(() => heartbeat.mockRestore());
    const h = await DaemonProtocolHarness.create({ cliVersion: "0.2.82", updateRunner: async version => { targets.push(version); throw new Error("fixture upgrade failure"); } });
    cleanups.push(() => h.dispose());
    await h.startDaemon("upgrade_wait");
    expect(h.sockets[0]!.frames.some(frame => frame.t === "reject")).toBeTrue();
    expect(h.store.listRuntimes()).toHaveLength(1);
    h.clock.advance(59_999);
    expect(heartbeat).not.toHaveBeenCalled();
    h.clock.advance(1);
    await waitFor(() => targets.length === 1, "HTTP probe update handler");
    await h.client.drain();
    const ack = await heartbeat.mock.results[0]!.value as MultiremiDaemonHeartbeatAck;
    expect(ack.pending_update).toMatchObject({ target_version: multiremiVersion, scope: "cli" });
    expect(targets).toEqual([multiremiVersion]);
    expect(h.store.getRuntimeUpdateRequest(ack.runtime_id, ack.pending_update!.id)?.status).toBe("failed");
    expect((await h.health()).protocol).toMatchObject({ state: "rejected", next_probe_at: new Date(h.clock.now() + 60_000).toISOString() });
  });

  it("the UI-role server reads negotiated and failed protocol states from the runtime-role server's database", async () => {
    const h = await DaemonProtocolHarness.create({ apiRole: "runtime", database: "sqlite" });
    cleanups.push(() => h.dispose());
    // The UI owns an independent Store/SQLite connection, with no shared session registry.
    const uiDb = openSqliteDatabase(`${h.root}/server.db`);
    const uiStore = new MultiremiStore(uiDb);
    const previousRole = process.env.MULTIREMI_API_ROLE;
    let ui: ReturnType<typeof startMultiremiServer>;
    try {
      process.env.MULTIREMI_API_ROLE = "ui";
      ui = startMultiremiServer({ store: uiStore, scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port: 0 });
    } finally {
      if (previousRole === undefined) delete process.env.MULTIREMI_API_ROLE; else process.env.MULTIREMI_API_ROLE = previousRole;
    }
    cleanups.push(async () => { await h.stopDaemon(); await h.client.drain(); await waitFor(() => ui.pendingRequests === 0, "UI requests drain"); void ui.stop(true); uiDb.close(); });
    await h.startDaemon();
    await h.settleHeartbeat();
    const id = h.store.listRuntimes()[0]!.id;
    const list = async () => await (await fetch(`http://127.0.0.1:${ui.port}/api/runtimes`)).json() as any[];
    expect((await list()).find(runtime => runtime.id === id).protocol).toMatchObject({ version: 2, state: "ok", min_version: DAEMON_MIN_CLI_VERSION, last_error: null });
    const denied = await fetch(`http://127.0.0.1:${ui.port}/api/daemon/heartbeat`, { method: "POST" });
    expect(denied.status).toBe(421);
    await h.stopDaemon();
    h.store.heartbeatRuntime(id, { claimPending: false });
    h.store.recordDaemonProtocol(id, "dmn_fixture", 1, "0.2.82");
    const update = h.store.createRuntimeUpdateRequest(id, { targetVersion: multiremiVersion });
    h.store.reportRuntimeUpdateResult(id, update.id, { status: "failed", error: "fixture install denied" });
    expect((await list()).find(runtime => runtime.id === id).protocol).toMatchObject({ version: 1, state: "upgrade_failed", last_error: "fixture install denied" });
  });

  it("real CLI commands show database upgrade failures and count physical daemons without changing JSON fields", async () => {
    const b = bed();
    const first = (await b.heartbeat()).pending_update;
    b.store.reportRuntimeUpdateResult(b.runtime.id, first.id, { status: "failed", error: "fixture install denied" });
    b.store.registerRuntime({ id: "rt_pending", name: "Pending upgrade", provider: "codex", daemonId: "dmn_pending", metadata: { cli_version: "0.2.82" } });
    b.store.createRuntimeUpdateRequest("rt_pending", { scope: "cli", targetVersion: multiremiVersion });
    const server = startMultiremiServer({ store: b.store, authToken: "fixture-cli-master", scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port: 0, apiRole: "ui" });
    cleanups.push(async () => { await waitFor(() => server.pendingRequests === 0, "CLI requests drain"); await server.stop(true); });
    const variables = ["MULTIREMI_SERVER_URL", "MULTIREMI_WORKSPACE_ID", "MULTIREMI_TOKEN"] as const;
    const previous = variables.map(key => process.env[key]);
    const log = console.log;
    try {
      process.env.MULTIREMI_SERVER_URL = `http://127.0.0.1:${server.port}`;
      process.env.MULTIREMI_WORKSPACE_ID = "local";
      process.env.MULTIREMI_TOKEN = "fixture-cli-master";
      const registry = new CommandRegistry();
      for (const spec of operationsCommandSpecs()) registry.register(spec);
      const output: string[] = [];
      console.log = (...values) => { output.push(values.map(String).join(" ")); };
      await registry.execute(["runtime", "list"]);
      expect(output.join("\n")).toContain("协议 v1 · 升级失败：fixture install denied");
      output.length = 0;
      await registry.execute(["platform", "status"]);
      expect(output.join("\n")).toContain("待升级 1 台 / 失败 1 台");
      output.length = 0;
      await registry.execute(["runtime", "list", "--json"]);
      const runtimes = JSON.parse(output.join("\n"));
      expect(runtimes.find((runtime: any) => runtime.id === b.runtime.id)).toMatchObject({ name: "Upgrade test", status: "online", protocol: { version: 1, state: "upgrade_failed", min_version: DAEMON_MIN_CLI_VERSION, last_error: "fixture install denied" } });
      output.length = 0;
      await registry.execute(["platform", "status", "--json"]);
      expect(JSON.parse(output.join("\n"))).toMatchObject({ canManage: true, driver: "systemd_release", updaterStatus: "offline", maintenance: { mode: "normal", generation: 0 }, daemonProtocol: { pending: 1, failed: 1 } });
    } finally {
      console.log = log;
      variables.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; });
    }
  });

  it("the version fixture advertises one release during registration, pre-hello input and hello", async () => {
    const root = mkdtempSync(join(tmpdir(), "mul418-version-fixture-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const b = bed();
    const token = await b.store.createAccessToken({ name: "Version fixture", type: "daemon", workspaceId: "local", daemonId: "dmn_upgrade", userId: "local" });
    const server = startMultiremiServer({ store: b.store, authToken: "fixture-version-master", scheduler: null, backgroundJobs: false, hostname: "127.0.0.1", port: 0 });
    cleanups.push(async () => { await waitFor(() => server.pendingRequests === 0, "version fixture requests drain"); void server.stop(true); });
    let registeredVersion: unknown;
    const record = b.store.recordDaemonProtocol.bind(b.store);
    const hello = spyOn(b.store, "recordDaemonProtocol").mockImplementation((...args) => {
      registeredVersion = b.store.getRuntimeLite(args[0])?.metadata.cli_version;
      record(...args);
    });
    cleanups.push(() => hello.mockRestore());
    let upgrades = 0;
    const daemon = new TestMultiremiDaemon({
      sshMeshManager: disabledSshMeshRuntime(),
      serverUrl: `http://127.0.0.1:${server.port}`, token: token.token, daemonId: "dmn_upgrade", runtimeId: b.runtime.id,
      runtimeName: "Version fixture", provider: "claude", workspaceId: "local", daemonPort: 0,
      workspacesRoot: join(root, "workspaces"), repoCacheRoot: join(root, "cache"), pluginCacheRoot: join(root, "plugins"),
      outboxPath: ":memory:", gcEnabled: false, pollIntervalMs: 25,
      updateRunner: async () => { upgrades++; throw new Error("fixture must not run an implicit upgrade"); },
      providerFactory: () => ({ async *sendStream() {}, getLastResponse: () => ({ text: "", sessionId: "fixture" }) }),
    });
    cleanups.push(() => daemon.stopAndDrainTestWork());
    void daemon.start();
    await waitFor(() => daemon.daemonProtocolClient().connectionState() === "connected", "fixture hello after startup input");
    expect(registeredVersion).toBe(fixtureVersion);
    expect(b.store.getRuntime(b.runtime.id)?.protocol).toMatchObject({ version: 2, state: "ok" });
    expect(b.store.getRuntimeLite(b.runtime.id)?.metadata.cli_version).toBe(fixtureVersion);
    expect(upgrades).toBe(0);
    expect(b.rows()).toEqual([]);
  });
});
