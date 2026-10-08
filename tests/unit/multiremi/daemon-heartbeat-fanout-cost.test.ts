import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { SqlDatabase } from "@multiremi/store/db/postgres.js";
import { DAEMON_MIN_CLI_VERSION } from "@multiremi/contracts/daemon-protocol.js";
import { FEISHU_CONCIERGE_ATTACHMENT_PROTOCOL_VERSION } from "@multiremi/contracts/types.js";
import type { DaemonProtocolLayer } from "@multiremi/api/daemon-protocol/index.js";
import { startMultiremiServer } from "../../fixtures/daemon-protocol.js";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { resetMultiremiTestEnv } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
const previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  setSystemTime();
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
  resetMultiremiTestEnv();
});

// Count executions, including WITH queries, until queued downlinks/offers finish.
// Counting only inside handleHeartbeat hides the work it schedules afterwards.
async function countSql(database: SqlDatabase, layer: DaemonProtocolLayer, action: () => unknown) {
  const statements: string[] = [];
  const query = database.query.bind(database);
  const run = database.run.bind(database);
  const exec = database.exec.bind(database);
  const querySpy = spyOn(database, "query").mockImplementation(((sql: string) => {
    const statement = query(sql);
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (["get", "all", "run", "values"].includes(String(key))) return (...args: unknown[]) => {
          statements.push(sql);
          return value.apply(target, args);
        };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }) as typeof database.query);
  const runSpy = spyOn(database, "run").mockImplementation((...args: Parameters<SqlDatabase["run"]>) => {
    statements.push(args[0]);
    return run(...args);
  });
  const execSpy = spyOn(database, "exec").mockImplementation(sql => { statements.push(sql); exec(sql); });
  try {
    await action();
    await layer.drain();
    return statements;
  } finally { querySpy.mockRestore(); runSpy.mockRestore(); execSpy.mockRestore(); }
}

function historicalAggregates(statements: string[]) {
  return statements.filter(sql => /WITH selected AS|SELECT runtime_id, status, usage FROM multiremi_(?:tasks|turn_execution_records)/.test(sql));
}

async function pendingOnDisconnectedRuntime(f: Awaited<ReturnType<typeof fleet>>) {
  const runtime = f.store.registerRuntime({ id: "rt_cost_disconnected", name: "Disconnected", provider: "claude", workspaceId: "local" });
  const agent = f.store.createAgent({ name: "Pending elsewhere", provider: "claude", runtimeId: runtime.id });
  const task = f.store.createTask({ agentId: agent.id, prompt: "pending on another host" });
  await f.layer.drain();
  expect(f.store.getTaskIdentity(task.id)?.status).toBe("queued");
  expect(f.store.hasPendingTaskOffers("local")).toBe(true);
}

async function fleet() {
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 52).toString("base64");
  const database = await openHotspotDatabase();
  cleanups.push(() => database.dispose());
  const store = new MultiremiStore(database.db);
  store.ensureLocalWorkspace();
  const runtimeIds = Array.from({ length: 8 }, (_, index) => `rt_cost_${index}`);
  for (const [index, id] of runtimeIds.entries()) {
    store.registerRuntime({ id, name: id, provider: index % 2 ? "codex" : "claude", workspaceId: "local",
      ownerId: "local", daemonId: `dm_cost_${Math.floor(index / 2)}`, maxConcurrency: 4,
      metadata: { agent_plugin_protocol: 1, codex_profiles: 1, claude_profiles: 1 } });
    store.heartbeatRuntime(id, { supportsFeishuBotConfig: true });
    store.recordSshMeshHeartbeat(id, 1, { status: "disabled" });
  }
  const agent = store.createAgent({ name: "Cost fixture", provider: "claude", runtimeId: runtimeIds[0] });
  const config = store.upsertFeishuBotConfig("local", { agentId: agent.id, runtimeId: runtimeIds[0],
    appId: "cli_fixture_cost", appSecret: "fixture-secret", appSecretOp: "set", domain: "feishu", enabled: true });
  const status = (index: number) => ({ appliedRevision: config.revision,
    state: index === 0 ? "online" as const : "stopped" as const,
    botName: index === 0 ? "Fixture" : null, botOpenId: null, errorCode: null, errorMessage: null });
  runtimeIds.forEach((id, index) => store.reportFeishuBotRuntimeStatus("local", id, status(index)));
  let layer!: DaemonProtocolLayer;
  const server = startMultiremiServer({ store, peerChannel: null, apiRole: "runtime",
    authToken: "fixture-cost", hostname: "127.0.0.1", port: 0,
    onDaemonProtocol: value => { layer = value; } });
  cleanups.push(async () => { layer.closeAll(); await layer.drain(); server.stop(true); });
  const sessions: Array<ReturnType<DaemonProtocolLayer["openSession"]>> = [];
  const frames: Array<Array<Record<string, any>>> = [];
  const capabilities = { agent_plugin_protocol: 1, feishu_concierge_protocol: FEISHU_CONCIERGE_ATTACHMENT_PROTOCOL_VERSION };
  const heartbeat = (index: number, mesh = false, activeTaskCount = 0) => sessions[index]!.handleMessage(JSON.stringify({ v: 2, t: "hb", p: {
    active_task_count: activeTaskCount, drain_ack_generation: 0,
    runtimes: runtimeIds.slice(index * 2, index * 2 + 2).map(runtime_id => ({ runtime_id, capabilities,
      ...(mesh ? { ssh_mesh_protocol: 1, ssh_mesh_status: { status: "disabled" } } : {}) })),
  } }));
  for (let index = 0; index < 4; index++) {
    const received: Array<Record<string, any>> = [];
    frames.push(received);
    const session = layer.openSession({ send(text) { received.push(JSON.parse(text)); return text.length; }, close() {} },
      { accessToken: null, masterToken: true });
    sessions.push(session);
    await session.handleMessage(JSON.stringify({ v: 2, t: "hello", p: { protocol: 2, daemon_id: `dm_cost_${index}`,
      cli_version: DAEMON_MIN_CLI_VERSION, caps: [],
      runtimes: runtimeIds.slice(index * 2, index * 2 + 2).map((runtime_id, position) => ({ runtime_id,
        provider: position ? "codex" : "claude", max_concurrency: 4, active_task_ids: [], capabilities })) } }));
    await layer.drain();
    await heartbeat(index, true);
    await layer.drain();
    await session.handleMessage(JSON.stringify({ v: 2, t: "ack", ack: session.lastSentSeq, p: {} }));
    await layer.drain();
  }
  return { store, layer, sessions, runtimeIds, frames, status, heartbeat, agent, database: database.db };
}

test("eight unchanged concierge reports refresh timestamps without downlinks, offers or usage scans", async () => {
  setSystemTime(new Date("2026-10-08T06:00:00Z"));
  const f = await fleet();
  const before = f.store.listFeishuBotRuntimeStatuses("local").find(status => status.runtimeId === f.runtimeIds[0])!.reportedAt;
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    setSystemTime(new Date("2026-10-08T06:00:01Z"));
    const sql = await countSql(f.database, f.layer, async () => {
      for (const [index, runtimeId] of f.runtimeIds.entries()) {
        const status = f.status(index);
        await f.sessions[Math.floor(index / 2)]!.handleMessage(JSON.stringify({ v: 2, t: "concierge.status_report",
          id: `same_${index}`, rt: runtimeId, p: { runtime_id: runtimeId, applied_revision: status.appliedRevision,
            state: status.state, bot_name: status.botName, bot_open_id: null, error_code: null, error_message: null } }));
        await f.layer.drain();
      }
    });
    expect(sql.length).toBeLessThanOrEqual(64);
    expect(historicalAggregates(sql)).toEqual([]);
    expect(snapshots).not.toHaveBeenCalled();
    expect(claims).not.toHaveBeenCalled();
    expect(f.store.listFeishuBotRuntimeStatuses("local").find(status => status.runtimeId === f.runtimeIds[0])!.reportedAt).not.toBe(before);
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});

test("unchanged SSH status heartbeats stay local; a changed endpoint still reconciles the mesh", async () => {
  const f = await fleet();
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    const sql = await countSql(f.database, f.layer, () => f.heartbeat(0, true));
    expect(sql.length).toBeLessThanOrEqual(100);
    expect(historicalAggregates(sql)).toEqual([]);
    expect(snapshots).not.toHaveBeenCalled();
    expect(claims).not.toHaveBeenCalled();
    await countSql(f.database, f.layer, () => f.store.recordSshMeshHeartbeat(f.runtimeIds[0]!, 1,
      { status: "disabled", hostname: "changed.test", addresses: ["192.0.2.1"] }));
    expect(snapshots).toHaveBeenCalledTimes(8);
    expect(claims).not.toHaveBeenCalled();
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});

test("a directory request reaches its runtime without querying or offering on other runtimes", async () => {
  const f = await fleet();
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    let requestId = "";
    const sql = await countSql(f.database, f.layer, () => {
      requestId = f.store.createRuntimeDirectoryScanRequest(f.runtimeIds[0]!, { root: "/fixture-only", mode: "browse" }).id;
    });
    expect(snapshots.mock.calls.map(args => args[0])).toEqual([f.runtimeIds[0]]);
    expect(claims).not.toHaveBeenCalled();
    expect(historicalAggregates(sql)).toEqual([]);
    expect(f.frames[0]!.some(frame => frame.t === "runtime.directory_scan" && frame.p.id === requestId)).toBe(true);
    expect(f.frames.slice(1).flat().some(frame => frame.t === "runtime.directory_scan" && frame.p.id === requestId)).toBe(false);
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});

test("enqueue pushes immediately and released capacity retries only its daemon before cooldown", async () => {
  // The clock never advances: neither the periodic heartbeat nor retry/sweep deadlines can dispatch.
  setSystemTime(new Date("2026-10-08T06:00:00Z"));
  const f = await fleet();
  const task = f.store.createTask({ agentId: f.agent.id, prompt: "dispatch from enqueue" });
  await f.layer.drain();
  const offers = () => f.frames[0]!.filter(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id);
  expect(offers()).toHaveLength(1);
  const first = offers()[0]!;
  expect(first.rt).toBe(f.runtimeIds[0]);
  expect(first.p.requesting_user_name).toBe(f.store.getUser("local")!.name);
  await f.heartbeat(0, true, 1);
  await f.layer.drain();
  await f.sessions[0]!.handleMessage(JSON.stringify({ v: 2, t: "res", re: String(first.seq), ack: first.seq,
    p: { ok: false, code: "capacity" } }));
  await f.layer.drain();
  expect(f.store.getTaskIdentity(task.id)?.status).toBe("queued");

  const claims = spyOn(f.store, "claimTask");
  try {
    await countSql(f.database, f.layer, () => f.heartbeat(0, true, 1));
    expect(claims).not.toHaveBeenCalled();
    expect(offers()).toHaveLength(1);

    const sql = await countSql(f.database, f.layer, () => f.heartbeat(0, true, 0));
    expect([...new Set(claims.mock.calls.map(args => args[0]))].sort()).toEqual(f.runtimeIds.slice(0, 2));
    expect(offers()).toHaveLength(2);
    expect(offers()[1]!.rt).toBe(f.runtimeIds[0]);
    expect(f.frames.slice(1).flat().some(frame => frame.t === "task.offer" && frame.p.attempt_id === task.id)).toBe(false);
    expect(historicalAggregates(sql)).toEqual([]);
  } finally { claims.mockRestore(); }
});

test("model changes check only their runtime and empty claims do not hydrate historical usage", async () => {
  const f = await fleet();
  await pendingOnDisconnectedRuntime(f);
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    const sql = await countSql(f.database, f.layer, () => f.store.updateRuntimeModels(f.runtimeIds[0]!, []));
    expect(snapshots.mock.calls.map(args => args[0])).toEqual([f.runtimeIds[0]]);
    expect(claims.mock.calls.map(args => args[0])).toEqual([f.runtimeIds[0]]);
    expect(historicalAggregates(sql)).toEqual([]);
    const sweep = await countSql(f.database, f.layer, () => {
      for (const id of f.runtimeIds) expect(f.store.claimTask(id, { supportsBinarySkillFiles: true })).toBeNull();
    });
    expect(historicalAggregates(sweep)).toEqual([]);
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});

test("an empty workspace still refreshes changed runtime downlinks without taking claim locks", async () => {
  const f = await fleet();
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    const sql = await countSql(f.database, f.layer, () => f.store.updateRuntimeModels(f.runtimeIds[0]!, []));
    expect(snapshots.mock.calls.map(args => args[0])).toEqual([f.runtimeIds[0]]);
    expect(claims).not.toHaveBeenCalled();
    expect(historicalAggregates(sql)).toEqual([]);
    expect(f.frames.flat().some(frame => frame.t === "task.offer")).toBe(false);
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});

test("timeline-only activity does not rebuild daemon configuration", async () => {
  const f = await fleet();
  const issue = f.store.createIssue({ title: "Activity fixture", workspaceId: "local" });
  await f.layer.drain();
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    const sql = await countSql(f.database, f.layer, () => f.store.appendIssueActivity(issue.id,
      { actorType: "system", type: "fixture_note", body: "timeline only" }));
    expect(snapshots).not.toHaveBeenCalled();
    expect(claims).not.toHaveBeenCalled();
    expect(historicalAggregates(sql)).toEqual([]);
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});

test("a plugin readiness change wakes its runtime without rebuilding other hosts", async () => {
  const f = await fleet();
  await pendingOnDisconnectedRuntime(f);
  const agent = f.store.createAgent({ name: "Plugin owner", provider: "claude", runtimeId: f.runtimeIds[0] });
  const plugin = f.store.importAgentPlugin({ provider: "claude", manifest: { name: "cost-plugin", version: "1.0.0" } });
  f.store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
  await f.layer.drain();
  const state = f.store.listAgentPluginRuntimeStates({ runtimeId: f.runtimeIds[0] })[0]!;
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    const sql = await countSql(f.database, f.layer, () => f.sessions[0]!.handleMessage(JSON.stringify({ v: 2,
      t: "plugin.state", seq: 1, rt: f.runtimeIds[0], p: { runtime_id: f.runtimeIds[0],
        version_id: state.pluginVersionId, status: "blocked", last_error_code: "fixture_blocked" } })));
    expect(snapshots.mock.calls.map(args => args[0])).toEqual([f.runtimeIds[0]]);
    expect(claims.mock.calls.map(args => args[0])).toEqual([f.runtimeIds[0]]);
    expect(historicalAggregates(sql)).toEqual([]);
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});

test("a changed concierge status wakes only its host and preserves the new state", async () => {
  const f = await fleet();
  const snapshots = spyOn(f.store, "pendingRuntimeRequests");
  const claims = spyOn(f.store, "claimTask");
  try {
    const sql = await countSql(f.database, f.layer, () => f.store.reportFeishuBotRuntimeStatus("local", f.runtimeIds[0]!,
      { ...f.status(0), state: "failed", errorMessage: "fixture connection failure" }));
    expect(snapshots.mock.calls.map(args => args[0])).toEqual([f.runtimeIds[0]]);
    expect(claims).not.toHaveBeenCalled();
    expect(historicalAggregates(sql)).toEqual([]);
    expect(f.store.listFeishuBotRuntimeStatuses("local").find(status => status.runtimeId === f.runtimeIds[0]))
      .toMatchObject({ state: "failed", errorMessage: "fixture connection failure" });
  } finally { snapshots.mockRestore(); claims.mockRestore(); }
});
