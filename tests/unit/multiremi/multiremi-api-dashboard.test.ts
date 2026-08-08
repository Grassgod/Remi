// The JSON data endpoints the Next.js frontend reads (D11 removed the
// server-rendered HTML dashboard; only this contract survived).
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — dashboard JSON endpoints", () => {
  // D11 removed the server-rendered HTML dashboard (src/multiremi/dashboard.ts) and its
  // 8 HTML-string assertions. The data endpoints survived in api.ts; these tests lock the
  // surviving JSON contract that the Next.js frontend now consumes.

  function seedRuntimeWithUsage(store: MultiremiStore, options: {
    runtimeId: string;
    workspaceId?: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  }): { agentId: string; runtimeId: string; taskId: string } {
    const workspaceId = options.workspaceId ?? "local";
    const provider = options.provider ?? "claude";
    store.registerRuntime({ id: options.runtimeId, name: `Runtime ${options.runtimeId}`, provider, workspaceId });
    const agent = store.createAgent({ name: `Agent ${options.runtimeId}`, provider, workspaceId });
    const task = store.createTask({ agentId: agent.id, workspaceId, prompt: "seed usage" });
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

  it("serves /api/dashboard/usage/daily matching store.listUsageDaily", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_daily", inputTokens: 21, outputTokens: 8 });

    const response = await app.request("/api/dashboard/usage/daily?workspace_id=local");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual(store.listUsageDaily({ workspaceId: "local" }));
    expect(body[0]).toMatchObject({
      runtimeId: "rt_daily",
      provider: "claude",
      model: "sonnet",
      inputTokens: 21,
      outputTokens: 8,
      taskCount: 1,
    });
  });

  it("serves /api/dashboard/usage/by-agent matching store.listUsageByAgent", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const seeded = seedRuntimeWithUsage(store, { runtimeId: "rt_by_agent", inputTokens: 13, outputTokens: 4 });

    const response = await app.request("/api/dashboard/usage/by-agent?workspace_id=local");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(store.listUsageByAgent({ workspaceId: "local" }));
    expect(body[0]).toMatchObject({
      agentId: seeded.agentId,
      model: "sonnet",
      inputTokens: 13,
      outputTokens: 4,
      taskCount: 1,
    });
  });

  it("serves /api/dashboard/runtime/daily matching store.listRuntimeDaily with failed counts", async () => {
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
    expect(body).toEqual(store.listRuntimeDaily({ workspaceId: "local" }));
    expect(body[0]).toMatchObject({ taskCount: 2, failedCount: 1 });
  });

  it("serves /api/dashboard/agent-runtime as the listRuntimeDaily alias of runtime/daily", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_alias" });

    const agentRuntime = await app.request("/api/dashboard/agent-runtime?workspace_id=local");
    expect(agentRuntime.status).toBe(200);
    const agentRuntimeBody = await agentRuntime.json();
    expect(agentRuntimeBody).toEqual(store.listRuntimeDaily({ workspaceId: "local" }));

    const runtimeDaily = await app.request("/api/dashboard/runtime/daily?workspace_id=local");
    expect(agentRuntimeBody).toEqual(await runtimeDaily.json());
  });

  it("isolates dashboard usage by workspace_id", async () => {
    const store = createStore();
    store.createWorkspace({ id: "ws_other", name: "Other", slug: "other" });
    const app = createMultiremiApp({ store });
    seedRuntimeWithUsage(store, { runtimeId: "rt_local_ws", workspaceId: "local", model: "sonnet" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_other_ws", workspaceId: "ws_other", model: "opus" });

    const localBody = await (await app.request("/api/dashboard/usage/daily?workspace_id=local")).json();
    expect(localBody).toEqual(store.listUsageDaily({ workspaceId: "local" }));
    expect(localBody.map((row: any) => row.model)).toEqual(["sonnet"]);

    const otherBody = await (await app.request("/api/dashboard/usage/daily?workspace_id=ws_other")).json();
    expect(otherBody).toEqual(store.listUsageDaily({ workspaceId: "ws_other" }));
    expect(otherBody.map((row: any) => row.model)).toEqual(["opus"]);
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
    expect(await authorized.json()).toEqual(store.listUsageDaily({ workspaceId: "local" }));
  });

  it("authenticates dashboard endpoints with a workspace access token", async () => {
    const store = createStore();
    const patToken = await store.createAccessToken({ name: "Dashboard PAT", type: "pat", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    seedRuntimeWithUsage(store, { runtimeId: "rt_pat" });

    const response = await app.request("/api/dashboard/usage/by-agent?workspace_id=local", {
      headers: { Authorization: `Bearer ${patToken.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(store.listUsageByAgent({ workspaceId: "local" }));
  });
});
