import { afterEach, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import type { DaemonHeartbeatPayload } from "@multiremi/contracts/daemon-protocol.js";
import { DaemonProtocolHarness } from "./harness.js";

const fixtures: DaemonProtocolHarness[] = [];
afterEach(async () => { for (const h of fixtures.splice(0)) await h.dispose(); });

async function fixture(): Promise<DaemonProtocolHarness> {
  const h = await DaemonProtocolHarness.create();
  fixtures.push(h);
  await h.startDaemon();
  await h.settleHeartbeat();
  await h.layer.drain();
  return h;
}

function runtimeId(h: DaemonProtocolHarness): string {
  return h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0].runtime_id;
}

async function countSql(database: Database, action: () => Promise<void> | void) {
  const statements: string[] = [];
  const query = database.query.bind(database);
  const run = database.run.bind(database) as (sql: string, ...args: unknown[]) => unknown;
  const querySpy = spyOn(database, "query").mockImplementation(((sql: string) => {
    statements.push(sql);
    return query(sql);
  }) as typeof database.query);
  const runSpy = spyOn(database, "run").mockImplementation(((sql: string, ...args: unknown[]) => {
    statements.push(sql);
    return run(sql, ...args);
  }) as typeof database.run);
  try {
    const result = action();
    if (result instanceof Promise) await result;
  }
  finally { querySpy.mockRestore(); runSpy.mockRestore(); }
  return {
    selects: statements.filter(sql => /^\s*SELECT\b/i.test(sql)).length,
    updates: statements.filter(sql => /^\s*UPDATE\b/i.test(sql)).length,
  };
}

async function nextSocketHeartbeat(h: DaemonProtocolHarness): Promise<void> {
  await new Promise<void>(resolve => {
    let observed = false;
    h.layer.registerSessionHooks({ heartbeat: () => {
      if (!observed) { observed = true; resolve(); }
    } });
    sendHeartbeat(h);
  });
  await h.settleHeartbeat();
}

function sendHeartbeat(h: DaemonProtocolHarness): void {
  const runtime = h.ledger.find(entry => entry.type === "hello")!.frame.p.runtimes[0];
  h.client.send({ t: "hb", p: { active_task_count: 0, drain_ack_generation: 0,
    runtimes: [{ runtime_id: runtime.runtime_id, capabilities: runtime.capabilities }] } });
}

function reportLegacyPluginCapability(h: DaemonProtocolHarness, mode: "missing" | "zero"): () => void {
  const send = h.client.send.bind(h.client);
  h.client.send = frame => {
    if (frame.t !== "hb") return send(frame);
    const payload = frame.p as DaemonHeartbeatPayload;
    return send({ ...frame, p: { ...payload, runtimes: payload.runtimes?.map(runtime => {
      const capabilities = { ...runtime.capabilities };
      if (mode === "missing") delete capabilities.agent_plugin_protocol;
      else capabilities.agent_plugin_protocol = 0;
      return { ...runtime, capabilities };
    }) } } as typeof frame);
  };
  return () => { h.client.send = send; };
}

async function countSocketHeartbeat(h: DaemonProtocolHarness) {
  const captured: { value?: { selects: number; updates: number } } = {};
  const layer = h.layer as unknown as { handleHeartbeat: (heartbeat: unknown) => unknown };
  const handle = layer.handleHeartbeat.bind(layer);
  const handleSpy = spyOn(layer, "handleHeartbeat").mockImplementation(heartbeat => {
    const statements: string[] = [];
    const query = h.db.query.bind(h.db);
    const run = h.db.run.bind(h.db) as (sql: string, ...args: unknown[]) => unknown;
    const querySpy = spyOn(h.db, "query").mockImplementation(((sql: string) => {
      statements.push(sql); return query(sql);
    }) as typeof h.db.query);
    const runSpy = spyOn(h.db, "run").mockImplementation(((sql: string, ...args: unknown[]) => {
      statements.push(sql); return run(sql, ...args);
    }) as typeof h.db.run);
    try { return handle(heartbeat); }
    finally {
      querySpy.mockRestore(); runSpy.mockRestore();
      captured.value = { selects: statements.filter(sql => /^\s*SELECT\b/i.test(sql)).length,
        updates: statements.filter(sql => /^\s*UPDATE\b/i.test(sql)).length };
    }
  });
  try { await new Promise<void>(resolve => {
    let observed = false;
    h.layer.registerSessionHooks({ heartbeat: () => {
      if (!observed) { observed = true; resolve(); }
    } });
    sendHeartbeat(h);
  }); }
  finally { handleSpy.mockRestore(); }
  await h.settleHeartbeat();
  await h.layer.drain();
  if (!captured.value) throw new Error("Heartbeat handler was not called");
  return captured.value;
}

it("Q419-4 A: absent or zero plugin capability keeps Store and real-socket heartbeats at baseline", async () => {
  const h = await fixture();
  const id = runtimeId(h);
  // Registration advertises protocol 1. This one-time downgrade is outside the steady-state count.
  h.store.heartbeatRuntime(id, { claimPending: false, agentPluginProtocol: 0 });
  await h.layer.drain();
  for (const options of [
    { claimPending: false },
    { claimPending: false, agentPluginProtocol: 0 },
  ]) {
    for (let n = 0; n < 3; n++) {
      expect(await countSql(h.db, () => {
        expect(h.store.heartbeatRuntime(id, options).status).toBe("ok");
      })).toEqual({ selects: 3, updates: 1 });
    }
  }
  for (const mode of ["missing", "zero"] as const) {
    const restore = reportLegacyPluginCapability(h, mode);
    try {
      for (let n = 0; n < 3; n++) {
        expect(await countSocketHeartbeat(h)).toEqual({ selects: 6, updates: 2 });
      }
    } finally { restore(); }
  }
});

it("Q419-4 A: a missing capability clears stored protocol 1 once and emits its transition", async () => {
  const h = await fixture();
  const id = runtimeId(h);
  const transitions: Array<{ previous_agent_plugin_protocol: number | null; agent_plugin_protocol: number }> = [];
  h.store.onWorkspaceEvent(event => {
    if (event.type === "agent_plugin:runtime_capability" && event.payload.runtime_id === id) {
      transitions.push(event.payload as (typeof transitions)[number]);
    }
  });
  expect(h.store.getRuntimeLite(id)!.metadata.agent_plugin_protocol).toBe(1);
  const restore = reportLegacyPluginCapability(h, "missing");
  const migration = await countSocketHeartbeat(h);
  expect(migration.selects).toBeGreaterThan(6);
  expect(h.store.getRuntimeLite(id)!.metadata.agent_plugin_protocol).toBe(0);
  expect(transitions).toMatchObject([{ previous_agent_plugin_protocol: 1, agent_plugin_protocol: 0 }]);
  expect(await countSocketHeartbeat(h)).toEqual({ selects: 6, updates: 2 });
  expect(transitions).toHaveLength(1);
  restore();
});

it("Q419-4 B: protocol 1 Store and socket heartbeat SQL does not exceed v1 HTTP", async () => {
  const h = await fixture();
  const id = runtimeId(h);
  const options = { claimPending: false, agentPluginProtocol: 1,
    supportsBatchImport: true, supportsDirectoryScan: true, supportsSkillDirectory: true,
    supportsBotMenu: false, supportsFeishuBotConfig: false,
    supportsDecisionCard: false, supportsIssueDecisionCard: false };
  const v1Store = await countSql(h.db, () => { h.store.heartbeatRuntime(id, options); });
  const v2Store = await countSql(h.db, () => { h.store.heartbeatRuntime(id, options); });
  await h.layer.drain();
  const v2Socket = await countSocketHeartbeat(h);
  await h.stopDaemon();
  await h.layer.drain();
  const httpApp = createMultiremiApp({ store: h.store, authToken: "fixture-master" });
  const v1Http = await countSql(h.db, async () => {
    const response = await httpApp.request("/api/daemon/heartbeat", {
      method: "POST", headers: { Authorization: "Bearer fixture-master", "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: id, agent_plugin_protocol: 1,
        supports_batch_import: true, supports_directory_scan: true, supports_skill_directory: true,
        drain_ack_generation: 0, active_task_count: 0,
        supports_bot_menu: false, feishu_concierge_protocol: 0,
        feishu_decision_card: 0, feishu_issue_decision_card: 0 }),
    });
    expect(response.status).toBe(200);
  });
  console.info(`[Q419-4 SQL B] Store v1=${JSON.stringify(v1Store)} v2=${JSON.stringify(v2Store)} HTTP v1=${JSON.stringify(v1Http)} socket v2=${JSON.stringify(v2Socket)}`);
  expect(v2Store.selects).toBeLessThanOrEqual(v1Store.selects);
  expect(v2Store.updates).toBeLessThanOrEqual(v1Store.updates);
  expect(v2Socket.selects).toBeLessThanOrEqual(v1Http.selects);
  expect(v2Socket.updates).toBeLessThanOrEqual(v1Http.updates);
});

it("Q419-4 B: three real v2 heartbeats block a pending plugin without an attempt", async () => {
  const h = await fixture();
  const id = runtimeId(h);
  // Leave desired state unconsumed so only the heartbeat timeout advances it.
  (h.daemon as unknown as { reconcileRuntimeAgentPlugins: () => Promise<void> }).reconcileRuntimeAgentPlugins = async () => {};
  const agent = h.store.createAgent({ name: "Pending plugin owner", provider: "claude", workspaceId: "local" });
  const plugin = h.store.importAgentPlugin({ provider: "claude",
    manifest: { name: "heartbeat-pending", version: "1.0.0" } });
  h.store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
  await h.layer.drain();
  expect(h.store.listAgentPluginRuntimeStates({ runtimeId: id })[0]).toMatchObject({ status: "pending", lastAttemptAt: null });
  for (let n = 1; n <= 3; n++) {
    await nextSocketHeartbeat(h);
    expect(h.store.listAgentPluginRuntimeStates({ runtimeId: id })[0]).toMatchObject({
      status: n === 3 ? "blocked" : "pending",
      lastAttemptAt: null,
      ...(n === 3 ? { lastErrorCode: "daemon_plugin_reconcile_timeout" } : {}),
    });
  }
});
