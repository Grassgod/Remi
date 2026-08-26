import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

async function setup() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const owner = store.createWorkspaceMember({
    id: "mem_owner",
    workspaceId: "local",
    userId: "owner",
    name: "Owner",
    role: "owner",
  });
  const member = store.createWorkspaceMember({
    id: "mem_member",
    workspaceId: "local",
    userId: "member",
    name: "Member",
    role: "member",
  });
  const ownerToken = await store.createAccessToken({
    name: "Owner",
    type: "pat",
    workspaceId: "local",
    userId: "owner",
  });
  const memberToken = await store.createAccessToken({
    name: "Member",
    type: "pat",
    workspaceId: "local",
    userId: "member",
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });
  const runtime = store.registerRuntime({
    id: "rt_organizer_test",
    name: "Organizer test runtime",
    provider: "codex",
    workspaceId: "local",
  });
  const supervisorAgent = store.createAgent({
    name: "Organizer",
    provider: "codex",
    workspaceId: "local",
    ownerId: "owner",
  });
  const targetAgent = store.createAgent({
    name: "Worker",
    provider: "codex",
    workspaceId: "local",
    ownerId: "owner",
  });
  const targetIssue = store.createIssue({ title: "Target issue", workspaceId: "local" });
  const patrolIssue = store.createIssue({ title: "Organizer patrol", workspaceId: "local" });
  store.addIssueSubscriber(patrolIssue.id, owner.id);
  const supervisorTask = store.createTask({
    agentId: supervisorAgent.id,
    issueId: patrolIssue.id,
    workspaceId: "local",
    prompt: "inspect tasks",
  });
  const targetTask = store.createTask({
    agentId: targetAgent.id,
    runtimeId: runtime.id,
    issueId: targetIssue.id,
    workspaceId: "local",
    prompt: "TOP SECRET target prompt",
  });
  store.appendTaskMessages(targetTask.id, [
    {
      type: "tool_call",
      tool: "exec_command",
      content: "TOP SECRET transcript body",
      input: { command: "private command" },
      output: "private output",
    },
    { type: "assistant", content: "private answer" },
  ]);
  store.reportProgress(targetTask.id, "Indexing repository", 2, 5);
  store.createTaskHumanRequest({
    taskId: targetTask.id,
    kind: "question",
    payload: { question: "TOP SECRET human request", options: ["private choice"] },
  });
  return {
    store,
    app,
    owner,
    member,
    runtime,
    ownerToken,
    memberToken,
    supervisorAgent,
    targetAgent,
    supervisorTask,
    patrolIssue,
    targetTask,
    targetIssue,
  };
}

async function grantSupervisor(fixture: Awaited<ReturnType<typeof setup>>) {
  const response = await fixture.app.request(`/api/agents/${fixture.supervisorAgent.id}/supervisor`, {
    method: "PUT",
    headers: headers(fixture.ownerToken.token),
    body: JSON.stringify({ enabled: true }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).supervisor).toBe(true);
  return fixture.store.createTaskAccessToken(fixture.supervisorTask, "owner");
}

async function setMode(fixture: Awaited<ReturnType<typeof setup>>, mode: "report_only" | "act") {
  const response = await fixture.app.request("/api/workspaces/local/organizer", {
    method: "PUT",
    headers: headers(fixture.ownerToken.token),
    body: JSON.stringify({ mode }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).mode).toBe(mode);
}

describe("Organizer supervisor privilege layer", () => {
  it("defaults to report_only and only lets human owner/admin configure supervisor authority", async () => {
    const fixture = await setup();

    const defaults = await fixture.app.request("/api/workspaces/local/organizer", {
      headers: headers(fixture.memberToken.token),
    });
    expect(defaults.status).toBe(200);
    expect(await defaults.json()).toEqual({ workspace_id: "local", mode: "report_only" });

    const memberMode = await fixture.app.request("/api/workspaces/local/organizer", {
      method: "PUT",
      headers: headers(fixture.memberToken.token),
      body: JSON.stringify({ mode: "act" }),
    });
    expect(memberMode.status).toBe(403);

    const memberGrant = await fixture.app.request(`/api/agents/${fixture.supervisorAgent.id}/supervisor`, {
      method: "PUT",
      headers: headers(fixture.memberToken.token),
      body: JSON.stringify({ enabled: true }),
    });
    expect(memberGrant.status).toBe(403);

    const preGrantToken = await fixture.store.createTaskAccessToken(fixture.supervisorTask, "owner");
    expect(preGrantToken.scopes).toEqual([]);
    const selfGrant = await fixture.app.request(`/api/agents/${fixture.supervisorAgent.id}/supervisor`, {
      method: "PUT",
      headers: headers(preGrantToken.token),
      body: JSON.stringify({ enabled: true }),
    });
    expect(selfGrant.status).toBe(403);
    expect((await selfGrant.json()).code).toBe("task_token_hard_denied");

    const supervisorToken = await grantSupervisor(fixture);
    expect(supervisorToken.scopes).toEqual(["organizer:supervisor"]);
    const revokedOldToken = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/inspection`, {
      headers: headers(preGrantToken.token),
    });
    expect(revokedOldToken.status).toBe(401);
  });

  it("exposes transcript-free inspection metadata while preserving main's owner parity", async () => {
    const fixture = await setup();
    const supervisorToken = await grantSupervisor(fixture);
    const normalTaskToken = await fixture.store.createTaskAccessToken(fixture.targetTask, "owner");

    const inspectionResponse = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/inspection`, {
      headers: headers(supervisorToken.token),
    });
    expect(inspectionResponse.status).toBe(200);
    const inspection = (await inspectionResponse.json()).inspection;
    expect(inspection).toMatchObject({
      id: fixture.targetTask.id,
      agent_id: fixture.targetAgent.id,
      issue_id: fixture.targetIssue.id,
      runtime_id: fixture.runtime.id,
      progress_summary: "Indexing repository",
      progress_step: 2,
      progress_total: 5,
      last_message: { seq: 2 },
      message_type_histogram: [
        { type: "tool_call", tool: "exec_command", count: 1 },
        { type: "assistant", tool: null, count: 1 },
      ],
      human_requests: {
        counts: { pending: 1, responded: 0, timeout: 0, cancelled: 0 },
        latest: { kind: "question", status: "pending" },
      },
      runtime: { id: fixture.runtime.id, status: "online", online: true },
      agent: { id: fixture.targetAgent.id, name: "Worker", supervisor: false },
      issue: { id: fixture.targetIssue.id },
    });
    expect(JSON.stringify(inspection)).not.toContain("TOP SECRET");
    expect(JSON.stringify(inspection)).not.toContain("private command");
    expect(JSON.stringify(inspection)).not.toContain("private output");

    const globalList = await fixture.app.request("/api/multiremi/tasks", {
      headers: headers(supervisorToken.token),
    });
    expect(globalList.status).toBe(200);
    const listed = (await globalList.json()).tasks;
    expect(listed.map((task: any) => task.id)).toEqual(expect.arrayContaining([
      fixture.supervisorTask.id,
      fixture.targetTask.id,
    ]));
    expect(JSON.stringify(listed)).toContain("TOP SECRET target prompt");

    const normalList = await fixture.app.request("/api/multiremi/tasks", {
      headers: headers(normalTaskToken.token),
    });
    expect((await normalList.json()).tasks.map((task: any) => task.id)).toEqual(expect.arrayContaining([
      fixture.supervisorTask.id,
      fixture.targetTask.id,
    ]));
    const normalCrossRead = await fixture.app.request(`/api/tasks/${fixture.supervisorTask.id}/inspection`, {
      headers: headers(normalTaskToken.token),
    });
    expect(normalCrossRead.status).toBe(200);
    expect(JSON.stringify(await normalCrossRead.json())).not.toContain("inspect tasks");
  });

  it("blocks self, supervisor targets, and report_only actions without changing owner parity", async () => {
    const fixture = await setup();
    const supervisorToken = await grantSupervisor(fixture);
    const normalTaskToken = await fixture.store.createTaskAccessToken(fixture.targetTask, "owner");

    const self = await fixture.app.request(`/api/tasks/${fixture.supervisorTask.id}/steer`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ content: "stop", reason: "self check" }),
    });
    expect(self.status).toBe(403);
    expect((await self.json()).code).toBe("organizer_self_action_forbidden");

    const ordinaryTarget = fixture.store.createTask({
      agentId: fixture.targetAgent.id,
      issueId: fixture.store.createIssue({ title: "Owner parity target", workspaceId: "local" }).id,
      workspaceId: "local",
      prompt: "ordinary owner action",
    });
    const normalCross = await fixture.app.request(`/api/tasks/${ordinaryTarget.id}/cancel`, {
      method: "POST",
      headers: headers(normalTaskToken.token),
      body: JSON.stringify({ reason: "owner parity" }),
    });
    expect(normalCross.status).toBe(200);
    expect(fixture.store.getTask(ordinaryTarget.id)?.status).toBe("cancelled");
    expect(fixture.store.listOrganizerActionsForTask(ordinaryTarget.id)).toHaveLength(0);

    const reportOnly = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/steer`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ force_answer: true, reason: "no progress" }),
    });
    expect(reportOnly.status).toBe(403);
    expect((await reportOnly.json()).code).toBe("organizer_report_only");

    for (const action of ["cancel", "redispatch"] as const) {
      const blockedTask = fixture.store.createTask({
        agentId: fixture.targetAgent.id,
        issueId: fixture.targetIssue.id,
        workspaceId: "local",
        prompt: `${action} must remain blocked`,
      });
      const path = action === "cancel"
        ? `/api/issues/${fixture.targetIssue.id}/tasks/${blockedTask.id}/cancel`
        : `/api/tasks/${blockedTask.id}/redispatch`;
      const blocked = await fixture.app.request(path, {
        method: "POST",
        headers: headers(supervisorToken.token),
        body: JSON.stringify({ reason: "observation period" }),
      });
      expect(blocked.status, action).toBe(403);
      expect((await blocked.json()).code, action).toBe("organizer_report_only");
      expect(fixture.store.getTask(blockedTask.id)?.status, action).not.toBe("cancelled");
    }

    const normalRedispatch = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/redispatch`, {
      method: "POST",
      headers: headers(normalTaskToken.token),
      body: JSON.stringify({ reason: "not an organizer" }),
    });
    expect(normalRedispatch.status).toBe(403);
    expect((await normalRedispatch.json()).code).toBe("organizer_supervisor_required");

    const bulkCancel = await fixture.app.request(`/api/agents/${fixture.targetAgent.id}/cancel-tasks`, {
      method: "POST",
      headers: headers(supervisorToken.token),
    });
    expect(bulkCancel.status).toBe(403);
    expect((await bulkCancel.json()).code).toBe("organizer_bulk_action_forbidden");

    const protectedAgent = fixture.store.createAgent({
      name: "Other organizer",
      provider: "codex",
      workspaceId: "local",
      ownerId: "owner",
    });
    fixture.store.setAgentSupervisor(protectedAgent.id, true);
    const protectedTask = fixture.store.createTask({
      agentId: protectedAgent.id,
      issueId: fixture.store.createIssue({ title: "Protected", workspaceId: "local" }).id,
      workspaceId: "local",
      prompt: "patrol",
    });
    await setMode(fixture, "act");
    const protectedResponse = await fixture.app.request(`/api/tasks/${protectedTask.id}/cancel`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ reason: "looks stuck" }),
    });
    expect(protectedResponse.status).toBe(403);
    expect((await protectedResponse.json()).code).toBe("organizer_supervisor_target_forbidden");
  });

  it("audits and discloses every act-mode cross-task action through issue comments and inbox", async () => {
    const fixture = await setup();
    const supervisorToken = await grantSupervisor(fixture);
    await setMode(fixture, "act");

    const steered = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/steer`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ force_answer: true, reason: "No semantic progress for 20 minutes" }),
    });
    expect(steered.status).toBe(201);
    const steeredBody = await steered.json();
    expect(steeredBody.message.kind).toBe("force_answer");
    expect(steeredBody.organizer_action).toMatchObject({
      supervisorTaskId: fixture.supervisorTask.id,
      targetTaskId: fixture.targetTask.id,
      action: "force_answer",
      reason: "No semantic progress for 20 minutes",
    });
    expect(fixture.store.listOrganizerActionsForTask(fixture.targetTask.id)).toHaveLength(1);
    const comment = fixture.store.listIssueComments(fixture.patrolIssue.id).at(-1)!;
    expect(comment.body).toContain("Organizer action: force_answer");
    expect(comment.body).toContain("Criterion: No semantic progress for 20 minutes");
    expect(comment.body).toContain(steeredBody.organizer_action.id);
    const disclosure = fixture.store.listInboxItems(fixture.owner.id).find((item) =>
      item.type === "organizer_action" && item.issueId === fixture.patrolIssue.id
    );
    expect(disclosure).toBeDefined();
    expect(disclosure!.severity).toBe("attention");
    expect(disclosure!.body).toContain(steeredBody.organizer_action.id);

    const cancelIssue = fixture.store.createIssue({ title: "Cancel target", workspaceId: "local" });
    const cancelTask = fixture.store.createTask({
      agentId: fixture.targetAgent.id,
      issueId: cancelIssue.id,
      workspaceId: "local",
      prompt: "stuck task",
    });
    const cancelled = await fixture.app.request(`/api/issues/${cancelIssue.id}/tasks/${cancelTask.id}/cancel`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ reason: "Runtime is offline and recovery was exhausted" }),
    });
    expect(cancelled.status).toBe(200);
    expect((await cancelled.json()).organizer_action.action).toBe("cancel");
    expect(fixture.store.getTask(cancelTask.id)?.status).toBe("cancelled");
    expect(fixture.store.listOrganizerActionsForTask(cancelTask.id)).toHaveLength(1);
    expect(fixture.store.listIssueComments(fixture.patrolIssue.id).at(-1)?.body).toContain("Organizer action: cancel");

    const redispatchIssue = fixture.store.createIssue({ title: "Redispatch target", workspaceId: "local" });
    const redispatchTask = fixture.store.createTask({
      agentId: fixture.targetAgent.id,
      issueId: redispatchIssue.id,
      workspaceId: "local",
      prompt: "queued too long",
    });
    const redispatched = await fixture.app.request(`/api/tasks/${redispatchTask.id}/redispatch`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ reason: "Queued for 30 minutes without a running sibling" }),
    });
    expect(redispatched.status).toBe(202);
    const redispatchedBody = await redispatched.json();
    expect(redispatchedBody.organizer_action.action).toBe("redispatch");
    expect(redispatchedBody.cancelled_task.status).toBe("cancelled");
    expect(redispatchedBody.replacement_task).toMatchObject({
      agentId: fixture.targetAgent.id,
      issueId: redispatchIssue.id,
      parentTaskId: redispatchTask.id,
      status: "queued",
      attempt: 2,
    });
    expect(redispatchedBody.organizer_action.replacementTaskId).toBe(redispatchedBody.replacement_task.id);
    expect(fixture.store.listOrganizerActionsForTask(redispatchTask.id)).toHaveLength(1);
    const redispatchComment = fixture.store.listIssueComments(fixture.patrolIssue.id).at(-1)!;
    expect(redispatchComment.body).toContain("Organizer action: redispatch");
    expect(redispatchComment.body).toContain(`Replacement task: ${redispatchedBody.replacement_task.id}`);
  });
});
