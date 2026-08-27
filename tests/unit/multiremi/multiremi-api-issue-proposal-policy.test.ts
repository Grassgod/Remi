import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiScheduler } from "@multiremi/scheduler.js";
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

    const delegated = await fixture.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: fixture.ordinaryHeaders,
      body: JSON.stringify({ agentId: fixture.worker.id, prompt: "ordinary delegation" }),
    });
    expect(delegated.status).toBe(201);
    const delegatedTask = (await delegated.json() as { task: { id: string } }).task;
    expect(fixture.store.getTask(delegatedTask.id)).toMatchObject({
      parentTaskId: fixture.ordinaryTask.id,
      issueCreationRestricted: false,
    });
    const delegatedCredential = await fixture.store.createTaskAccessToken(
      fixture.store.getTask(delegatedTask.id)!,
      "local",
    );
    const delegatedIssue = await fixture.app.request("/api/issues", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${delegatedCredential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Ordinary delegated child" }),
    });
    expect(delegatedIssue.status).toBe(201);
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

  it("carries the restriction through task, Session, squad, and run-only Autopilot delegation", async () => {
    const fixture = await policyFixture();

    const generic = await fixture.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: fixture.restrictedHeaders,
      body: JSON.stringify({ agentId: fixture.worker.id, prompt: "generic delegated work" }),
    });
    expect(generic.status).toBe(201);
    const genericTaskId = (await generic.json() as { task: { id: string } }).task.id;
    await expectRestrictedTaskCannotCreateIssue(fixture, genericTaskId, "generic delegation");

    const sessionId = fixture.restrictedTask.issueSessionId!;
    const session = await fixture.app.request(
      `/api/issues/${fixture.current.id}/sessions/${sessionId}/tasks`,
      {
        method: "POST",
        headers: fixture.restrictedHeaders,
        body: JSON.stringify({ agent_id: fixture.worker.id, prompt: "Session delegated work" }),
      },
    );
    expect(session.status).toBe(201);
    const sessionTaskId = (await session.json() as { id: string }).id;
    await expectRestrictedTaskCannotCreateIssue(fixture, sessionTaskId, "Session delegation");

    const squad = fixture.store.createSquad({
      name: "Policy delegation squad",
      leaderId: fixture.restricted.id,
      memberIds: [fixture.worker.id],
    });
    const squadIssue = fixture.store.createIssue({
      title: "Squad policy work",
      workspaceId: "local",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const squadSource = fixture.store.createTask({
      agentId: fixture.restricted.id,
      issueId: squadIssue.id,
      prompt: "lead squad work",
    });
    const squadCredential = await fixture.store.createTaskAccessToken(squadSource, "local");
    const squadComment = await fixture.app.request(`/api/issues/${squadIssue.id}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${squadCredential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: `Please help [@${fixture.worker.name}](mention://agent/${fixture.worker.id})`,
      }),
    });
    expect(squadComment.status).toBe(201);
    const squadTask = fixture.store.listTasksForIssue(squadIssue.id)
      .find((task) => task.parentTaskId === squadSource.id && task.agentId === fixture.worker.id);
    expect(squadTask).toBeDefined();
    await expectRestrictedTaskCannotCreateIssue(fixture, squadTask!.id, "squad mention delegation");

    const runOnlyAutopilot = fixture.store.createAutopilot({
      title: "Delegated run-only autopilot",
      assigneeId: fixture.worker.id,
      executionMode: "run_only",
      triggerKind: "api",
    });
    const autopilot = await fixture.app.request(`/api/multiremi/autopilots/${runOnlyAutopilot.id}/run`, {
      method: "POST",
      headers: fixture.restrictedHeaders,
      body: "{}",
    });
    expect(autopilot.status).toBe(201);
    const autopilotRun = (await autopilot.json() as { run: { id: string; taskId: string } }).run;
    expect((fixture.store as any).db.query(
      "SELECT source_task_id FROM multiremi_autopilot_runs WHERE id = ?",
    ).get(autopilotRun.id)).toEqual({ source_task_id: fixture.restrictedTask.id });
    const autopilotTaskId = autopilotRun.taskId;
    await expectRestrictedTaskCannotCreateIssue(fixture, autopilotTaskId, "run-only Autopilot delegation");
  });

  it("forces every task-accessible Agent creation path to inherit the restriction", async () => {
    const fixture = await policyFixture();
    const cases = [
      ["compat", "/api/agents", { name: "Inherited compat agent", provider: "codex" }],
      ["native", "/api/multiremi/agents", { name: "Inherited native agent", provider: "codex" }],
      ["compat template", "/api/agents/from-template", {
        name: "Inherited compat template agent",
        template_slug: "commit-message",
        provider: "codex",
      }],
      ["native template", "/api/multiremi/agents/from-template", {
        name: "Inherited native template agent",
        templateSlug: "commit-message",
        provider: "codex",
      }],
      ["default", "/api/multiremi/agents/default", { provider: "claude" }],
    ] as const;

    for (const [label, path, body] of cases) {
      const response = await fixture.app.request(path, {
        method: "POST",
        headers: fixture.restrictedHeaders,
        body: JSON.stringify(body),
      });
      expect([200, 201], `${label}: ${await response.clone().text()}`).toContain(response.status);
      const payload = await response.json() as Record<string, any>;
      const rawAgent = payload.agent ?? payload;
      const agentId = String(rawAgent.id);
      expect(fixture.store.getAgent(agentId)?.issueCreationRequiresProposal, label).toBe(true);

      const delegated = await fixture.app.request("/api/multiremi/tasks", {
        method: "POST",
        headers: fixture.restrictedHeaders,
        body: JSON.stringify({ agentId, prompt: `${label} delegated work` }),
      });
      expect(delegated.status, label).toBe(201);
      const taskId = (await delegated.json() as { task: { id: string } }).task.id;
      await expectRestrictedTaskCannotCreateIssue(fixture, taskId, `${label} Agent delegation`);
    }
  });

  it("persists a restricted task's taint on schedule triggers and blocks future background Issue creation", async () => {
    const fixture = await policyFixture();
    const autopilot = fixture.store.createAutopilot({
      title: "Future scheduled delegation",
      assigneeId: fixture.worker.id,
      executionMode: "run_only",
      triggerKind: "schedule",
    });
    const createTrigger = await fixture.app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: fixture.restrictedHeaders,
      body: JSON.stringify({ kind: "schedule", cron_expression: "0 * * * *" }),
    });
    expect(createTrigger.status).toBe(201);
    const taskView = await createTrigger.json() as Record<string, unknown>;
    expect(taskView).not.toHaveProperty("issue_creation_restricted");

    const storedAutopilot = fixture.store.getAutopilot(autopilot.id)!;
    const trigger = fixture.store.listAutopilotTriggers(autopilot.id)[0]!;
    expect(storedAutopilot).toMatchObject({
      issueCreationRestricted: true,
      issueCreationRestrictionReason: "restricted_task",
      issueCreationRestrictedByTaskId: fixture.restrictedTask.id,
    });
    expect(trigger).toMatchObject({
      issueCreationRestricted: true,
      issueCreationRestrictionReason: "restricted_task",
      issueCreationRestrictedByTaskId: fixture.restrictedTask.id,
    });

    const scheduler = new MultiremiScheduler({ store: fixture.store, pollIntervalMs: 60_000 });
    const runs = scheduler.tickDueTriggers(new Date(Date.parse(trigger.nextRunAt!) + 1_000));
    expect(runs).toHaveLength(1);
    expect(fixture.store.getTask(runs[0]!.taskId!)?.issueCreationRestricted).toBe(true);
    await expectRestrictedTaskCannotCreateIssue(
      fixture,
      runs[0]!.taskId!,
      "persisted schedule trigger",
      false,
    );
  });

  it("persists system-event taint independently of the later event caller", async () => {
    const fixture = await policyFixture();
    const project = fixture.store.createProject({ title: "Approval policy project" });
    const triggerIssue = fixture.store.createIssue({
      title: "Later human event",
      workspaceId: "local",
      projectId: project.id,
      status: "todo",
    });
    const autopilot = fixture.store.createAutopilot({
      title: "Future system event",
      assigneeId: fixture.worker.id,
      executionMode: "trigger_issue",
      projectId: project.id,
    });
    const configured = await fixture.app.request(`/api/autopilots/${autopilot.id}/triggers`, {
      method: "POST",
      headers: fixture.restrictedHeaders,
      body: JSON.stringify({
        kind: "system_event",
        event_config: {
          resource: "issue",
          event: "status_changed",
          conditions: [{ field: "status", operator: "becomes", value: "done" }],
          project_id: project.id,
        },
      }),
    });
    expect(configured.status).toBe(201);

    const changed = await fixture.app.request(`/api/issues/${triggerIssue.id}`, {
      method: "PATCH",
      headers: fixture.humanHeaders,
      body: JSON.stringify({ status: "done" }),
    });
    expect(changed.status).toBe(200);
    const [run] = fixture.store.dispatchPendingSystemEvents();
    expect(run).toBeDefined();
    expect(fixture.store.getTask(run!.taskId!)?.issueCreationRestricted).toBe(true);
    await expectRestrictedTaskCannotCreateIssue(
      fixture,
      run!.taskId!,
      "persisted system-event trigger",
      false,
    );
  });

  it("uses trusted event and webhook-delivery source tasks as a second inheritance path", async () => {
    const fixture = await policyFixture();
    const project = fixture.store.createProject({ title: "Source lineage project" });
    const eventIssue = fixture.store.createIssue({
      title: "Restricted source event",
      workspaceId: "local",
      projectId: project.id,
      status: "todo",
    });
    const eventAutopilot = fixture.store.createAutopilot({
      title: "Clean system-event automation",
      assigneeId: fixture.worker.id,
      executionMode: "trigger_issue",
      projectId: project.id,
    });
    fixture.store.createAutopilotTrigger(eventAutopilot.id, {
      kind: "system_event",
      eventConfig: {
        resource: "issue",
        event: "status_changed",
        conditions: [{ field: "status", operator: "becomes", value: "done" }],
        projectId: project.id,
      },
    });
    const changed = await fixture.app.request(`/api/issues/${eventIssue.id}`, {
      method: "PATCH",
      headers: fixture.restrictedHeaders,
      body: JSON.stringify({ status: "done" }),
    });
    expect(changed.status).toBe(200);
    const [eventRun] = fixture.store.dispatchPendingSystemEvents();
    expect(eventRun).toBeDefined();
    await expectRestrictedTaskCannotCreateIssue(
      fixture,
      eventRun!.taskId!,
      "system-event source task",
    );

    const webhookAutopilot = fixture.store.createAutopilot({
      title: "Clean webhook automation",
      assigneeId: fixture.worker.id,
      executionMode: "run_only",
      triggerKind: "webhook",
    });
    fixture.store.createAutopilotTrigger(webhookAutopilot.id, { kind: "webhook" });
    const firstDelivery = await fixture.app.request(`/api/multiremi/autopilots/${webhookAutopilot.id}/webhook`, {
      method: "POST",
      headers: fixture.restrictedHeaders,
      body: JSON.stringify({ payload: { event: "source-lineage" } }),
    });
    expect(firstDelivery.status).toBe(201);
    const storedDelivery = fixture.store.listWebhookDeliveries(webhookAutopilot.id)[0]!;
    const replay = await fixture.app.request(
      `/api/autopilots/${webhookAutopilot.id}/deliveries/${storedDelivery.id}/replay`,
      { method: "POST", headers: fixture.humanHeaders },
    );
    expect(replay.status).toBe(201);
    const replayDelivery = fixture.store.listWebhookDeliveries(webhookAutopilot.id)
      .find((delivery) => delivery.replayedFromDeliveryId === storedDelivery.id)!;
    expect(replayDelivery).toBeDefined();
    await expectRestrictedTaskCannotCreateIssue(
      fixture,
      replayDelivery.autopilotRunId
        ? fixture.store.getAutopilotRun(replayDelivery.autopilotRunId)!.taskId!
        : "missing",
      "webhook delivery replay lineage",
    );
  });

  it("makes taint human-visible and clearable while keeping it hidden and immutable for tasks", async () => {
    const fixture = await policyFixture();
    const autopilot = fixture.store.createAutopilot({
      title: "Shared Wiki-like automation",
      assigneeId: fixture.worker.id,
      executionMode: "run_only",
      triggerKind: "schedule",
    });
    const trigger = fixture.store.createAutopilotTrigger(autopilot.id, {
      kind: "schedule",
      cronExpression: "0 * * * *",
    });
    const tainted = await fixture.app.request(`/api/autopilots/${autopilot.id}`, {
      method: "PATCH",
      headers: fixture.restrictedHeaders,
      body: JSON.stringify({ title: "Touched by restricted task" }),
    });
    expect(tainted.status).toBe(200);
    expect(await tainted.json()).not.toHaveProperty("issue_creation_restricted");
    expect(fixture.store.getAutopilot(autopilot.id)?.issueCreationRestricted).toBe(true);

    for (const [path, body] of [
      [`/api/autopilots/${autopilot.id}`, { issue_creation_restricted: false }],
      [`/api/autopilots/${autopilot.id}/triggers/${trigger.id}`, { issue_creation_restricted: false }],
    ] as const) {
      const denied = await fixture.app.request(path, {
        method: "PATCH",
        headers: fixture.restrictedHeaders,
        body: JSON.stringify(body),
      });
      expect(denied.status, path).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "human_autopilot_policy_required" });
    }

    const humanView = await fixture.app.request(`/api/autopilots/${autopilot.id}`, {
      headers: fixture.humanHeaders,
    });
    expect(humanView.status).toBe(200);
    expect((await humanView.json() as { autopilot: Record<string, unknown> }).autopilot).toMatchObject({
      issue_creation_restricted: true,
      issue_creation_restriction_reason: "restricted_task",
      issue_creation_restricted_by_task_id: fixture.restrictedTask.id,
    });

    const beforeClearRun = fixture.store.runAutopilot(autopilot.id, { source: "schedule" });
    await expectRestrictedTaskCannotCreateIssue(
      fixture,
      beforeClearRun.taskId!,
      "human-triggered tainted automation",
      false,
    );

    const cleared = await fixture.app.request(`/api/autopilots/${autopilot.id}`, {
      method: "PATCH",
      headers: fixture.humanHeaders,
      body: JSON.stringify({ issue_creation_restricted: false }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ issue_creation_restricted: false });
    expect(fixture.store.getAutopilot(autopilot.id)).toMatchObject({
      issueCreationRestricted: false,
      issueCreationRestrictionReason: null,
      issueCreationRestrictedByTaskId: null,
    });
    expect(fixture.store.getAutopilotTrigger(trigger.id)).toMatchObject({
      issueCreationRestricted: false,
      issueCreationRestrictionReason: null,
      issueCreationRestrictedByTaskId: null,
    });

    const afterClearRun = fixture.store.runAutopilot(autopilot.id, { source: "schedule" });
    const afterClearTask = fixture.store.getTask(afterClearRun.taskId!)!;
    expect(afterClearTask.issueCreationRestricted).toBe(false);
    const credential = await fixture.store.createTaskAccessToken(afterClearTask, "local");
    const created = await fixture.app.request("/api/issues", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Allowed after human clear" }),
    });
    expect(created.status).toBe(201);
  });

  it("keeps task snapshots restricted while applying live Agent policy to legacy ordinary tasks", async () => {
    const fixture = await policyFixture();
    fixture.store.updateAgent(fixture.restricted.id, { issueCreationRequiresProposal: false });
    await expectRestrictedTaskCannotCreateIssue(
      fixture,
      fixture.restrictedTask.id,
      "persisted restricted task snapshot",
      false,
    );

    fixture.store.updateAgent(fixture.ordinary.id, { issueCreationRequiresProposal: true });
    await expectRestrictedTaskCannotCreateIssue(
      fixture,
      fixture.ordinaryTask.id,
      "live ordinary Agent restriction",
      false,
      false,
    );
    fixture.store.updateAgent(fixture.ordinary.id, { issueCreationRequiresProposal: false });
    const ordinaryCredential = await fixture.store.createTaskAccessToken(fixture.ordinaryTask, "local");
    const restored = await fixture.app.request("/api/issues", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ordinaryCredential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Restored ordinary task" }),
    });
    expect(restored.status).toBe(201);
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
    restrictedTask,
    ordinaryTask,
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

async function expectRestrictedTaskCannotCreateIssue(
  fixture: Awaited<ReturnType<typeof policyFixture>>,
  taskId: string,
  label: string,
  expectParent = true,
  expectSnapshot = true,
): Promise<void> {
  const task = fixture.store.getTask(taskId)!;
  expect(task.issueCreationRestricted, label).toBe(expectSnapshot);
  if (expectParent) expect(task.parentTaskId, label).toBeString();
  const credential = await fixture.store.createTaskAccessToken(task, "local");
  const before = fixture.store.listIssues({ workspaceId: "local" }).length;
  const response = await fixture.app.request("/api/issues", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: `${label} bypass` }),
  });
  expect(response.status, label).toBe(403);
  expect(await response.json(), label).toMatchObject({ code: "issue_creation_requires_proposal" });
  expect(fixture.store.listIssues({ workspaceId: "local" }), label).toHaveLength(before);
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
