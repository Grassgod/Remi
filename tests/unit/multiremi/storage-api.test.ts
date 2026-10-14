// ADR 0018: workspace storage policy, the per-daemon storage reports and the
// on-demand reclaim round (`POST /api/runtimes/:id/gc-runs`).
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { STORAGE_SETTINGS_DEFAULTS, type StorageReport } from "@multiremi/contracts/storage.js";
import { reportFrame } from "../../fixtures/report-session.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const report: StorageReport = {
  version: 1, generated_at: "2026-10-13T00:00:00.000Z", mode: "dry_run", root: "/srv/remi/workspaces",
  bytes: { work: 10, env: 20, traces: 3, shared: 4, legacy: 0 }, bytes_measured_at: "2026-10-12T23:00:00.000Z",
  subjects: { total: 3, active: 1, ended: 1, reclaimed: 1 },
  retained: { within_ttl: 1 }, reclaimed_this_round: 0, forgotten_this_round: 0, freed_bytes: 0,
  plan: [{ subject: { kind: "issue", id: "iss_1" }, action: "reclaim", reason: "ended_ttl", bytes: 4096, unsaved_work: true }],
  errors: [],
};

async function fixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const workspace = store.createWorkspace({ id: "wss_storage", name: "Storage", slug: "storage", issuePrefix: "ST" });
  const other = store.createWorkspace({ id: "wss_other", name: "Other", slug: "other", issuePrefix: "OT" });
  const token = async (workspaceId: string, role: "owner" | "admin" | "member") => {
    const user = store.getOrCreateUser({ email: `${role}-${workspaceId}@storage.test`, name: `${role} ${workspaceId}` });
    store.createWorkspaceMember({ workspaceId, userId: user.id, name: user.name, email: user.email, role });
    return (await store.createAccessToken({ type: "pat", workspaceId, userId: user.id, name: `${role} token` })).token;
  };
  const tokens = {
    owner: await token(workspace.id, "owner"),
    admin: await token(workspace.id, "admin"),
    member: await token(workspace.id, "member"),
    outsider: await token(other.id, "owner"),
  };
  const app = createMultiremiApp({ store, authToken: "root-secret", backgroundJobs: false });
  const request = (who: keyof typeof tokens | "root", method: string, path: string, body?: unknown) => app.request(path, {
    method,
    headers: { Authorization: `Bearer ${who === "root" ? "root-secret" : tokens[who]}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, workspace, other, request };
}

describe("workspace storage policy", () => {
  it("serves defaults, stores overrides under settings.storage and resets them with null", async () => {
    const { store, workspace, request } = await fixture();
    const path = `/api/workspaces/${workspace.id}/storage`;

    const initial = await request("member", "GET", path);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ settings: STORAGE_SETTINGS_DEFAULTS, overrides: {} });

    const updated = await request("admin", "PUT", path, { ttl_ms: 7_200_000, max_retained: 0, chat_idle_days: 30 });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({
      settings: { ...STORAGE_SETTINGS_DEFAULTS, ttl_ms: 7_200_000, max_retained: 0, chat_idle_days: 30 },
      overrides: { ttl_ms: 7_200_000, max_retained: 0, chat_idle_days: 30 },
    });
    expect(store.getWorkspace(workspace.id)?.settings.storage).toEqual({ ttl_ms: 7_200_000, max_retained: 0, chat_idle_days: 30 });

    const reset = await request("owner", "PUT", path, { max_retained: null, snapshot_max_bytes: 2_097_152 });
    expect(await reset.json()).toEqual({
      settings: { ...STORAGE_SETTINGS_DEFAULTS, ttl_ms: 7_200_000, chat_idle_days: 30, snapshot_max_bytes: 2_097_152 },
      overrides: { ttl_ms: 7_200_000, chat_idle_days: 30, snapshot_max_bytes: 2_097_152 },
    });

    await request("admin", "PUT", path, { ttl_ms: null, chat_idle_days: null, snapshot_max_bytes: null });
    expect(store.getWorkspace(workspace.id)?.settings).not.toHaveProperty("storage");
    expect(await (await request("member", "GET", path)).json()).toEqual({ settings: STORAGE_SETTINGS_DEFAULTS, overrides: {} });
  });

  it("serves the default local workspace without an explicit setup", async () => {
    const { request } = await fixture();
    const response = await request("root", "GET", "/api/workspaces/local/storage");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ settings: STORAGE_SETTINGS_DEFAULTS, overrides: {} });
    const saved = await request("root", "PUT", "/api/workspaces/local/storage", { ttl_ms: 7_200_000 });
    expect((await saved.json()).overrides).toEqual({ ttl_ms: 7_200_000 });
  });

  it("keeps the other workspace settings when it writes storage", async () => {
    const { store, workspace, request } = await fixture();
    store.updateWorkspace(workspace.id, { settings: { issue_archive: { ttl_ms: 3_600_000 }, session_archive: { workspace_ttl_ms: 1 } } });
    await request("admin", "PUT", `/api/workspaces/${workspace.id}/storage`, { orphan_ttl_ms: 3_600_000 });
    expect(store.getWorkspace(workspace.id)?.settings).toEqual({
      issue_archive: { ttl_ms: 3_600_000 }, session_archive: { workspace_ttl_ms: 1 }, storage: { orphan_ttl_ms: 3_600_000 },
    });
  });

  it("rejects out-of-range values and unknown keys with field details and changes nothing", async () => {
    const { store, workspace, request } = await fixture();
    const path = `/api/workspaces/${workspace.id}/storage`;
    const rejected = await request("admin", "PUT", path, { ttl_ms: 1, max_retained: 1.5, color: 3, automation_ttl_ms: 7_200_000 });
    expect(rejected.status).toBe(400);
    const body = await rejected.json();
    expect(body.error).toBe("invalid storage settings");
    expect(body.details).toHaveLength(3);
    expect(body.details.join("\n")).toContain("ttl_ms");
    expect(body.details.join("\n")).toContain("max_retained");
    expect(body.details.join("\n")).toContain("color");
    expect(store.getWorkspace(workspace.id)?.settings).not.toHaveProperty("storage");
    expect((await request("admin", "PUT", path, [1])).status).toBe(400);
  });

  it("lets members read but only owners and admins write, and hides the workspace from outsiders", async () => {
    const { workspace, request } = await fixture();
    const path = `/api/workspaces/${workspace.id}/storage`;
    expect((await request("member", "GET", path)).status).toBe(200);
    expect((await request("member", "PUT", path, { ttl_ms: 7_200_000 })).status).toBe(403);
    expect((await request("outsider", "GET", path)).status).toBeGreaterThanOrEqual(403);
    expect((await request("outsider", "PUT", path, { ttl_ms: 7_200_000 })).status).toBeGreaterThanOrEqual(403);
    expect((await request("root", "GET", "/api/workspaces/missing/storage")).status).toBeGreaterThanOrEqual(403);
  });

  it("announces a policy change to the workspace and refuses task tokens", async () => {
    const { store, workspace, request } = await fixture();
    const events: string[] = [];
    store.onWorkspaceEvent(event => events.push(event.type));
    await request("admin", "PUT", `/api/workspaces/${workspace.id}/storage`, { ttl_ms: 7_200_000 });
    expect(events).toContain("workspace:updated");

    const agent = store.createAgent({ name: "Storage agent", provider: "claude", workspaceId: workspace.id });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: workspace.id });
    const task = store.sendChatMessage(chat.id, { content: "hi" }).task;
    const taskToken = (await store.createTaskAccessToken(task, workspace.id)).token;
    const app = createMultiremiApp({ store, authToken: "root-secret", backgroundJobs: false });
    const denied = await app.request(`/api/workspaces/${workspace.id}/storage`, {
      method: "PUT", headers: { Authorization: `Bearer ${taskToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_ms: 3_600_000 }),
    });
    expect(denied.status).toBe(403);
    expect(store.getWorkspace(workspace.id)?.settings.storage).toEqual({ ttl_ms: 7_200_000 });
  });

  it("delivers the policy to daemons through the workspace.settings downlink", async () => {
    const { store, workspace, request } = await fixture();
    await request("admin", "PUT", `/api/workspaces/${workspace.id}/storage`, { ttl_ms: 7_200_000 });
    const { runtimeInputSnapshot } = await import("@multiremi/api/daemon-protocol/runtime-input-snapshot.js");
    store.registerRuntime({ id: "rt_policy", name: "Policy", provider: "claude", daemonId: "dmn_policy", workspaceId: workspace.id });
    const settings = runtimeInputSnapshot(store, "rt_policy").find((entity) => entity.type === "workspace.settings");
    expect(settings?.payload).toMatchObject({ settings: { storage: { ttl_ms: 7_200_000 } } });
  });
});

describe("daemon storage reports", () => {
  it("groups the workspace runtimes by daemon with the latest report of each", async () => {
    const { store, workspace, other, request } = await fixture();
    store.registerRuntime({ id: "rt_a_claude", name: "A claude", provider: "claude", daemonId: "dmn_a", workspaceId: workspace.id });
    store.registerRuntime({ id: "rt_a_codex", name: "A codex", provider: "codex", daemonId: "dmn_a", workspaceId: workspace.id });
    store.registerRuntime({ id: "rt_b", name: "B", provider: "claude", daemonId: "dmn_b", workspaceId: workspace.id });
    store.registerRuntime({ id: "rt_foreign", name: "Foreign", provider: "claude", daemonId: "dmn_foreign", workspaceId: other.id });
    store.setRuntimeOffline("rt_b");
    store.saveDaemonStorageReport("dmn_a", "rt_a_claude", { ...report, freed_bytes: 1 });
    store.saveDaemonStorageReport("dmn_a", "rt_a_codex", report);
    store.saveDaemonStorageReport("dmn_foreign", "rt_foreign", report);

    const response = await request("member", "GET", `/api/workspaces/${workspace.id}/storage/daemons`);
    expect(response.status).toBe(200);
    const { daemons } = await response.json();
    expect(daemons.map((daemon: { daemon_id: string }) => daemon.daemon_id).sort()).toEqual(["dmn_a", "dmn_b"]);
    const a = daemons.find((daemon: { daemon_id: string }) => daemon.daemon_id === "dmn_a");
    expect([...a.runtime_ids].sort()).toEqual(["rt_a_claude", "rt_a_codex"]);
    expect(a).toMatchObject({ online: true, report });
    expect(a.reported_at).toEqual(expect.any(String));
    expect(daemons.find((daemon: { daemon_id: string }) => daemon.daemon_id === "dmn_b"))
      .toMatchObject({ runtime_ids: ["rt_b"], online: false, report: null, reported_at: null });
    expect((await request("outsider", "GET", `/api/workspaces/${workspace.id}/storage/daemons`)).status).toBeGreaterThanOrEqual(403);
  });

  it("keeps a daemon's report per workspace and drops only its own workspace's report on retirement", async () => {
    const { store, workspace, other, request } = await fixture();
    store.registerRuntime({ id: "rt_shared_a", name: "Shared A", provider: "claude", daemonId: "dmn_shared", workspaceId: workspace.id });
    store.registerRuntime({ id: "rt_shared_b", name: "Shared B", provider: "claude", daemonId: "dmn_shared", workspaceId: other.id });
    store.saveDaemonStorageReport("dmn_shared", "rt_shared_a", { ...report, freed_bytes: 11 });
    store.saveDaemonStorageReport("dmn_shared", "rt_shared_b", { ...report, freed_bytes: 22 });

    const read = async (who: "owner" | "outsider", id: string) =>
      (await (await request(who, "GET", `/api/workspaces/${id}/storage/daemons`)).json()).daemons[0].report.freed_bytes;
    expect(await read("owner", workspace.id)).toBe(11);
    expect(await read("outsider", other.id)).toBe(22);

    const plan = store.getDaemonRetirementPlan(workspace.id, "dmn_shared");
    store.retireDaemon(workspace.id, "dmn_shared", plan.snapshot, "owner");
    expect(store.listDaemonStorageReports(workspace.id, ["dmn_shared"])).toEqual([]);
    expect(store.listDaemonStorageReports(other.id, ["dmn_shared"])).toHaveLength(1);
  });

  it("stores the best-effort gc.storage_report frame per daemon and ignores a malformed one", async () => {
    const { store, workspace } = await fixture();
    const runtime = store.registerRuntime({ id: "rt_report", name: "Report", provider: "claude", daemonId: "dmn_report", workspaceId: workspace.id });
    await reportFrame(store, "gc.storage_report", { runtime_id: runtime.id, report: { ...report, freed_bytes: 7 } }, { runtimeId: runtime.id });
    await reportFrame(store, "gc.storage_report", { runtime_id: runtime.id, report: { version: 2 } }, { runtimeId: runtime.id });
    expect(store.listDaemonStorageReports(workspace.id, ["dmn_report", "dmn_never"])).toEqual([
      { daemonId: "dmn_report", runtimeId: runtime.id, report: { ...report, freed_bytes: 7 }, reportedAt: expect.any(String) },
    ]);
    await reportFrame(store, "gc.storage_report", { runtime_id: runtime.id, report }, { runtimeId: runtime.id });
    expect(store.listDaemonStorageReports(workspace.id, ["dmn_report"])[0]?.report.freed_bytes).toBe(0);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_daemon_storage_reports").get()).toEqual({ count: 1 });
  });

  it("keeps the last measured category sizes and their time when a later report has none", async () => {
    const { store, workspace } = await fixture();
    const runtime = store.registerRuntime({ id: "rt_bytes", name: "Bytes", provider: "claude", daemonId: "dmn_bytes", workspaceId: workspace.id });
    store.saveDaemonStorageReport("dmn_bytes", runtime.id, report);
    store.saveDaemonStorageReport("dmn_bytes", runtime.id, { ...report, bytes: null, bytes_measured_at: null, freed_bytes: 5 });
    expect(store.listDaemonStorageReports(workspace.id, ["dmn_bytes"])[0]?.report)
      .toMatchObject({ bytes: report.bytes, bytes_measured_at: report.bytes_measured_at, freed_bytes: 5 });

    // A newer measurement replaces both together.
    const newer = { work: 1, env: 2, traces: 3, shared: 4, legacy: 5 };
    store.saveDaemonStorageReport("dmn_bytes", runtime.id, { ...report, bytes: newer, bytes_measured_at: "2026-10-13T06:00:00.000Z" });
    expect(store.listDaemonStorageReports(workspace.id, ["dmn_bytes"])[0]?.report)
      .toMatchObject({ bytes: newer, bytes_measured_at: "2026-10-13T06:00:00.000Z" });
  });
});

describe("reclaim rounds on demand", () => {
  async function online() {
    const context = await fixture();
    const runtime = context.store.registerRuntime({
      id: "rt_gc", name: "GC", provider: "claude", daemonId: "dmn_gc", workspaceId: context.workspace.id,
    });
    return { ...context, runtime };
  }

  it("creates a pending request, hands it to the daemon as runtime.gc_run and records the report", async () => {
    const { store, runtime, request } = await online();
    const created = await request("admin", "POST", `/api/runtimes/${runtime.id}/gc-runs`, { mode: "dry_run" });
    expect(created.status).toBe(201);
    const { request: pending } = await created.json();
    expect(pending).toMatchObject({
      runtime_id: runtime.id, daemon_id: "dmn_gc", mode: "dry_run", status: "pending",
      completed_at: null, error: null, report: null,
    });
    expect(pending.id).toStartWith("rgc_");
    expect(pending.requested_by).toEqual(expect.any(String));

    expect(store.pendingRuntimeRequests(runtime.id)).toContainEqual({
      kind: "gc_run", id: pending.id, payload: { id: pending.id, mode: "dry_run" },
    });
    store.claimAcknowledgedRuntimeRequest(runtime.id, "gc_run", pending.id);
    expect(store.getRuntimeGcRunRequest(runtime.id, pending.id)?.status).toBe("running");
    expect(store.pendingRuntimeRequests(runtime.id).filter((entry) => entry.kind === "gc_run")).toEqual([]);

    const result = await reportFrame(store, "runtime.gc_run_result",
      { runtime_id: runtime.id, request_id: pending.id, status: "completed", report: { ...report, mode: "dry_run" }, error: null },
      { runtimeId: runtime.id });
    expect(result).toEqual({ ok: true });
    const read = await request("member", "GET", `/api/runtimes/${runtime.id}/gc-runs/${pending.id}`);
    expect(read.status).toBe(200);
    expect((await read.json()).request).toMatchObject({
      id: pending.id, status: "completed", report: { ...report, mode: "dry_run" }, completed_at: expect.any(String), error: null,
    });

    // A replay of a finished request is absorbed, a different status does not rewrite it.
    expect(await reportFrame(store, "runtime.gc_run_result",
      { runtime_id: runtime.id, request_id: pending.id, status: "failed", report: null, error: "late" }, { runtimeId: runtime.id })).toEqual({ ok: true });
    expect(store.getRuntimeGcRunRequest(runtime.id, pending.id)?.status).toBe("completed");
  });

  it("records a failed round with its error and rejects a result the protocol does not allow", async () => {
    const { store, runtime, request } = await online();
    const { request: pending } = await (await request("owner", "POST", `/api/runtimes/${runtime.id}/gc-runs`, { mode: "run" })).json();
    expect(pending.mode).toBe("run");
    expect(await reportFrame(store, "runtime.gc_run_result",
      { runtime_id: runtime.id, request_id: pending.id, status: "running", report: null, error: null }, { runtimeId: runtime.id }))
      .toMatchObject({ ok: false, code: "invalid_report" });
    expect(await reportFrame(store, "runtime.gc_run_result",
      { runtime_id: runtime.id, request_id: pending.id, status: "completed", report: null, error: null }, { runtimeId: runtime.id }))
      .toMatchObject({ ok: false, code: "invalid_report" });
    expect(await reportFrame(store, "runtime.gc_run_result",
      { runtime_id: runtime.id, request_id: pending.id, status: "failed", report: null, error: "disk unreadable" }, { runtimeId: runtime.id }))
      .toEqual({ ok: true });
    expect(store.getRuntimeGcRunRequest(runtime.id, pending.id)).toMatchObject({
      status: "failed", error: "disk unreadable", report: null, completed_at: expect.any(String),
    });
    expect(await reportFrame(store, "runtime.gc_run_result",
      { runtime_id: runtime.id, request_id: "rgc_unknown", status: "failed", report: null, error: "x" }, { runtimeId: runtime.id }))
      .toMatchObject({ ok: false, code: "task_not_found" });
  });

  it("times a request out after ten minutes without an answer", async () => {
    const { store, runtime, request } = await online();
    const { request: pending } = await (await request("admin", "POST", `/api/runtimes/${runtime.id}/gc-runs`, { mode: "dry_run" })).json();
    const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    db!.run("UPDATE multiremi_runtime_gc_run_requests SET created_at = ? WHERE id = ?", [old, pending.id]);
    const read = await (await request("admin", "GET", `/api/runtimes/${runtime.id}/gc-runs/${pending.id}`)).json();
    expect(read.request).toMatchObject({ status: "timeout", error: "daemon did not respond within 10 minutes", completed_at: expect.any(String) });
    expect(store.pendingRuntimeRequests(runtime.id).filter((entry) => entry.kind === "gc_run")).toEqual([]);

    const { request: running } = await (await request("admin", "POST", `/api/runtimes/${runtime.id}/gc-runs`, { mode: "run" })).json();
    store.claimAcknowledgedRuntimeRequest(runtime.id, "gc_run", running.id);
    db!.run("UPDATE multiremi_runtime_gc_run_requests SET run_started_at = ? WHERE id = ?", [old, running.id]);
    expect(store.getRuntimeGcRunRequest(runtime.id, running.id)).toMatchObject({
      status: "timeout", error: "daemon did not finish the reclaim round within 10 minutes",
    });
  });

  it("lets the result of a round that outlived the timeout replace the timeout", async () => {
    const { store, runtime, request } = await online();
    const { request: running } = await (await request("admin", "POST", `/api/runtimes/${runtime.id}/gc-runs`, { mode: "run" })).json();
    store.claimAcknowledgedRuntimeRequest(runtime.id, "gc_run", running.id);
    db!.run("UPDATE multiremi_runtime_gc_run_requests SET run_started_at = ? WHERE id = ?", [new Date(Date.now() - 11 * 60 * 1000).toISOString(), running.id]);
    expect(store.getRuntimeGcRunRequest(runtime.id, running.id)).toMatchObject({ status: "timeout" });

    expect(await reportFrame(store, "runtime.gc_run_result",
      { runtime_id: runtime.id, request_id: running.id, status: "completed", report, error: null }, { runtimeId: runtime.id }))
      .toEqual({ ok: true });
    expect(store.getRuntimeGcRunRequest(runtime.id, running.id)).toMatchObject({ status: "completed", error: null, report });
  });

  it("validates the mode, requires an owner or admin and an online runtime", async () => {
    const { store, runtime, request } = await online();
    const path = `/api/runtimes/${runtime.id}/gc-runs`;
    expect((await request("admin", "POST", path, { mode: "everything" })).status).toBe(400);
    expect((await request("admin", "POST", path, {})).status).toBe(400);
    expect((await request("member", "POST", path, { mode: "dry_run" })).status).toBe(403);
    expect((await request("outsider", "POST", path, { mode: "dry_run" })).status).toBeGreaterThanOrEqual(403);
    expect((await request("admin", "POST", "/api/runtimes/rt_missing/gc-runs", { mode: "dry_run" })).status).toBe(404);
    expect((await request("admin", "GET", `${path}/rgc_missing`)).status).toBe(404);
    expect((await request("outsider", "GET", `${path}/rgc_missing`)).status).toBeGreaterThanOrEqual(403);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_gc_run_requests").get()).toEqual({ count: 0 });

    store.setRuntimeOffline(runtime.id);
    const offline = await request("admin", "POST", path, { mode: "dry_run" });
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ error: "runtime is offline" });
  });

  it("goes with its Runtime when the Runtime is deleted", async () => {
    const { store, runtime, request } = await online();
    store.registerRuntime({ id: "rt_gc_sibling", name: "Sibling", provider: "codex", daemonId: "dmn_gc", workspaceId: runtime.workspaceId });
    await request("admin", "POST", `/api/runtimes/${runtime.id}/gc-runs`, { mode: "dry_run" });
    expect(store.deleteRuntime(runtime.id)).toBe(true);
    expect(db!.query("SELECT COUNT(*) AS count FROM multiremi_runtime_gc_run_requests").get()).toEqual({ count: 0 });
  });
});
