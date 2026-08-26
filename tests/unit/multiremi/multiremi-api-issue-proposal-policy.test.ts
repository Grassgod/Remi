import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("agent Issue proposal policy", () => {
  it("blocks every direct Issue-create route for restricted tasks without changing ordinary task collaboration", async () => {
    const fixture = await policyFixture();
    const before = fixture.store.listIssues({ workspaceId: "local" }).length;
    const requests = [
      ["/api/issues", { title: "compat bypass" }],
      ["/api/multiremi/issues", { title: "native bypass", workspaceId: "local" }],
      ["/api/issues/quick-create", { agent_id: fixture.worker.id, prompt: "compat quick bypass" }],
      ["/api/multiremi/issues/quick-create", { agentId: fixture.worker.id, prompt: "native quick bypass" }],
    ] as const;

    for (const [path, body] of requests) {
      const response = await fixture.app.request(path, {
        method: "POST",
        headers: fixture.restrictedHeaders,
        body: JSON.stringify(body),
      });
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toMatchObject({ code: "issue_creation_requires_proposal" });
    }
    expect(fixture.store.listIssues({ workspaceId: "local" })).toHaveLength(before);

    const ordinary = await fixture.app.request("/api/issues", {
      method: "POST",
      headers: fixture.ordinaryHeaders,
      body: JSON.stringify({ title: "Delegated child remains supported", parent_issue_id: fixture.current.id }),
    });
    expect(ordinary.status).toBe(201);
    expect((await ordinary.json()).title).toBe("Delegated child remains supported");
  });

  it("makes the policy human-managed and projects caller-specific CLI capabilities", async () => {
    const fixture = await policyFixture();
    for (const [method, path, body] of [
      ["PATCH", `/api/multiremi/agents/${fixture.restricted.id}`, { issueCreationRequiresProposal: false }],
      ["PUT", `/api/agents/${fixture.restricted.id}`, { issue_creation_requires_proposal: false }],
      ["PUT", `/api/agents/${fixture.worker.id}`, { issue_creation_requires_proposal: true }],
      ["POST", "/api/agents", { name: "Policy escape", provider: "codex", issue_creation_requires_proposal: false }],
    ] as const) {
      const response = await fixture.app.request(path, {
        method,
        headers: fixture.restrictedHeaders,
        body: JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: "human_agent_policy_required" });
    }
    expect(fixture.store.getAgent(fixture.restricted.id)?.issueCreationRequiresProposal).toBe(true);
    expect(fixture.store.getAgent(fixture.worker.id)?.issueCreationRequiresProposal).toBe(false);

    const restrictedCapabilities = await capabilityMap(fixture.app, fixture.restrictedHeaders);
    const ordinaryCapabilities = await capabilityMap(fixture.app, fixture.ordinaryHeaders);
    expect(restrictedCapabilities.get("issue.create")).toBe(false);
    expect(restrictedCapabilities.get("issue.quick-create")).toBe(false);
    expect(restrictedCapabilities.get("feishu.messages.propose-issue")).toBe(true);
    expect(ordinaryCapabilities.get("issue.create")).toBe(true);
    expect(ordinaryCapabilities.get("issue.quick-create")).toBe(true);

    const human = await fixture.app.request(`/api/agents/${fixture.restricted.id}`, {
      method: "PUT",
      headers: fixture.humanHeaders,
      body: JSON.stringify({ issue_creation_requires_proposal: false }),
    });
    expect(human.status).toBe(200);
    expect((await human.json()).issue_creation_requires_proposal).toBe(false);
  });

  it("prevents restricted tasks from configuring or firing create_issue Autopilots", async () => {
    const fixture = await policyFixture();
    const createIssueAutopilot = fixture.store.createAutopilot({
      title: "Human-created Issue autopilot",
      assigneeId: fixture.worker.id,
      executionMode: "create_issue",
      triggerKind: "api",
    });
    const runOnlyAutopilot = fixture.store.createAutopilot({
      title: "Run-only autopilot",
      assigneeId: fixture.worker.id,
      executionMode: "run_only",
      triggerKind: "api",
    });
    const deniedRequests = [
      ["POST", "/api/autopilots", { title: "compat create", assignee_id: fixture.worker.id, execution_mode: "create_issue" }],
      ["POST", "/api/multiremi/autopilots", { title: "native create", assigneeId: fixture.worker.id, executionMode: "create_issue" }],
      ["PATCH", `/api/autopilots/${runOnlyAutopilot.id}`, { execution_mode: "create_issue" }],
      ["PATCH", `/api/multiremi/autopilots/${runOnlyAutopilot.id}`, { executionMode: "create_issue" }],
      ["POST", `/api/autopilots/${createIssueAutopilot.id}/trigger`, {}],
      ["POST", `/api/multiremi/autopilots/${createIssueAutopilot.id}/trigger`, {}],
      ["POST", `/api/multiremi/autopilots/${createIssueAutopilot.id}/run`, {}],
      ["POST", `/api/multiremi/autopilots/${createIssueAutopilot.id}/run-scheduled`, {}],
      ["POST", `/api/multiremi/autopilots/${createIssueAutopilot.id}/webhook`, {}],
      ["POST", `/api/autopilots/${createIssueAutopilot.id}/deliveries/missing/replay`, {}],
      ["POST", `/api/multiremi/autopilots/${createIssueAutopilot.id}/deliveries/missing/replay`, {}],
      ["POST", `/api/autopilots/${createIssueAutopilot.id}/triggers`, { kind: "api" }],
      ["PATCH", `/api/autopilots/${createIssueAutopilot.id}/triggers/missing`, { enabled: true }],
    ] as const;

    for (const [method, path, body] of deniedRequests) {
      const response = await fixture.app.request(path, {
        method,
        headers: fixture.restrictedHeaders,
        body: JSON.stringify(body),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json(), path).toMatchObject({ code: "issue_creation_requires_proposal" });
    }

    const runOnly = await fixture.app.request(`/api/multiremi/autopilots/${runOnlyAutopilot.id}/run`, {
      method: "POST",
      headers: fixture.restrictedHeaders,
      body: "{}",
    });
    expect(runOnly.status).toBe(201);
    expect((await runOnly.json()).run.issueId).toBeNull();
  });
});

async function policyFixture() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const restricted = store.createAgent({
    name: "Feishu watcher",
    provider: "codex",
    issueCreationRequiresProposal: true,
  });
  const ordinary = store.createAgent({ name: "Ordinary collaborator", provider: "codex" });
  const worker = store.createAgent({ name: "Quick-create worker", provider: "codex" });
  const current = store.createIssue({ title: "Current work", workspaceId: "local" });
  const restrictedTask = store.createTask({ agentId: restricted.id, issueId: current.id, prompt: "watch Feishu" });
  const ordinaryTask = store.createTask({ agentId: ordinary.id, issueId: current.id, prompt: "collaborate" });
  const restrictedCredential = await store.createTaskAccessToken(restrictedTask, "local");
  const ordinaryCredential = await store.createTaskAccessToken(ordinaryTask, "local");
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  return {
    app,
    store,
    restricted,
    ordinary,
    worker,
    current,
    restrictedHeaders: {
      Authorization: `Bearer ${restrictedCredential.token}`,
      "Content-Type": "application/json",
    },
    ordinaryHeaders: {
      Authorization: `Bearer ${ordinaryCredential.token}`,
      "Content-Type": "application/json",
    },
    humanHeaders: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
  };
}

async function capabilityMap(
  app: ReturnType<typeof createMultiremiApp>,
  headers: Record<string, string>,
): Promise<Map<string, boolean>> {
  const response = await app.request("/api/cli/capabilities", { headers });
  expect(response.status).toBe(200);
  const body = await response.json() as { commands: Array<{ id: string; allowed: boolean }> };
  return new Map(body.commands.map((command) => [command.id, command.allowed]));
}
