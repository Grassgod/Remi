// The JSON data endpoints the Next.js frontend reads (D11 removed the
// server-rendered HTML dashboard; only this contract survived).
//
// MUL-92: the frontend parses these responses with zod schemas whose fields
// are snake_case and all carry `.default(0)` — so a camelCase body "parses"
// with every number defaulted to zero and the dashboard renders all-zeros.
// These tests lock the snake_case wire contract field-by-field.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — dashboard JSON endpoints", () => {
  function seedRuntimeWithUsage(store: MultiremiStore, options: {
    runtimeId: string;
    workspaceId?: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    projectId?: string;
  }): { agentId: string; runtimeId: string; taskId: string } {
    const workspaceId = options.workspaceId ?? "local";
    const provider = options.provider ?? "claude";
    store.registerRuntime({ id: options.runtimeId, name: `Runtime ${options.runtimeId}`, provider, workspaceId });
    const agent = store.createAgent({ name: `Agent ${options.runtimeId}`, provider, workspaceId });
    const issue = store.createIssue({
      title: `Issue ${options.runtimeId}`,
      assigneeType: "agent",
      assigneeId: agent.id,
      workspaceId,
      ...(options.projectId ? { projectId: options.projectId } : {}),
    });
    const task = store.createTask({ agentId: agent.id, workspaceId, issueId: issue.id, prompt: "seed usage" });
    const claimed = store.claimTask(options.runtimeId);
    expect(claimed?.id).toBe(task.id);
    store.reportTaskUsage(task.id, [{
      provider,
      model: options.model ?? "sonnet",
      inputTokens: options.inputTokens ?? 21,
      outputTokens: options.outputTokens ?? 8,
    }]);
    return { agentId: agent.id, runtimeId: options.runtimeId, taskId: task.id };
  }

  it("serves the JSON service status at / instead of HTML", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const response = await app.request("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ service: "multiremi-api", ui: "frontend/apps/web" });
    expect(JSON.stringify(body)).not.toContain("<html");
    expect(JSON.stringify(body)).not.toContain("<!DOCTYPE");
  });

  it("returns 204 with no body for /favicon.ico", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });

    const response = await app.request("/favicon.ico");
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("serves /api/dashboard/usage/daily in the snake_case wire shape the frontend schema parses", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_daily", inputTokens: 21, outputTokens: 8 });

    const response = await app.request("/api/dashboard/usage/daily?workspace_id=local");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json();
    expect(body).toHaveLength(1);
    // Exact contract — a camelCase regression here zeroes the whole dashboard
    // through the frontend's `.default(0)` zod schema (MUL-92).
    expect(body[0]).toEqual({
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      runtime_id: "rt_daily",
      provider: "claude",
      model: "sonnet",
      input_tokens: 21,
      output_tokens: 8,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      task_count: 1,
    });
  });

  it("serves /api/dashboard/usage/by-agent in the snake_case wire shape", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const seeded = seedRuntimeWithUsage(store, { runtimeId: "rt_by_agent", inputTokens: 13, outputTokens: 4 });

    const response = await app.request("/api/dashboard/usage/by-agent?workspace_id=local");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual([{
      agent_id: seeded.agentId,
      model: "sonnet",
      input_tokens: 13,
      output_tokens: 4,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_tokens: 0,
      task_count: 1,
    }]);
  });

  it("serves /api/dashboard/runtime/daily with per-day task/failed counts in snake_case", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const okRuntime = seedRuntimeWithUsage(store, { runtimeId: "rt_runtime_daily" });
    store.completeTask(okRuntime.taskId, { output: "done" });

    const agent = store.createAgent({ name: "Failing", provider: "claude", workspaceId: "local" });
    const failingTask = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "will fail" });
    store.claimTask("rt_runtime_daily");
    store.failTask(failingTask.id, { error: "boom" });

    const response = await app.request("/api/dashboard/runtime/daily?workspace_id=local");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ task_count: 2, failed_count: 1 });
    expect(body[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof body[0].total_seconds).toBe("number");
    expect(body[0].taskCount).toBeUndefined();
  });

  it("serves /api/dashboard/agent-runtime as a per-agent leaderboard that reconciles with runtime/daily", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const first = seedRuntimeWithUsage(store, { runtimeId: "rt_leader_a" });
    store.completeTask(first.taskId, { output: "done" });
    const second = seedRuntimeWithUsage(store, { runtimeId: "rt_leader_b" });
    store.failTask(second.taskId, { error: "boom" });

    const agentRuntime = await app.request("/api/dashboard/agent-runtime?workspace_id=local");
    expect(agentRuntime.status).toBe(200);
    const rows = await agentRuntime.json();
    // One row per agent (the leaderboard groups by agent, not by day).
    expect(rows).toHaveLength(2);
    const byAgent = new Map(rows.map((row: any) => [row.agent_id, row]));
    expect(byAgent.get(first.agentId)).toMatchObject({ task_count: 1, failed_count: 0 });
    expect(byAgent.get(second.agentId)).toMatchObject({ task_count: 1, failed_count: 1 });

    // Leaderboard totals must reconcile with the overview cards (runtime/daily).
    const daily = await (await app.request("/api/dashboard/runtime/daily?workspace_id=local")).json();
    const sum = (list: any[], field: string) => list.reduce((total, row) => total + row[field], 0);
    expect(sum(rows, "task_count")).toBe(sum(daily, "task_count"));
    expect(sum(rows, "failed_count")).toBe(sum(daily, "failed_count"));
    expect(sum(rows, "total_seconds")).toBe(sum(daily, "total_seconds"));
  });

  it("aggregates usage reported through the daemon wire endpoint end-to-end", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const seeded = seedRuntimeWithUsage(store, { runtimeId: "rt_e2e", inputTokens: 0, outputTokens: 0 });

    // The daemon client posts snake_case usage entries (worker/client.ts).
    const report = await app.request(`/api/daemon/tasks/${seeded.taskId}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        usage: [{
          provider: "claude",
          model: "sonnet",
          input_tokens: 1200,
          output_tokens: 340,
          cache_read_tokens: 5600,
          cache_write_tokens: 780,
          total_tokens: 7920,
        }],
      }),
    });
    expect(report.status).toBe(200);

    const daily = await (await app.request("/api/dashboard/usage/daily?workspace_id=local")).json();
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_tokens: 5600,
      cache_write_tokens: 780,
      total_tokens: 7920,
      task_count: 1,
    });

    const byAgent = await (await app.request("/api/dashboard/usage/by-agent?workspace_id=local")).json();
    expect(byAgent).toEqual([{
      agent_id: seeded.agentId,
      model: "sonnet",
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_tokens: 5600,
      cache_write_tokens: 780,
      total_tokens: 7920,
      task_count: 1,
    }]);
  });

  it("resolves the workspace from the X-Workspace-Slug header when no query param is sent", async () => {
    const store = createStore();
    store.createWorkspace({ id: "ws_other", name: "Other", slug: "other" });
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_slug_local", workspaceId: "local", model: "sonnet" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_slug_other", workspaceId: "ws_other", model: "opus" });

    // The web client sends only the slug header — no workspace query param.
    const other = await (await app.request("/api/dashboard/usage/daily", {
      headers: { "X-Workspace-Slug": "other" },
    })).json();
    expect(other.map((row: any) => row.model)).toEqual(["opus"]);

    // No slug and no param falls back to the local workspace.
    const fallback = await (await app.request("/api/dashboard/usage/daily")).json();
    expect(fallback.map((row: any) => row.model)).toEqual(["sonnet"]);

    // An explicit query param wins over the header.
    const explicit = await (await app.request("/api/dashboard/usage/daily?workspace_id=local", {
      headers: { "X-Workspace-Slug": "other" },
    })).json();
    expect(explicit.map((row: any) => row.model)).toEqual(["sonnet"]);
  });

  it("isolates dashboard usage by workspace_id", async () => {
    const store = createStore();
    store.createWorkspace({ id: "ws_other", name: "Other", slug: "other" });
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_local_ws", workspaceId: "local", model: "sonnet" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_other_ws", workspaceId: "ws_other", model: "opus" });

    const localBody = await (await app.request("/api/dashboard/usage/daily?workspace_id=local")).json();
    expect(localBody.map((row: any) => row.model)).toEqual(["sonnet"]);

    const otherBody = await (await app.request("/api/dashboard/usage/daily?workspace_id=ws_other")).json();
    expect(otherBody.map((row: any) => row.model)).toEqual(["opus"]);
  });

  it("filters dashboard usage by project_id and returns everything without it", async () => {
    const store = createStore();
    const project = store.createProject({ title: "Scoped", workspaceId: "local" });
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_in_project", model: "sonnet", projectId: project.id });
    seedRuntimeWithUsage(store, { runtimeId: "rt_no_project", model: "opus" });

    const scoped = await (await app.request(`/api/dashboard/usage/daily?workspace_id=local&project_id=${project.id}`)).json();
    expect(scoped.map((row: any) => row.model)).toEqual(["sonnet"]);

    // "All projects" sends no project_id — tasks with and without a project both count.
    const all = await (await app.request("/api/dashboard/usage/daily?workspace_id=local")).json();
    expect(all.map((row: any) => row.model).sort()).toEqual(["opus", "sonnet"]);

    const runtimeScoped = await (await app.request(`/api/dashboard/runtime/daily?workspace_id=local&project_id=${project.id}`)).json();
    expect(runtimeScoped.reduce((total: number, row: any) => total + row.task_count, 0)).toBe(1);
  });

  it("excludes tasks outside the days window", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const seeded = seedRuntimeWithUsage(store, { runtimeId: "rt_window" });
    // Push every timestamp outside a 7-day window but inside the 365-day cap.
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db!.run(
      "UPDATE multiremi_tasks SET created_at = ?, updated_at = ?, dispatched_at = ?, started_at = ? WHERE id = ?",
      [stale, stale, stale, stale, seeded.taskId],
    );

    const daily = await (await app.request("/api/dashboard/usage/daily?workspace_id=local&days=7")).json();
    expect(daily).toEqual([]);
    const runtimeDaily = await (await app.request("/api/dashboard/runtime/daily?workspace_id=local&days=7")).json();
    expect(runtimeDaily).toEqual([]);

    // A 90-day window includes it again.
    const wide = await (await app.request("/api/dashboard/usage/daily?workspace_id=local&days=90")).json();
    expect(wide).toHaveLength(1);
  });

  it("buckets daily rows in the viewer timezone when tz is sent", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const seeded = seedRuntimeWithUsage(store, { runtimeId: "rt_tz" });
    // 2026-08-20T20:00Z is already 2026-08-21 in UTC+8 (Asia/Shanghai).
    const evening = "2026-08-20T20:00:00.000Z";
    db!.run(
      "UPDATE multiremi_tasks SET created_at = ?, updated_at = ?, dispatched_at = ?, started_at = ?, completed_at = ? WHERE id = ?",
      [evening, evening, evening, evening, evening, seeded.taskId],
    );

    const utc = await (await app.request("/api/dashboard/usage/daily?workspace_id=local&days=3650")).json();
    expect(utc[0].date).toBe("2026-08-20");

    const shanghai = await (await app.request("/api/dashboard/usage/daily?workspace_id=local&days=3650&tz=Asia/Shanghai")).json();
    expect(shanghai[0].date).toBe("2026-08-21");

    // Invalid tz falls back to UTC bucketing instead of erroring.
    const invalid = await (await app.request("/api/dashboard/usage/daily?workspace_id=local&days=3650&tz=Not/AZone")).json();
    expect(invalid[0].date).toBe("2026-08-20");
  });

  it("requires auth on dashboard endpoints while keeping / public when a token is configured", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_auth" });

    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(await root.json()).toEqual({ service: "multiremi-api", ui: "frontend/apps/web" });

    const unauthorized = await app.request("/api/dashboard/usage/daily?workspace_id=local");
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });

    const authorized = await app.request("/api/dashboard/usage/daily?workspace_id=local", {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(authorized.status).toBe(200);
    expect((await authorized.json())[0]).toMatchObject({ input_tokens: 21, task_count: 1 });
  });

  it("authenticates dashboard endpoints with a workspace access token", async () => {
    const store = createStore();
    const patToken = await store.createAccessToken({ name: "Dashboard PAT", type: "pat", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const seeded = seedRuntimeWithUsage(store, { runtimeId: "rt_pat" });

    const response = await app.request("/api/dashboard/usage/by-agent?workspace_id=local", {
      headers: { Authorization: `Bearer ${patToken.token}` },
    });
    expect(response.status).toBe(200);
    expect((await response.json())[0]).toMatchObject({ agent_id: seeded.agentId, input_tokens: 21 });
  });
});
