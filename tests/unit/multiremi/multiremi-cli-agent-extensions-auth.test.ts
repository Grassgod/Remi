import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("agent extension CLI authorization boundaries", () => {
  it("returns only safe Agent directory fields to Task tokens", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const taskAgent = store.createAgent({ name: "Task actor", provider: "codex", workspaceId: "local" });
    const privateValues = {
      instructions: "private-instruction-value",
      env: "private-environment-value",
      arg: "private-argument-value",
      mcp: "private-mcp-value",
    };
    const directoryAgent = store.createAgent({
      name: "Visible directory agent",
      provider: "claude",
      workspaceId: "local",
      visibility: "workspace",
      instructions: privateValues.instructions,
      customEnv: { SERVICE_TOKEN: privateValues.env },
      customArgs: [privateValues.arg],
      mcpConfig: { authorization: privateValues.mcp },
    });
    const issue = store.createIssue({ title: "Task credential", workspaceId: "local" });
    const task = store.createTask({ agentId: taskAgent.id, issueId: issue.id, workspaceId: "local", prompt: "Inspect directory" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: `Bearer ${taskToken.token}` };

    for (const path of [
      "/api/agents?workspace_id=local",
      "/api/multiremi/agents?workspaceId=local",
      `/api/agents/${directoryAgent.id}`,
      `/api/multiremi/agents/${directoryAgent.id}`,
    ]) {
      const response = await app.request(path, { headers });
      expect(response.status, path).toBe(200);
      const serialized = await response.text();
      expect(serialized).toContain("Visible directory agent");
      expect(serialized.toLowerCase()).not.toMatch(/token|password|secret|key|authorization/);
      for (const value of Object.values(privateValues)) expect(serialized).not.toContain(value);
    }

    const human = await app.request(`/api/agents/${directoryAgent.id}`, {
      headers: { Authorization: "Bearer root-secret" },
    });
    expect(human.status).toBe(200);
    expect(await human.text()).toContain(privateValues.instructions);
  });

  it("keeps Task collaboration reads but rejects management and private child surfaces", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Task actor", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({ title: "Task credential", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "Authenticate" });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const squad = store.createSquad({ name: "Readable squad", workspaceId: "local", leaderId: agent.id });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const headers = { Authorization: `Bearer ${taskToken.token}`, "Content-Type": "application/json" };

    expect((await app.request("/api/squads?workspace_id=local", { headers })).status).toBe(200);
    expect((await app.request(`/api/squads/${squad.id}`, { headers })).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/api/agents", { name: "Denied", provider: "codex", workspace_id: "local" }],
      ["GET", `/api/agents/${agent.id}/env`, undefined],
      ["GET", `/api/agents/${agent.id}/skills`, undefined],
      ["GET", `/api/agents/${agent.id}/tasks`, undefined],
      ["GET", `/api/multiremi/agents/${agent.id}/plugins`, undefined],
      ["GET", "/api/agent-templates", undefined],
      ["POST", "/api/squads", { name: "Denied squad", leader_id: agent.id, workspace_id: "local" }],
      ["PUT", `/api/squads/${squad.id}`, { name: "Denied update" }],
      ["POST", `/api/squads/${squad.id}/members`, { member_type: "agent", member_id: agent.id }],
      ["POST", "/api/skills", { name: "Denied skill", workspace_id: "local", content: "# Skill" }],
      ["GET", "/api/multiremi/agent-plugins?workspace_id=local", undefined],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("rejects Daemon, Share, and anonymous credentials on the Agent directory", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const daemon = await store.createAccessToken({
      name: "CLI extension daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "dmn_cli_extension",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const credentials: HeadersInit[] = [
      { Authorization: `Bearer ${daemon.token}` },
      { "X-Remi-Share": "invalid-share-credential" },
      {},
    ];
    for (const headers of credentials) {
      const response = await app.request("/api/agents?workspace_id=local", { headers });
      expect([401, 403]).toContain(response.status);
    }
  });
});
