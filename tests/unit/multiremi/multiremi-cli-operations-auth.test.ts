import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("operations CLI authorization boundaries", () => {
  it("lets a daemon read only runtimes bound to its exact machine identity", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const own = store.registerRuntime({ id: "rt_ops_own", name: "Own runtime", provider: "codex", workspaceId: "local", daemonId: "dmn_ops" });
    const other = store.registerRuntime({ id: "rt_ops_other", name: "Other runtime", provider: "claude", workspaceId: "local", daemonId: "dmn_other" });
    const daemon = await store.createAccessToken({ name: "Operations daemon", type: "daemon", workspaceId: "local", daemonId: "dmn_ops" });
    const app = createMultiremiApp({ store, authToken: "root-operations-secret" });
    const headers = { Authorization: `Bearer ${daemon.token}` };

    const list = await app.request("/api/runtimes", { headers });
    expect(list.status).toBe(200);
    const rows = await list.json() as Array<{ id: string }>;
    expect(rows.map((runtime) => runtime.id)).toEqual([own.id]);
    expect((await app.request(`/api/runtimes/${own.id}`, { headers })).status).toBe(200);
    expect((await app.request(`/api/runtimes/${other.id}`, { headers })).status).toBe(403);
    expect((await app.request("/api/autopilots", { headers })).status).toBe(403);
    expect((await app.request("/api/cloud-billing/balance", { headers })).status).toBe(403);
  });

  it("gives task credentials workspace and platform-read parity while keeping control-plane mutations denied", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Task actor", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({ title: "Operations auth", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Auth" });
    const token = await store.createTaskAccessToken(task, "local");
    const runtime = store.registerRuntime({ id: "rt_task_ops", name: "Task runtime", provider: "codex", workspaceId: "local" });
    const autopilot = store.createAutopilot({
      title: "Task-managed autopilot",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
      executionMode: "run_only",
    });
    const webhookTrigger = store.createAutopilotTrigger(autopilot.id, { kind: "webhook" });
    const app = createMultiremiApp({ store, authToken: "root-operations-secret" });
    const headers = { Authorization: `Bearer ${token.token}` };

    expect((await app.request("/api/inbox", { headers })).status).toBe(200);
    expect((await app.request("/api/dashboard/usage/daily?workspace_id=local", { headers })).status).toBe(200);
    expect((await app.request("/api/runtimes", { headers })).status).toBe(200);
    expect((await app.request(`/api/runtimes/${runtime.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated by task" }),
    })).status).toBe(200);
    expect((await app.request("/api/autopilots", { headers })).status).toBe(200);
    const autopilotRead = await app.request(`/api/autopilots/${autopilot.id}`, { headers });
    expect(autopilotRead.status).toBe(200);
    expect((await autopilotRead.json()).triggers).toEqual([
      expect.objectContaining({
        id: webhookTrigger.id,
        webhook_token: null,
        webhook_path: null,
        webhook_url: null,
        signing_secret_hint: null,
      }),
    ]);
    expect((await app.request(`/api/autopilots/${autopilot.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ description: "Updated by task" }),
    })).status).toBe(200);
    expect((await app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "schedule", cron_expression: "0 9 * * *" }),
    })).status).toBe(201);
    expect((await app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "webhook" }),
    })).status).toBe(403);
    expect((await app.request(`/api/autopilots/${autopilot.id}/triggers/${webhookTrigger.id}/rotate-webhook-token`, {
      method: "POST",
      headers,
    })).status).toBe(403);
    expect((await app.request("/api/multiremi/platform/status", { headers })).status).toBe(200);
    expect((await app.request("/api/multiremi/platform/operations", { headers })).status).toBe(200);

    for (const [method, path, body] of [
      ["GET", "/api/cloud-runtime", undefined],
      ["GET", "/api/cloud-billing/balance", undefined],
      ["POST", "/api/multiremi/platform/operations", { kind: "check_updates" }],
      ["GET", "/api/lark/binding/redeem", undefined],
      ["POST", "/api/workspaces/local/lark/install/begin", {}],
      ["DELETE", "/api/workspaces/local/lark/installations/lin_1", undefined],
      ["POST", "/api/multiremi/runtimes", { name: "Forged runtime", provider: "codex" }],
      ["POST", `/api/multiremi/runtimes/${runtime.id}/heartbeat`, {}],
      ["POST", "/api/daemon/register", { workspace_id: "local", daemon_id: "forged", runtimes: [{ type: "codex" }] }],
      ["POST", `/api/runtimes/${runtime.id}/update`, {}],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: { ...headers, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await response.json()).code, `${method} ${path}`).toBe("task_token_hard_denied");
    }

    expect((await app.request("/api/daemon/heartbeat", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_id: runtime.id }),
    })).status).toBe(403);
  });

  it("keeps SCM, billing, and Lark responses free of configured secret values", async () => {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
    process.env.MULTIREMI_LARK_APP_SECRET = "lark-app-secret-never-return";
    process.env.STRIPE_SECRET_KEY = "stripe-secret-never-return";
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createScmConnection({
      workspaceId: "local",
      name: "Secret-safe GitHub",
      provider: "github",
      mode: "poll",
      accessToken: "scm-token-never-return",
      webhookSecret: "scm-webhook-never-return",
    });
    const app = createMultiremiApp({ store, authToken: "root-operations-secret" });
    const headers = { Authorization: "Bearer root-operations-secret" };
    const secretValues = [
      "scm-token-never-return",
      "scm-webhook-never-return",
      "lark-app-secret-never-return",
      "stripe-secret-never-return",
    ];

    for (const path of [
      "/api/workspaces/local/scm/connections",
      "/api/cloud-billing/balance",
      "/api/workspaces/local/lark/installations",
    ]) {
      const response = await app.request(path, { headers });
      expect(response.status, path).toBe(200);
      const serialized = await response.text();
      for (const secret of secretValues) expect(serialized, path).not.toContain(secret);
    }
  });
});
