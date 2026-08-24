// Platform drain (MUL-74): persistent maintenance state, lease TTL recovery,
// the daemon heartbeat ack directive, the updater drain endpoints, and the
// operator cancel flow. The invariant under test: the switch gate only opens
// when every online runtime acked the current generation AND no task is
// in flight; every failure path releases the drain.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const UPDATER_HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer master-secret",
  "X-Multiremi-Updater-Token": "updater-secret",
};

function updaterApp(store = createLocalStore()) {
  const app = createMultiremiApp({ store, authToken: "master-secret", platformUpdaterToken: "updater-secret" });
  return { app, store };
}

describe("platform maintenance store", () => {
  it("bumps the generation per drain, renews idempotently, and conflicts across operations", () => {
    const store = createStore();
    expect(store.getPlatformMaintenance()).toMatchObject({ mode: "normal", generation: 0 });

    const first = store.beginPlatformDrain({ operationId: "pop_1", reason: "update" });
    expect(first).toMatchObject({ mode: "draining", generation: 1, operationId: "pop_1", reason: "update" });
    // Same operation re-begins → lease renewal, not a new generation.
    expect(store.beginPlatformDrain({ operationId: "pop_1" }).generation).toBe(1);
    expect(() => store.beginPlatformDrain({ operationId: "pop_2" })).toThrow(/already draining/);

    expect(store.releasePlatformDrain("pop_other").mode).toBe("draining");
    expect(store.releasePlatformDrain("pop_1").mode).toBe("normal");
    // Release is idempotent.
    expect(store.releasePlatformDrain("pop_1").mode).toBe("normal");

    expect(store.beginPlatformDrain({ operationId: "pop_2" }).generation).toBe(2);
  });

  it("auto-recovers to normal when the lease expires (updater crash)", () => {
    const store = createStore();
    store.beginPlatformDrain({ operationId: "pop_crash", ttlMs: 30_000 });
    // Simulate the updater dying: age the lease past its expiry.
    db!.run("UPDATE multiremi_platform_maintenance SET expires_at = ? WHERE id = 'platform'", [
      new Date(Date.now() - 1_000).toISOString(),
    ]);
    expect(store.getPlatformMaintenance()).toMatchObject({ mode: "normal", operationId: null });
    // The expired lease can no longer be renewed.
    expect(store.renewPlatformDrain("pop_crash")).toBeNull();
  });

  it("gates readiness on daemon acks of the current generation AND zero in-flight tasks", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_drain", name: "drain", provider: "claude", workspaceId: "local" });
    store.heartbeatRuntime(runtime.id);
    const agent = store.createAgent({ name: "Drain Bot", provider: "claude", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "x" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    store.beginPlatformDrain({ operationId: "pop_gate" });
    let status = store.getPlatformDrainStatus();
    expect(status).toMatchObject({ onlineDaemons: 1, ackedDaemons: 0, activeTasks: 1, ready: false });
    expect(status.pendingRuntimes.map((r) => r.id)).toEqual([runtime.id]);

    // Ack alone is not enough while the task is still running.
    store.recordRuntimeDrainAck(runtime.id, status.maintenance.generation, 1);
    status = store.getPlatformDrainStatus();
    expect(status).toMatchObject({ ackedDaemons: 1, activeTasks: 1, ready: false });

    store.completeTask(task.id, { output: "done" });
    expect(store.getPlatformDrainStatus()).toMatchObject({ ackedDaemons: 1, activeTasks: 0, ready: true });

    // A stale ack from a previous generation does not count after re-drain.
    store.releasePlatformDrain("pop_gate");
    store.beginPlatformDrain({ operationId: "pop_gate2" });
    expect(store.getPlatformDrainStatus()).toMatchObject({ ackedDaemons: 0, ready: false });
  });

  it("excludes offline runtimes from the ack quorum but keeps their tasks in the gate", () => {
    const store = createStore();
    const online = store.registerRuntime({ id: "rt_on", name: "on", provider: "claude", workspaceId: "local" });
    store.heartbeatRuntime(online.id);
    const offline = store.registerRuntime({ id: "rt_off", name: "off", provider: "claude", workspaceId: "local" });
    store.heartbeatRuntime(offline.id);
    db!.run("UPDATE multiremi_runtimes SET last_heartbeat_at = ? WHERE id = ?", [
      new Date(Date.now() - 10 * 60_000).toISOString(),
      offline.id,
    ]);
    const agent = store.createAgent({ name: "Off Bot", provider: "claude", runtimeId: offline.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "x", runtimeId: offline.id });

    store.beginPlatformDrain({ operationId: "pop_off" });
    const generation = store.getPlatformMaintenance().generation;
    store.recordRuntimeDrainAck(online.id, generation, 0);
    const status = store.getPlatformDrainStatus();
    // Only the online runtime counts for acks; the offline runtime's queued
    // task does not block (queued is not in-flight)...
    expect(status).toMatchObject({ onlineDaemons: 1, ackedDaemons: 1, activeTasks: 0, ready: true });
    // ...but once dispatched/running it holds the gate (fail-safe).
    db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [task.id]);
    expect(store.getPlatformDrainStatus()).toMatchObject({ activeTasks: 1, ready: false });
  });
});

describe("daemon heartbeat drain directive", () => {
  it("carries the drain directive in the ack and records the daemon's ack + active count", async () => {
    const { app, store } = updaterApp();
    const runtime = store.registerRuntime({ id: "rt_hb", name: "hb", provider: "claude", workspaceId: "local" });

    const heartbeat = (body: Record<string, unknown>) => app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer master-secret" },
      body: JSON.stringify({ runtime_id: runtime.id, ...body }),
    });

    let response = await heartbeat({});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ drain: { mode: "normal", generation: 0 } });

    store.beginPlatformDrain({ operationId: "pop_hb" });
    response = await heartbeat({ drain_ack_generation: 1, active_task_count: 2 });
    expect(await response.json()).toMatchObject({ drain: { mode: "draining", generation: 1 } });
    expect(store.getPlatformDrainStatus()).toMatchObject({ ackedDaemons: 1 });
    const row = db!.query("SELECT drain_ack_generation, drain_reported_active_tasks FROM multiremi_runtimes WHERE id = ?").get(runtime.id) as any;
    expect(row).toMatchObject({ drain_ack_generation: 1, drain_reported_active_tasks: 2 });
  });

  it("flips an expired drain back to normal on the very next heartbeat", async () => {
    const { app, store } = updaterApp();
    const runtime = store.registerRuntime({ id: "rt_hb2", name: "hb2", provider: "claude", workspaceId: "local" });
    store.beginPlatformDrain({ operationId: "pop_exp" });
    db!.run("UPDATE multiremi_platform_maintenance SET expires_at = ? WHERE id = 'platform'", [
      new Date(Date.now() - 1_000).toISOString(),
    ]);
    const response = await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer master-secret" },
      body: JSON.stringify({ runtime_id: runtime.id }),
    });
    expect(await response.json()).toMatchObject({ drain: { mode: "normal" } });
  });
});

describe("updater drain endpoints", () => {
  it("begin/renew/release round-trip with aggregated status and cancel flag", async () => {
    const { app, store } = updaterApp();
    const runtime = store.registerRuntime({ id: "rt_up", name: "up", provider: "claude", workspaceId: "local" });
    store.heartbeatRuntime(runtime.id);
    const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0", targetRef: "ref" }, "tester");
    store.claimPlatformOperation();

    const post = (path: string, body: Record<string, unknown>) => app.request(path, {
      method: "POST",
      headers: UPDATER_HEADERS,
      body: JSON.stringify(body),
    });

    let response = await post("/api/platform-updater/drain/begin", { operation_id: operation.id, reason: "test update" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      maintenance: { mode: "draining", generation: 1 },
      status: { online_daemons: 1, acked_daemons: 0, active_tasks: 0, ready: false },
    });

    store.recordRuntimeDrainAck(runtime.id, 1, 0);
    response = await post("/api/platform-updater/drain/renew", { operation_id: operation.id });
    expect(await response.json()).toMatchObject({
      status: { acked_daemons: 1, ready: true },
      cancel_requested: false,
    });

    store.cancelPlatformOperation(operation.id);
    response = await post("/api/platform-updater/drain/renew", { operation_id: operation.id });
    expect(await response.json()).toMatchObject({ cancel_requested: true });

    response = await post("/api/platform-updater/drain/release", { operation_id: operation.id });
    expect(await response.json()).toMatchObject({ maintenance: { mode: "normal" } });
    // The lease is gone: renew now reports 409 so the updater re-begins.
    response = await post("/api/platform-updater/drain/renew", { operation_id: operation.id });
    expect(response.status).toBe(409);

    // A missing updater token is rejected outright.
    const denied = await app.request("/api/platform-updater/drain/begin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer master-secret" },
      body: JSON.stringify({ operation_id: operation.id }),
    });
    expect(denied.status).toBe(401);
  });

  it("releases the drain when a terminal status is reported, even without an explicit release", async () => {
    const { app, store } = updaterApp();
    const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0", targetRef: "ref" }, "tester");
    store.claimPlatformOperation();
    store.beginPlatformDrain({ operationId: operation.id });
    const response = await app.request(`/api/platform-updater/operations/${operation.id}/report`, {
      method: "POST",
      headers: UPDATER_HEADERS,
      body: JSON.stringify({ status: "failed", error: "update failed after drain" }),
    });
    expect(response.status).toBe(200);
    // Task claiming resumes: maintenance is normal again.
    expect(store.getPlatformMaintenance().mode).toBe("normal");
  });
});

describe("operator cancel", () => {
  it("cancels a queued operation immediately and flags a claimed one for the updater", async () => {
    const { app, store } = updaterApp();
    const queued = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0", targetRef: "ref" }, "tester");
    let response = await app.request(`/api/multiremi/platform/operations/${queued.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer master-secret" },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).operation).toMatchObject({ status: "cancelled" });
    // The active slot is free again.
    expect(store.getActivePlatformOperation()).toBeNull();

    const claimed = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.1", targetRef: "ref" }, "tester");
    store.claimPlatformOperation();
    response = await app.request(`/api/multiremi/platform/operations/${claimed.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer master-secret" },
    });
    expect((await response.json()).operation).toMatchObject({ status: "preparing", cancelRequested: true });

    // From the switch phase on, cancellation is rejected.
    store.reportPlatformOperation(claimed.id, { status: "switching" });
    response = await app.request(`/api/multiremi/platform/operations/${claimed.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer master-secret" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "platform_operation_not_cancellable" });
  });

  it("exposes maintenance and lastOperation on the status endpoint", async () => {
    const { app, store } = updaterApp();
    const operation = store.createPlatformOperation({ kind: "update", targetVersion: "1.0.0", targetRef: "ref" }, "tester");
    store.claimPlatformOperation();
    store.beginPlatformDrain({ operationId: operation.id, reason: "platform update to 1.0.0" });
    const response = await app.request("/api/multiremi/platform/status", {
      headers: { Authorization: "Bearer master-secret" },
    });
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status.maintenance).toMatchObject({ mode: "draining", generation: 1, operationId: operation.id });
    expect(status.lastOperation).toMatchObject({ id: operation.id });

    store.reportPlatformOperation(operation.id, { status: "failed", error: "drain timed out" });
    store.releasePlatformDrain(operation.id);
    const after = await (await app.request("/api/multiremi/platform/status", {
      headers: { Authorization: "Bearer master-secret" },
    })).json();
    expect(after.activeOperation).toBeNull();
    expect(after.lastOperation).toMatchObject({ id: operation.id, status: "failed" });
    expect(after.maintenance).toMatchObject({ mode: "normal" });
  });
});
