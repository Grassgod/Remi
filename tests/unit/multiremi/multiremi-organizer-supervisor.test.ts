import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { InMemoryDaemonTraceReader } from "@multiremi/api/trace/daemon-trace-reader.js";
import { InMemoryTraceStore } from "@multiremi/worker/trace-store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  const trace = new InMemoryTraceStore();
  trace.append(targetTask.id, [
    {
      type: "tool_call",
      tool: "exec_command",
      content: "TOP SECRET transcript body",
      input: { command: "private command" },
      output: "private output",
    },
    { type: "assistant", content: "private answer" },
  ]);
  const app = createMultiremiApp({ store, authToken: "root-secret",
    daemonTraceReader: new InMemoryDaemonTraceReader(() => trace) });
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
  it("records a dependency exemption on real supervisor redispatch", async () => {
    const fixture = await setup();
    const supervisorToken = await grantSupervisor(fixture);
    await setMode(fixture, "act");
    const prerequisite = fixture.store.createIssue({ title: "Still open", status: "in_progress" });
    fixture.store.createIssueDependency(fixture.targetIssue.id, {
      dependsOnIssueId: prerequisite.id, type: "blocked_by",
    });
    fixture.store.updateIssue(fixture.targetIssue.id, { status: "backlog" });
    const response = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/redispatch`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ reason: "restore lane" }),
    });
    expect(response.status).toBe(202);
    const replacement = fixture.store.listTasksForIssue(fixture.targetIssue.id)
      .find((task) => task.id !== fixture.targetTask.id)!;
    expect(replacement.status).toBe("queued");
    const activities = fixture.store.listIssueActivity(fixture.targetIssue.id)
      .filter((activity) => activity.type === "dependency_gate_exempted");
    expect(activities).toHaveLength(1);
    expect(activities[0]!.data).toMatchObject({
      source: "redispatch", taskId: replacement.id,
      previousTaskId: fixture.targetTask.id, unmet: [{ key: prerequisite.key }],
    });
  });
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
    fixture.store.markTaskTraceDaemon(fixture.targetTask.id, fixture.runtime.id);
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
    // MUL-357 trims `prompt` from list entries, so the same cross-task content
    // parity is asserted on the detail route, which keeps the full shape.
    const targetDetail = await fixture.app.request(`/api/multiremi/tasks/${fixture.targetTask.id}`, {
      headers: headers(supervisorToken.token),
    });
    expect(targetDetail.status).toBe(200);
    expect(JSON.stringify((await targetDetail.json()).task)).toContain("TOP SECRET target prompt");

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

  it("keeps redispatch restrictions while allowing baseline actions in report_only", async () => {
    const fixture = await setup();
    const supervisorToken = await grantSupervisor(fixture);
    const normalTaskToken = await fixture.store.createTaskAccessToken(fixture.targetTask, "owner");

    const self = await fixture.app.request(`/api/tasks/${fixture.supervisorTask.id}/redispatch`, {
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
    expect(reportOnly.status).toBe(201);
    expect((await reportOnly.json()).message.kind).toBe("force_answer");
    expect(fixture.store.listOrganizerActionsForTask(fixture.targetTask.id)).toHaveLength(0);

    for (const action of ["redispatch"] as const) {
      const blockedTask = fixture.store.createTask({
        agentId: fixture.targetAgent.id,
        issueId: fixture.targetIssue.id,
        workspaceId: "local",
        prompt: `${action} must remain blocked`,
      });
      const path = `/api/tasks/${blockedTask.id}/redispatch`;
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
    expect(bulkCancel.status).toBe(200);
    expect((await bulkCancel.json()).cancelled).toBeGreaterThan(0);
    expect(fixture.store.getTask(fixture.targetTask.id)?.status).toBe("cancelled");

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
    const protectedResponse = await fixture.app.request(`/api/tasks/${protectedTask.id}/redispatch`, {
      method: "POST",
      headers: headers(supervisorToken.token),
      body: JSON.stringify({ reason: "looks stuck" }),
    });
    expect(protectedResponse.status).toBe(403);
    expect((await protectedResponse.json()).code).toBe("organizer_supervisor_target_forbidden");
  });

  it.each(["report_only", "act"] as const)("uses baseline cancel and steer routes in %s without organizer audit", async (mode) => {
    const fixture = await setup();
    const token = await grantSupervisor(fixture);
    await setMode(fixture, mode);
    for (const prefix of ["/api/tasks", "/api/multiremi/tasks"]) {
      for (const kind of ["steer", "force_answer"]) {
        const response = await fixture.app.request(`${prefix}/${fixture.targetTask.id}/steer`, {
          method: "POST", headers: headers(token.token),
          body: JSON.stringify({ kind, content: "Please wrap up" }),
        });
        expect(response.status).toBe(201);
        expect((await response.json()).message).toMatchObject({ kind, authorType: "agent" });
      }
    }
    const paths = [
      (id: string) => `/api/tasks/${id}/cancel`,
      (id: string) => `/api/multiremi/tasks/${id}/cancel`,
      (id: string) => `/api/issues/${fixture.targetIssue.id}/tasks/${id}/cancel`,
    ];
    for (const path of paths) {
      const task = fixture.store.createTask({
        agentId: fixture.targetAgent.id, issueId: fixture.targetIssue.id, prompt: "cancel target",
      });
      const response = await fixture.app.request(path(task.id), { method: "POST", headers: headers(token.token) });
      expect(response.status).toBe(200);
      expect((await response.json()).organizer_action).toBeUndefined();
      expect(fixture.store.getTask(task.id)?.status).toBe("cancelled");
      expect(fixture.store.listOrganizerActionsForTask(task.id)).toHaveLength(0);
    }
    expect(fixture.store.listOrganizerActionsForTask(fixture.targetTask.id)).toHaveLength(0);
    expect(fixture.store.listIssueComments(fixture.patrolIssue.id)).toHaveLength(0);
    const selfRedispatch = await fixture.app.request(`/api/tasks/${fixture.supervisorTask.id}/redispatch`, {
      method: "POST", headers: headers(token.token), body: JSON.stringify({ reason: "self check" }),
    });
    expect(selfRedispatch.status).toBe(403);
    expect((await selfRedispatch.json()).code).toBe("organizer_self_action_forbidden");
    const self = await fixture.app.request(`/api/tasks/${fixture.supervisorTask.id}/cancel`, {
      method: "POST", headers: headers(token.token),
    });
    expect(self.status).toBe(200);
    expect(fixture.store.getTask(fixture.supervisorTask.id)?.status).toBe("cancelled");
  });

  it("allows chat supervisors without patrol issues to cancel targets and their own tasks in bulk", async () => {
    const fixture = await setup();
    await grantSupervisor(fixture);
    const chat = fixture.store.createChatSession({
      agentId: fixture.supervisorAgent.id, workspaceId: "local", creatorId: "owner", title: "Human request",
    });
    const chatTask = fixture.store.sendChatMessage(chat.id, { body: "Stop the worker" }).task;
    const token = await fixture.store.createTaskAccessToken(chatTask, "owner");
    expect(chatTask.issueId).toBeNull();
    const cancelled = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/cancel`, {
      method: "POST", headers: headers(token.token),
    });
    expect(cancelled.status).toBe(200);
    expect(fixture.store.getTask(fixture.targetTask.id)?.status).toBe("cancelled");
    const bulk = await fixture.app.request(`/api/agents/${fixture.supervisorAgent.id}/cancel-tasks`, {
      method: "POST", headers: headers(token.token),
    });
    expect(bulk.status).toBe(200);
    expect((await bulk.json()).cancelled).toBe(2);
    expect(fixture.store.getTask(chatTask.id)?.status).toBe("cancelled");
  });

  it("preserves the organizer store audit branches and redispatch route disclosure", async () => {
    const fixture = await setup();
    const supervisorToken = await grantSupervisor(fixture);
    await setMode(fixture, "act");

    const steered = fixture.store.performOrganizerAction({
      supervisorTaskId: fixture.supervisorTask.id,
      supervisorAgentId: fixture.supervisorAgent.id,
      targetTaskId: fixture.targetTask.id,
      action: "force_answer",
      reason: "No semantic progress for 20 minutes",
      content: "Please wrap up",
    });
    const steeredBody = { message: steered.message!, organizer_action: steered.audit };
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
    const cancelled = fixture.store.performOrganizerAction({
      supervisorTaskId: fixture.supervisorTask.id,
      supervisorAgentId: fixture.supervisorAgent.id,
      targetTaskId: cancelTask.id,
      action: "cancel",
      reason: "Runtime is offline and recovery was exhausted",
    });
    expect(cancelled.audit.action).toBe("cancel");
    expect(fixture.store.getTask(cancelTask.id)?.status).toBe("cancelled");
    expect(fixture.store.listOrganizerActionsForTask(cancelTask.id)).toHaveLength(1);
    expect(fixture.store.listIssueComments(fixture.patrolIssue.id).at(-1)?.body).toContain("Organizer action: cancel");

    const redispatchIssue = fixture.store.createIssue({ title: "Redispatch target", workspaceId: "local" });
    const continuedFromTask = fixture.store.createTask({
      agentId: fixture.targetAgent.id,
      issueId: redispatchIssue.id,
      workspaceId: "local",
      prompt: "original delegated round",
    });
    const redispatchTask = fixture.store.createTask({
      agentId: fixture.targetAgent.id,
      issueId: redispatchIssue.id,
      workspaceId: "local",
      prompt: "queued too long",
      continuedFromTaskId: continuedFromTask.id,
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
      continuedFromTaskId: continuedFromTask.id,
      status: "queued",
      attempt: 2,
    });
    expect(redispatchedBody.organizer_action.replacementTaskId).toBe(redispatchedBody.replacement_task.id);
    expect(fixture.store.listOrganizerActionsForTask(redispatchTask.id)).toHaveLength(1);
    const redispatchComment = fixture.store.listIssueComments(fixture.patrolIssue.id).at(-1)!;
    expect(redispatchComment.body).toContain("Organizer action: redispatch");
    expect(redispatchComment.body).toContain(`Replacement task: ${redispatchedBody.replacement_task.id}`);
  });

  it("does not broadcast the organizer audit comment when the transaction rolls back", async () => {
    const fixture = await setup();
    await grantSupervisor(fixture);
    await setMode(fixture, "act");

    // QA round 3 reproduction: fail AFTER the audit comment is written but
    // BEFORE the organizer transaction commits. The comment row must roll back
    // (it does — it is in the same transaction) and, crucially, the realtime
    // push must not have gone out for a comment that never existed.
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const unsubscribe = fixture.store.onWorkspaceEvent((event) => {
      if (event.type === "comment:created") events.push(event);
    });
    // QA's injection point: after the audit comment is written, before COMMIT.
    const issues = (fixture.store as unknown as {
      issues: { notifyOrganizerAction: (...args: unknown[]) => void };
    }).issues;
    const originalNotify = issues.notifyOrganizerAction.bind(issues);
    issues.notifyOrganizerAction = (...args: unknown[]) => {
      originalNotify(...args);
      throw new Error("organizer rollback injection");
    };

    let threw = false;
    try {
      fixture.store.performOrganizerAction({
        supervisorTaskId: fixture.supervisorTask.id,
        supervisorAgentId: fixture.supervisorAgent.id,
        targetTaskId: fixture.targetTask.id,
        action: "cancel",
        reason: "rollback probe",
      });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe("organizer rollback injection");
    } finally {
      issues.notifyOrganizerAction = originalNotify;
      unsubscribe();
    }

    expect(threw).toBe(true);
    // The transaction rolled back: no audit comment, the target still queued.
    expect(fixture.store.getTask(fixture.targetTask.id)?.status).toBe("queued");
    expect(events.filter((event) => event.type === "comment:created")).toHaveLength(0);
  });

  it("publishes no activity or issue patch when the organizer cancel rolls back", async () => {
    const fixture = await setup();
    await grantSupervisor(fixture);
    await setMode(fixture, "act");

    // QA round 4: the audit comment push was already deferred, but
    // `afterTaskTerminal` still emitted the cancel activity mid-transaction.
    const events: Array<{ type: string; action: string; inTransaction: boolean }> = [];
    const unsubscribe = fixture.store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (["comment:created", "activity:created", "issue:updated"].includes(event.type)) {
        events.push({ type: event.type, action: entry?.action ?? "", inTransaction: db!.inTransaction });
      }
    });
    const issues = (fixture.store as unknown as {
      issues: { notifyOrganizerAction: (...args: unknown[]) => void };
    }).issues;
    const originalNotify = issues.notifyOrganizerAction.bind(issues);
    issues.notifyOrganizerAction = (...args: unknown[]) => {
      originalNotify(...args);
      throw new Error("organizer activity rollback injection");
    };

    try {
      fixture.store.performOrganizerAction({
        supervisorTaskId: fixture.supervisorTask.id,
        supervisorAgentId: fixture.supervisorAgent.id,
        targetTaskId: fixture.targetTask.id,
        action: "cancel",
        reason: "activity rollback probe",
      });
    } catch (err) {
      expect((err as Error).message).toBe("organizer activity rollback injection");
    } finally {
      issues.notifyOrganizerAction = originalNotify;
      unsubscribe();
    }

    // Rolled back: the target task is still queued and every outbound event is
    // zero — no phantom comment, activity or status patch.
    expect(fixture.store.getTask(fixture.targetTask.id)?.status).toBe("queued");
    expect(events.filter((event) => event.type === "comment:created")).toHaveLength(0);
    expect(events.filter((event) => event.type === "activity:created")).toHaveLength(0);
    expect(events.filter((event) => event.type === "issue:updated")).toHaveLength(0);
  });

  it("publishes the organizer cancel activity, comment and patch once, after COMMIT", async () => {
    const fixture = await setup();
    await grantSupervisor(fixture);
    await setMode(fixture, "act");

    // The cancel moves the Issue in_progress -> todo, so the status patch is a
    // real change and its post-commit emission is observable.
    fixture.store.updateIssue(fixture.targetIssue.id, { status: "in_progress" });
    const events: Array<{ type: string; action: string; inTransaction: boolean }> = [];
    const unsubscribe = fixture.store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (["comment:created", "activity:created", "issue:updated"].includes(event.type)) {
        events.push({ type: event.type, action: entry?.action ?? "", inTransaction: db!.inTransaction });
      }
    });
    try {
      fixture.store.performOrganizerAction({
        supervisorTaskId: fixture.supervisorTask.id,
        supervisorAgentId: fixture.supervisorAgent.id,
        targetTaskId: fixture.targetTask.id,
        action: "cancel",
        reason: "commit probe",
      });
    } finally {
      unsubscribe();
    }

    expect(fixture.store.getTask(fixture.targetTask.id)?.status).toBe("cancelled");
    expect(events.filter((event) => event.type === "comment:created")).toHaveLength(1);
    expect(events.filter((event) => event.type === "activity:created" && event.action === "task_cancelled"))
      .toHaveLength(1);
    expect(events.filter((event) => event.type === "issue:updated")).toHaveLength(1);
    expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
  });

  it("broadcasts the organizer audit comment exactly once after the commit", async () => {
    const fixture = await setup();
    const supervisorToken = await grantSupervisor(fixture);
    await setMode(fixture, "act");

    const events: Array<{ type: string; payload: Record<string, unknown>; inTransaction?: boolean }> = [];
    const unsubscribe = fixture.store.onWorkspaceEvent((event) => {
      if (event.type === "comment:created") events.push({ ...event, inTransaction: db!.inTransaction });
    });
    try {
      // The organizer redispatch route is the path that writes the audit comment
      // inside the organizer transaction.
      const response = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/redispatch`, {
        method: "POST",
        headers: headers(supervisorToken.token),
        body: JSON.stringify({ reason: "commit probe" }),
      });
      expect(response.status).toBe(202);
    } finally {
      unsubscribe();
    }

    // The comment row is committed and the push fired exactly once, outside the
    // transaction (so the client could not see it before it was durable).
    expect(fixture.store.getTask(fixture.targetTask.id)?.status).toBe("cancelled");
    expect(events).toHaveLength(1);
    expect(events[0]?.inTransaction).toBe(false);
  });

  it("dispatches rich organizer comment mentions within the outer transaction", async () => {
    const fixture = await setup();
    await grantSupervisor(fixture);
    await setMode(fixture, "act");
    const leader = fixture.store.createAgent({
      name: "Squad leader",
      provider: "codex",
      workspaceId: "local",
      ownerId: "owner",
    });
    const squad = fixture.store.createSquad({
      name: "Organizer squad",
      leaderId: leader.id,
      memberIds: [fixture.supervisorAgent.id],
    });
    const delegatedIssue = fixture.store.createIssue({
      title: "Delegated organizer patrol",
      workspaceId: "local",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const delegatedSupervisorTask = fixture.store.createTask({
      agentId: fixture.supervisorAgent.id,
      issueId: delegatedIssue.id,
      workspaceId: "local",
      prompt: "inspect delegated tasks",
      delegationId: "dlg_organizer_return",
      delegatedByAgentId: leader.id,
    });
    const supervisorToken = await fixture.store.createTaskAccessToken(delegatedSupervisorTask, "owner");
    const originalEnsure = fixture.store.ensureDelegationWakeupWithinTransaction.bind(fixture.store);
    let ensureObservedInTransaction: boolean | null = null;
    const enqueueTransactionStates: boolean[] = [];
    fixture.store.ensureDelegationWakeupWithinTransaction = ((input, childStatusChanges, deferredEvents) => {
      ensureObservedInTransaction = db!.inTransaction;
      return originalEnsure(input, childStatusChanges, deferredEvents);
    }) as typeof fixture.store.ensureDelegationWakeupWithinTransaction;
    const unsubscribe = fixture.store.onTaskEnqueued((task) => {
      if (task.agentId === leader.id) {
        enqueueTransactionStates.push(db!.inTransaction);
      }
    });

    try {
      const response = await fixture.app.request(`/api/tasks/${fixture.targetTask.id}/redispatch`, {
        method: "POST",
        headers: headers(supervisorToken.token),
        body: JSON.stringify({
          reason: `Needs a decision [@Squad leader](mention://agent/${leader.id})`,
        }),
      });
      expect(response.status).toBe(202);
    } finally {
      fixture.store.ensureDelegationWakeupWithinTransaction = originalEnsure;
      unsubscribe();
    }

    expect(ensureObservedInTransaction).not.toBeNull();
    expect(Boolean(ensureObservedInTransaction)).toBeTrue();
    expect(enqueueTransactionStates).toEqual([false]);
    expect(fixture.store.listTasksForIssue(delegatedIssue.id).find((task) =>
      task.agentId === leader.id && task.parentTaskId === delegatedSupervisorTask.id
    )).toBeDefined();
    expect(fixture.store.listIssueActivity(delegatedIssue.id).some((activity) =>
      activity.type === "delegation_return_triggered"
      && (activity.data as Record<string, unknown>).sourceTaskId === delegatedSupervisorTask.id
    )).toBeTrue();
  });
});
