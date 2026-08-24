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

  it("keeps task credentials on collaboration analytics and out of operations management", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Task actor", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({ title: "Operations auth", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Auth" });
    const token = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-operations-secret" });
    const headers = { Authorization: `Bearer ${token.token}` };

    expect((await app.request("/api/inbox", { headers })).status).toBe(200);
    expect((await app.request("/api/dashboard/usage/daily?workspace_id=local", { headers })).status).toBe(200);
    for (const path of [
      "/api/runtimes",
      "/api/autopilots",
      "/api/cloud-runtime",
      "/api/cloud-billing/balance",
      "/api/multiremi/platform/status",
      "/api/lark/binding/redeem",
    ]) {
      const response = await app.request(path, { headers });
      expect(response.status, path).toBe(403);
    }
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
