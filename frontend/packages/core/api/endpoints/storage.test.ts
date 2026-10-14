import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpClient } from "../http";
import { ApiContractError } from "../schema";
import { StorageEndpoints } from "./storage";

const settings = {
  ttl_ms: 259_200_000, automation_ttl_ms: 86_400_000, max_retained: 50,
  orphan_ttl_ms: 259_200_000, snapshot_max_bytes: 268_435_456, chat_idle_days: 14,
};
const report = {
  version: 1, generated_at: "2026-10-13T00:00:00Z", mode: "dry_run", root: "/work",
  bytes: { work: 10, env: 20, traces: 30, shared: 40, legacy: 0 }, bytes_measured_at: "2026-10-12T23:00:00Z",
  subjects: { total: 3, active: 1, ended: 1, reclaimed: 1 },
  retained: { running: 1 },
  reclaimed_this_round: 0, forgotten_this_round: 0, freed_bytes: 0,
  plan: [{ subject: { kind: "issue", id: "iss_1" }, action: "reclaim", reason: "ended_ttl", bytes: 1024, unsaved_work: true }],
  errors: [],
};
const gcRun = {
  id: "gcr_1", runtime_id: "rt/1", daemon_id: "d1", mode: "dry_run", status: "completed",
  requested_by: "user-1", created_at: "2026-10-13T00:00:00Z", completed_at: "2026-10-13T00:00:05Z",
  error: null, report,
};

function endpointsWithResponse(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { api: new StorageEndpoints(new HttpClient("https://api.example.test")), fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("StorageEndpoints", () => {
  it("reads the effective policy and the workspace overrides", async () => {
    const { api, fetchMock } = endpointsWithResponse({ settings, overrides: { ttl_ms: 259_200_000 } });
    await expect(api.getWorkspaceStorage("ws/1")).resolves.toEqual({ settings, overrides: { ttl_ms: 259_200_000 } });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.test/api/workspaces/ws%2F1/storage");
  });

  it("sends only the changed keys and null resets on update", async () => {
    const { api, fetchMock } = endpointsWithResponse({ settings, overrides: {} });
    await api.updateWorkspaceStorage("ws-1", { ttl_ms: 7_200_000, chat_idle_days: null });
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "PUT" });
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ ttl_ms: 7_200_000, chat_idle_days: null });
  });

  it("rejects a policy missing an effective setting", async () => {
    const { ttl_ms: _ttl, ...incomplete } = settings;
    const { api } = endpointsWithResponse({ settings: incomplete, overrides: {} });
    await expect(api.getWorkspaceStorage("ws-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("lists daemons with their latest report, tolerating machines that never reported", async () => {
    const { api } = endpointsWithResponse({
      daemons: [
        { daemon_id: "d1", name: "build-1", runtime_ids: ["rt-1"], online: true, report, reported_at: "2026-10-13T00:00:00Z" },
        { daemon_id: "d2", name: "build-2", runtime_ids: ["rt-2"], online: false, report: null, reported_at: null },
      ],
    });
    const { daemons } = await api.listWorkspaceStorageDaemons("ws-1");
    expect(daemons[0]?.report?.plan[0]).toMatchObject({ subject: { kind: "issue", id: "iss_1" }, unsaved_work: true });
    expect(daemons[1]).toMatchObject({ online: false, report: null });
  });

  it("reads when the sizes were measured, and tolerates a report that says nothing about it", async () => {
    const { bytes_measured_at: _measuredAt, ...unmeasured } = report;
    const { api } = endpointsWithResponse({
      daemons: [
        { daemon_id: "d1", name: "build-1", runtime_ids: ["rt-1"], online: true, report, reported_at: "2026-10-13T00:00:00Z" },
        { daemon_id: "d2", name: "build-2", runtime_ids: ["rt-2"], online: true, report: { ...unmeasured, bytes: null }, reported_at: "2026-10-13T00:00:00Z" },
      ],
    });
    const { daemons } = await api.listWorkspaceStorageDaemons("ws-1");
    expect(daemons[0]?.report).toMatchObject({ bytes: { work: 10 }, bytes_measured_at: "2026-10-12T23:00:00Z" });
    expect(daemons[1]?.report).toMatchObject({ bytes: null, bytes_measured_at: null });
  });

  it("shows a machine whose report is malformed as not yet reported, keeping the others usable", async () => {
    const { api } = endpointsWithResponse({
      daemons: [
        { daemon_id: "d1", name: "bad", runtime_ids: ["rt-1"], online: true, report: { ...report, subjects: null }, reported_at: "2026-10-13T00:00:00Z" },
        { daemon_id: "d2", name: "good", runtime_ids: ["rt-2"], online: true, report, reported_at: "2026-10-13T00:00:00Z" },
      ],
    });
    const { daemons } = await api.listWorkspaceStorageDaemons("ws-1");
    expect(daemons[0]).toMatchObject({ daemon_id: "d1", runtime_ids: ["rt-1"], report: null });
    expect(daemons[1]?.report?.subjects.total).toBe(3);
  });

  it("rejects a daemon list that is not a list", async () => {
    const { api } = endpointsWithResponse({ daemons: "nope" });
    await expect(api.listWorkspaceStorageDaemons("ws-1")).rejects.toBeInstanceOf(ApiContractError);
  });

  it("starts and reads a GC run", async () => {
    const { api, fetchMock } = endpointsWithResponse({ request: gcRun }, 201);
    await expect(api.createRuntimeGcRun("rt/1", { mode: "dry_run" })).resolves.toMatchObject({ id: "gcr_1", status: "completed" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.example.test/api/runtimes/rt%2F1/gc-runs");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ mode: "dry_run" });
    await api.getRuntimeGcRun("rt/1", "gcr_1");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.example.test/api/runtimes/rt%2F1/gc-runs/gcr_1");
  });

  it("rejects a GC run response without a request", async () => {
    const { api } = endpointsWithResponse({});
    await expect(api.createRuntimeGcRun("rt-1", { mode: "run" })).rejects.toBeInstanceOf(ApiContractError);
  });
});
