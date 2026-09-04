// Issues as first-class records plus the compatibility list/grouped/batch,
// quick-create, hierarchy/planning, dependency, assignment, metadata and label routes.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi API — issue endpoints", () => {
  it("auto-binds an Issue created by a Chat task without replacing an existing binding", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Chat issue creator", provider: "codex" });
    const chat = store.createChatSession({
      agentId: agent.id,
      workspaceId: "local",
      creatorId: "local",
      title: "Issue creation topic",
    });
    const chatTask = store.sendChatMessage(chat.id, { body: "Create an Issue" }).task;
    const chatCredential = await store.createTaskAccessToken(chatTask, "local");
    const app = createMultiremiApp({ store });
    const createFromChat = (title: string) => app.request("/api/issues", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${chatCredential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });

    const first = await createFromChat("Created from Chat");
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.chat_issue_binding).toEqual({
      status: "bound",
      chat_session_id: chat.id,
      issue_id: firstBody.id,
      existing_issue_id: null,
    });
    expect(firstBody.chat_issue_binding_hint).toBeUndefined();
    expect(store.getChatSession(chat.id)?.issueId).toBe(firstBody.id);
    expect(store.getAgentIssueUpdateSubscription(chat.id).enabled).toBe(true);

    const second = await createFromChat("Second Issue from the same Chat task");
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.chat_issue_binding).toEqual({
      status: "preserved",
      chat_session_id: chat.id,
      issue_id: secondBody.id,
      existing_issue_id: firstBody.id,
    });
    expect(secondBody.chat_issue_binding_hint).toContain(`${firstBody.identifier}; ${secondBody.identifier} was not auto-bound`);
    expect(store.getChatSession(chat.id)?.issueId).toBe(firstBody.id);

    const issueSession = store.getOrCreateDefaultIssueSession(firstBody.id);
    const issueTask = store.createSessionTask(issueSession.id, {
      agentId: agent.id,
      prompt: "Create a child Issue",
    });
    const issueCredential = await store.createTaskAccessToken(issueTask, "local");
    const issueLaneCreate = await app.request("/api/issues", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issueCredential.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Created from Issue lane" }),
    });
    expect(issueLaneCreate.status).toBe(201);
    expect((await issueLaneCreate.json()).chat_issue_binding).toBeUndefined();
    expect(store.getChatSession(chat.id)?.issueId).toBe(firstBody.id);
  });

  it("configures issue archiving and exposes archived list and restore APIs", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const archived = store.createIssue({ title: "Archived API issue", status: "done" });
    const active = store.createIssue({ title: "Active API issue" });
    const app = createMultiremiApp({ store });

    const invalidSettings = await app.request("/api/workspaces/local/issue-archive", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_ms: 1, sweep_interval_ms: 1, extra: true }),
    });
    expect(invalidSettings.status).toBe(400);

    const settings = await app.request("/api/workspaces/local/issue-archive", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttl_ms: 3_600_000, sweep_interval_ms: 60_000 }),
    });
    expect(await settings.json()).toEqual({
      config: { ttl_ms: 3_600_000, sweep_interval_ms: 60_000 },
    });

    store.archiveEligibleIssues(new Date(Date.now() + 3_600_001));
    const activeList = await app.request("/api/issues?workspace_id=local");
    expect((await activeList.json()).issues.map((issue: any) => issue.id)).toEqual([active.id]);
    const archivedList = await app.request("/api/issues?workspace_id=local&archived_only=true");
    const archivedBody = await archivedList.json();
    expect(archivedBody.issues).toHaveLength(1);
    expect(archivedBody.issues[0]).toMatchObject({
      id: archived.id,
      completed_at: expect.any(String),
      archived_at: expect.any(String),
    });
    expect(archivedBody.total).toBe(1);

    const archivedCount = await app.request(
      "/api/issues?workspace_id=local&archived_only=true&limit=1",
    );
    expect(await archivedCount.json()).toMatchObject({ total: 1 });

    const restored = await app.request(`/api/issues/${archived.id}/restore`, { method: "POST" });
    expect(await restored.json()).toMatchObject({
      id: archived.id,
      completed_at: null,
      archived_at: null,
      status: "done",
    });
  });

  it("gives an owner task token delete parity while rejecting daemon and member credentials", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const target = store.createIssue({ title: "Human-admin delete only", workspaceId: "local" });
    const authIssue = store.createIssue({ title: "Task credential source", workspaceId: "local" });
    const agent = store.createAgent({ name: "Delete auth agent", provider: "codex" });
    const task = store.createTask({
      workspaceId: "local",
      issueId: authIssue.id,
      agentId: agent.id,
      prompt: "authenticate only",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const daemonToken = await store.createAccessToken({
      name: "Delete auth daemon",
      type: "daemon",
      purpose: "daemon",
      workspaceId: "local",
      daemonId: "dmn_delete_auth",
    });
    store.createWorkspaceMember({
      id: "mem_delete_member",
      workspaceId: "local",
      userId: "usr_delete_member",
      name: "Delete member",
      role: "member",
    });
    const memberToken = await store.createAccessToken({
      name: "Delete member PAT",
      type: "pat",
      workspaceId: "local",
      userId: "usr_delete_member",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const taskSingleTarget = store.createIssue({ title: "Task single delete", workspaceId: "local" });
    expect((await app.request(`/api/issues/${taskSingleTarget.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${taskToken.token}` },
    })).status).toBe(204);
    expect(store.getIssue(taskSingleTarget.id)).toBeNull();

    const taskBatchTarget = store.createIssue({ title: "Task batch delete", workspaceId: "local" });
    expect((await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${taskToken.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ issue_ids: [taskBatchTarget.id] }),
    })).status).toBe(200);
    expect(store.getIssue(taskBatchTarget.id)).toBeNull();

    for (const token of [daemonToken.token, memberToken.token]) {
      const single = await app.request(`/api/issues/${target.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(single.status).toBe(403);
      expect(store.getIssue(target.id)?.id).toBe(target.id);

      const batch = await app.request("/api/issues/batch-delete", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ issue_ids: [target.id] }),
      });
      expect(batch.status).toBe(403);
      expect(store.getIssue(target.id)?.id).toBe(target.id);
    }
  });

  it("preflights batch-delete workspace access before deleting any Issue", async () => {
    const store = createStore();
    const local = store.createIssue({ title: "Local batch delete", workspaceId: "local" });
    const remote = store.createIssue({ title: "Remote batch delete", workspaceId: "remote" });
    store.createWorkspaceMember({
      id: "mem_batch_owner",
      workspaceId: "local",
      userId: "usr_batch_owner",
      name: "Batch owner",
      role: "owner",
    });
    const token = await store.createAccessToken({
      name: "local-only",
      type: "pat",
      workspaceId: "local",
      userId: "usr_batch_owner",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ issue_ids: [local.id, remote.id] }),
    });
    expect(response.status).toBe(404);
    expect(store.getIssue(local.id)?.id).toBe(local.id);
    expect(store.getIssue(remote.id)?.id).toBe(remote.id);
  });

  it("preflights batch lifecycle fences before deleting any Issue", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const deletable = store.createIssue({ title: "Batch deletable", workspaceId: "local" });
    const materialized = store.createIssue({ title: "Batch materialized", workspaceId: "local" });
    store.createIssueSession(materialized.id, { title: "Materialized session" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const response = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: {
        Authorization: "Bearer root-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ issue_ids: [deletable.id, materialized.id] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "issue_workspace_not_cleaned" });
    expect(store.getIssue(deletable.id)?.id).toBe(deletable.id);
    expect(store.getIssue(materialized.id)?.id).toBe(materialized.id);
    expect(store.beginIssueDeletion(deletable.id)).toEqual({ ok: true });
    store.abortIssueDeletion(deletable.id);
  });

  it("serves issues as first-class records with linked tasks", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "First class issue", agentId: agent.id, prompt: "Do it" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    const listed = await app.request("/api/multiremi/issues");
    const listBody = await listed.json();
    expect(listBody.issues[0].taskCount).toBe(1);
    expect(listBody.issues[0].latestTaskId).toBe(createdBody.task.id);

    const detail = await app.request(`/api/multiremi/issues/${createdBody.issue.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.tasks).toHaveLength(1);
    expect(detailBody.issue.tasks[0].prompt).toBe("Do it");

    const updated = await app.request(`/api/issues/${createdBody.issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: "high" }),
    });
    expect((await updated.json()).priority).toBe("high");
  });

  it("serves issue compatibility list, grouped, and batch endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Issue owner" });
    const project = store.createProject({ title: "Batch project" });
    const app = createMultiremiApp({ store });
    const events: Array<{ type: string; workspaceId: string; payload: Record<string, unknown>; actorId?: string | null; actorType?: string }> = [];
    store.onWorkspaceEvent((event) => events.push(event));

    const first = store.createIssue({
      title: "Batch first",
      workspaceId: "local",
      projectId: project.id,
      assigneeType: "agent",
      assigneeId: agent.id,
      status: "open",
      priority: "low",
      position: 2,
    });
    const second = store.createIssue({
      title: "Batch second",
      workspaceId: "local",
      assigneeType: "member",
      assigneeId: member.id,
      status: "open",
      priority: "medium",
      position: 1,
    });
    store.createIssue({ title: "Other workspace", workspaceId: "other", status: "open" });
    const remoteIssue = store.createIssue({ title: "Remote workspace issue", workspaceId: "remote", status: "open" });
    const label = store.createLabel({ name: "Batch label", color: "#22c55e" });
    store.attachLabelToIssue(first.id, label.id);
    const reaction = store.addIssueReaction(first.id, { actorType: "member", actorId: "local", emoji: "👍" });
    const attachment = store.createAttachment({
      issueId: first.id,
      filename: "batch.txt",
      url: "/uploads/batch.txt",
      contentType: "text/plain",
      sizeBytes: 42,
    });
    expect(first.status).toBe("todo");
    expect(second.status).toBe("todo");

    const listed = await app.request("/api/issues?workspace_id=local&status=open");
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(2);
    expect(listedBody.issues.map((issue: any) => issue.id).sort()).toEqual([first.id, second.id].sort());
    const firstListed = listedBody.issues.find((issue: any) => issue.id === first.id);
    expect(firstListed).toMatchObject({
      id: first.id,
      workspace_id: "local",
      identifier: first.key,
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: agent.id,
      labels: [{ id: label.id, workspace_id: "local", name: "Batch label" }],
    });
    expect(firstListed.workspaceId).toBeUndefined();
    expect(firstListed.assigneeId).toBeUndefined();
    expect(firstListed.latestTaskStatus).toBeUndefined();

    const camelWorkspaceList = await app.request("/api/issues?workspaceId=remote&status=open");
    const camelWorkspaceListBody = await camelWorkspaceList.json();
    expect(camelWorkspaceListBody.issues.map((issue: any) => issue.id)).not.toContain(remoteIssue.id);
    const snakeWorkspaceList = await app.request("/api/issues?workspace_id=remote&status=open");
    const snakeWorkspaceListBody = await snakeWorkspaceList.json();
    expect(snakeWorkspaceListBody.issues.map((issue: any) => issue.id)).toEqual([remoteIssue.id]);

    const camelWorkspaceDetail = await app.request(`/api/issues/${remoteIssue.key}?workspaceId=remote`);
    const camelWorkspaceDetailBody = await camelWorkspaceDetail.json();
    expect(camelWorkspaceDetailBody.id).toBe(first.id);
    const snakeWorkspaceDetail = await app.request(`/api/issues/${remoteIssue.key}?workspace_id=remote`);
    const snakeWorkspaceDetailBody = await snakeWorkspaceDetail.json();
    expect(snakeWorkspaceDetailBody.id).toBe(remoteIssue.id);

    const detail = await app.request(`/api/issues/${first.key.toLowerCase()}`);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({
      id: first.id,
      workspace_id: "local",
      identifier: first.key,
      labels: [{ id: label.id, workspace_id: "local", name: "Batch label" }],
      reactions: [{ id: reaction.id, issue_id: first.id, actor_type: "member", actor_id: "local", emoji: "👍" }],
      attachments: [{
        id: attachment.id,
        issue_id: first.id,
        filename: "batch.txt",
        content_type: "text/plain",
        size_bytes: 42,
      }],
    });
    expect(detailBody.tasks).toBeUndefined();
    expect(detailBody.workspaceId).toBeUndefined();
    expect(detailBody.reactions[0].issueId).toBeUndefined();
    expect(detailBody.attachments[0].issueId).toBeUndefined();

    const memberFiltered = await app.request("/api/issues?workspace_id=local&assignee_id=issue%20owner");
    const memberFilteredBody = await memberFiltered.json();
    expect(memberFilteredBody.total).toBe(1);
    expect(memberFilteredBody.issues[0].id).toBe(second.id);

    const agentFiltered = await app.request("/api/issues?workspace_id=local&assignee_id=cod");
    const agentFilteredBody = await agentFiltered.json();
    expect(agentFilteredBody.total).toBe(1);
    expect(agentFilteredBody.issues[0].id).toBe(first.id);

    const camelAssigneeFiltered = await app.request("/api/issues?workspace_id=local&assigneeId=cod");
    const camelAssigneeFilteredBody = await camelAssigneeFiltered.json();
    expect(camelAssigneeFilteredBody.issues.map((issue: any) => issue.id).sort()).toEqual([first.id, second.id].sort());

    const camelProjectFiltered = await app.request(`/api/issues?workspace_id=local&projectId=${project.id}`);
    const camelProjectFilteredBody = await camelProjectFiltered.json();
    expect(camelProjectFilteredBody.issues.map((issue: any) => issue.id).sort()).toEqual([first.id, second.id].sort());

    const grouped = await app.request("/api/issues/grouped?workspace_id=local&statuses=open&limit=10");
    const groupedBody = await grouped.json();
    expect(groupedBody.groups.map((group: any) => group.id)).toEqual([
      `member:${member.id}`,
      `agent:${agent.id}`,
    ]);
    expect(groupedBody.groups[0].total).toBe(1);
    expect(groupedBody.groups[1].issues[0].id).toBe(first.id);

    const camelGrouped = await app.request("/api/issues/grouped?workspaceId=remote&statuses=open&limit=10");
    const camelGroupedBody = await camelGrouped.json();
    expect(camelGroupedBody.groups.flatMap((group: any) => group.issues.map((issue: any) => issue.id))).not.toContain(remoteIssue.id);

    const camelCreated = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Camel ignored issue",
        workspaceId: "remote",
        projectId: project.id,
        assigneeId: member.id,
        dueDate: "2026-05-01",
        acceptanceCriteria: ["ignored"],
      }),
    });
    expect(camelCreated.status).toBe(201);
    const camelCreatedBody = await camelCreated.json();
    expect(camelCreatedBody).toMatchObject({
      workspace_id: "local",
      project_id: null,
      assignee_type: null,
      assignee_id: null,
      due_date: null,
    });
    const camelStored = store.getIssue(camelCreatedBody.id)!;
    expect(camelStored.workspaceId).toBe("local");
    expect(camelStored.projectId).toBeNull();
    expect(camelStored.assigneeId).toBeNull();
    expect(camelStored.dueDate).toBeNull();
    expect(camelStored.acceptanceCriteria).toEqual([]);

    const camelUpdated = await app.request(`/api/issues/${camelCreatedBody.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, assigneeId: member.id, dueDate: "2026-05-02", acceptanceCriteria: ["ignored"] }),
    });
    expect(camelUpdated.status).toBe(200);
    const camelUpdatedBody = await camelUpdated.json();
    expect(camelUpdatedBody).toMatchObject({
      project_id: null,
      assignee_type: null,
      assignee_id: null,
      due_date: null,
    });
    const camelUpdatedStored = store.getIssue(camelCreatedBody.id)!;
    expect(camelUpdatedStored.projectId).toBeNull();
    expect(camelUpdatedStored.assigneeId).toBeNull();
    expect(camelUpdatedStored.dueDate).toBeNull();
    expect(camelUpdatedStored.acceptanceCriteria).toEqual([]);

    const noMutation = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id], updates: {} }),
    });
    expect(await noMutation.json()).toEqual({ updated: 0 });

    const camelBatchIds = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [first.id], updates: { priority: "urgent" } }),
    });
    expect(camelBatchIds.status).toBe(400);
    expect(await camelBatchIds.json()).toEqual({ error: "issue_ids is required" });

    const camelBatchUpdates = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id], updates: { projectId: project.id, assigneeId: member.id } }),
    });
    expect(await camelBatchUpdates.json()).toEqual({ updated: 0 });
    expect(store.getIssue(first.id)?.assigneeId).toBe(agent.id);

    const updated = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issue_ids: [first.id, "missing", second.id],
        updates: { status: "done", priority: "urgent", project_id: project.id },
      }),
    });
    expect(await updated.json()).toEqual({ updated: 2 });
    expect(store.getIssue(first.id)?.status).toBe("done");
    expect(store.getIssue(second.id)?.priority).toBe("urgent");

    const camelDeleted = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issueIds: [first.id] }),
    });
    expect(camelDeleted.status).toBe(400);
    expect(await camelDeleted.json()).toEqual({ error: "issue_ids is required" });
    expect(store.getIssue(first.id)).not.toBeNull();

    const deleted = await app.request("/api/issues/batch-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [first.id, second.id, "missing"] }),
    });
    expect(await deleted.json()).toEqual({ deleted: 2 });
    expect(store.getIssue(first.id)).toBeNull();
    expect(store.getIssue(second.id)).toBeNull();

    const invalidCreate = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidCreate.status).toBe(400);
    expect(await invalidCreate.json()).toEqual({ error: "invalid request body" });

    const compatCreated = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Compat created issue",
        workspace_id: "local",
        assignee_type: "member",
        assignee_id: member.id,
      }),
    });
    expect(compatCreated.status).toBe(201);
    const compatCreatedBody = await compatCreated.json();
    const compatCreatedIdentifier = String(compatCreatedBody.identifier);
    expect(compatCreatedIdentifier).toMatch(/^MUL-\d+$/);
    expect(compatCreatedBody).toMatchObject({
      workspace_id: "local",
      creator_type: "member",
      creator_id: "local",
      assignee_type: "member",
      assignee_id: member.id,
    });
    expect(compatCreatedBody.workspaceId).toBeUndefined();
    expect(events.find((event) => event.type === "issue:created" && (event.payload.issue as any)?.id === compatCreatedBody.id)).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        issue: {
          id: compatCreatedBody.id,
          workspace_id: "local",
          assignee_type: "member",
          assignee_id: member.id,
        },
      },
    });

    const compatUpdated = await app.request(`/api/issues/${compatCreatedIdentifier.toLowerCase()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_progress", priority: "high", assignee_id: null, due_date: "2026-02-03" }),
    });
    expect(compatUpdated.status).toBe(200);
    const compatUpdatedBody = await compatUpdated.json();
    expect(compatUpdatedBody).toMatchObject({
      id: compatCreatedBody.id,
      workspace_id: "local",
      status: "in_progress",
      priority: "high",
      assignee_type: null,
      assignee_id: null,
    });
    expect(compatUpdatedBody.assigneeId).toBeUndefined();
    expect(events.find((event) => event.type === "issue:updated" && (event.payload.issue as any)?.id === compatCreatedBody.id)).toMatchObject({
      workspaceId: "local",
      actorId: "local",
      actorType: "member",
      payload: {
        issue: { id: compatCreatedBody.id, status: "in_progress", priority: "high", assignee_type: null },
        assignee_changed: true,
        status_changed: true,
        priority_changed: true,
        due_date_changed: true,
        prev_status: "todo",
        prev_priority: "none",
        prev_assignee_type: "member",
        prev_assignee_id: member.id,
        creator_type: "member",
        creator_id: "local",
      },
    });
  });

  it("serves quick-create issue compatibility endpoints", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    store.updateWorkspace("local", {
      repos: [
        {
          id: "repo_quick_project",
          name: "quick-project",
          url: "git@example.test:team/quick-project.git",
          source: "github",
        },
        {
          id: "repo_archived_project",
          name: "archived",
          url: "git@example.test:team/archived.git",
          source: "github",
        },
      ],
    });
    const agent = store.createAgent({ name: "Quick Codex", provider: "codex" });
    const executor = store.createAgent({ name: "Project executor", provider: "claude" });
    const leader = store.createAgent({ name: "Squad Lead", provider: "claude" });
    const squad = store.createSquad({ name: "Quick squad", leaderId: leader.id });
    const project = store.createProject({
      title: "Quick project",
      defaultAssigneeType: "agent",
      defaultAssigneeId: executor.id,
    });
    store.createProjectResource(project.id, {
      resourceType: "github_repo",
      resourceRef: { url: "git@example.test:team/quick-project.git" },
    });
    store.createProjectResource(project.id, {
      resourceType: "local_directory",
      resourceRef: { local_path: "/tmp/legacy-project", daemon_id: "daemon-legacy" },
    });
    const archivedProject = store.createProject({
      title: "Archived project",
      resources: [{
        resourceType: "github_repo",
        resourceRef: { url: "git@example.test:team/archived.git" },
      }],
    });
    store.archiveProject(archivedProject.id);
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "quick cod",
        prompt: "Create an issue for improving onboarding screenshots",
        project_id: project.id,
        workspace_id: "local",
      }),
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json();
    expect(createdBody.task_id).toStartWith("tsk_");
    expect(createdBody.issue).toMatchObject({
      identifier: expect.any(String),
      issue_kind: "intake",
      source_issue_id: null,
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: agent.id,
    });
    const task = store.getTask(createdBody.task_id)!;
    expect(task.agentId).toBe(agent.id);
    expect(task.runtimeId).toBeNull();
    expect(task.issueId).toBeString();
    const issue = store.getIssue(task.issueId!)!;
    expect(issue.title).toBe("Create an issue for improving onboarding screenshots");
    expect(issue.projectId).toBe(project.id);
    expect(issue.issueKind).toBe("intake");
    expect(issue.sourceIssueId).toBeNull();
    expect(issue.assigneeType).toBe("agent");
    expect(issue.contextRefs[0]).toEqual({ type: "quick_create", prompt: "Create an issue for improving onboarding screenshots" });
    expect(task.prompt).toContain("Create one or more new execution issues");

    const taskToken = await store.createTaskAccessToken(task, "local");
    const generated = await app.request("/api/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${taskToken.token}`,
      },
      body: JSON.stringify({
        title: "Improve onboarding screenshots",
        description: "Refresh screenshots and add coverage.",
        project_id: project.id,
      }),
    });
    expect(generated.status).toBe(201);
    const generatedBody = await generated.json();
    expect(generatedBody).toMatchObject({
      issue_kind: "execution",
      source_issue_id: issue.id,
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: executor.id,
      status: "todo",
    });
    expect(store.listGeneratedIssues(issue.id).map((entry) => entry.id)).toEqual([generatedBody.id]);
    expect(store.listTasksForIssue(generatedBody.id)).toHaveLength(1);
    const linked = await app.request(`/api/issues/${issue.id}/generated-issues`);
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({
      total: 1,
      issues: [{ id: generatedBody.id, source_issue_id: issue.id }],
    });
    const duplicate = await app.request("/api/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${taskToken.token}`,
      },
      body: JSON.stringify({ title: "Improve onboarding screenshots", project_id: project.id }),
    });
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).id).toBe(generatedBody.id);
    expect(store.listGeneratedIssues(issue.id)).toHaveLength(1);
    expect(store.listTasksForIssue(generatedBody.id)).toHaveLength(1);
    const runtime = store.registerRuntime({
      id: "rt_quick_create",
      name: "Quick create runtime",
      provider: "any",
      workspaceId: "local",
      maxConcurrency: 2,
    });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "Created MUL execution issue." });
    expect(store.getIssue(issue.id)?.status).toBe("done");
    expect(store.getIssue(generatedBody.id)?.status).toBe("todo");

    const camelAgentQuickCreate = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: agent.id,
        prompt: "Camel agent should not queue",
      }),
    });
    expect(camelAgentQuickCreate.status).toBe(400);
    expect(await camelAgentQuickCreate.json()).toEqual({ error: "exactly one of agent_id or squad_id is required" });

    const camelProjectQuickCreate = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: agent.id,
        prompt: "Camel project should be ignored",
        projectId: project.id,
        workspaceId: "remote",
      }),
    });
    expect(camelProjectQuickCreate.status).toBe(202);
    const camelProjectQuickBody = await camelProjectQuickCreate.json();
    const camelProjectQuickTask = store.getTask(camelProjectQuickBody.task_id)!;
    const camelProjectQuickIssue = store.getIssue(camelProjectQuickTask.issueId!)!;
    expect(camelProjectQuickIssue.workspaceId).toBe("local");
    expect(camelProjectQuickIssue.projectId).toBeNull();
    const unscopedTask = store.getTaskWithAgent(camelProjectQuickTask.id)!;
    expect(unscopedTask.projectContexts.map((context) => context.project.id)).toEqual([project.id]);
    expect(unscopedTask.projectContexts[0]!.resources.every((resource) => resource.resourceType !== "local_directory")).toBe(true);
    expect(unscopedTask.repos.map((repo) => repo.url)).toEqual(["git@example.test:team/quick-project.git"]);

    const squadCreated = await app.request("/api/multiremi/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ squad_id: squad.id, prompt: "Plan squad handoff" }),
    });
    expect(squadCreated.status).toBe(202);
    const squadBody = await squadCreated.json();
    expect(squadBody.task.agentId).toBe(leader.id);
    expect(squadBody.issue.assigneeType).toBe("squad");
    expect(squadBody.task_id).toBe(squadBody.task.id);

    const badPrompt = await app.request("/api/issues/quick-create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id, prompt: "   " }),
    });
    expect(badPrompt.status).toBe(400);
    expect((await badPrompt.json()).error).toBe("prompt is required");
  });

  it("serves issue hierarchy and planning fields through API endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const project = store.createProject({ title: "API hierarchy" });

    const parentRes = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "API parent",
        project_id: project.id,
        priority: "high",
        due_date: "2026-06-10T12:00:00+08:00",
        acceptance_criteria: ["works"],
        context_refs: [{ type: "repo", url: "git@example.com:repo.git" }],
      }),
    });
    expect(parentRes.status).toBe(201);
    const parent = (await parentRes.json()).issue;

    const childRes = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "API child", parent_issue_id: parent.id, position: 3 }),
    });
    expect(childRes.status).toBe(201);
    const child = (await childRes.json()).issue;
    expect(child.parentIssueId).toBe(parent.id);
    expect(child.projectId).toBe(project.id);

    const updated = await app.request(`/api/multiremi/issues/${child.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", priority: "urgent", start_date: "2026-06-04T09:00:00+08:00" }),
    });
    expect(updated.status).toBe(200);
    expect((await updated.json()).issue.priority).toBe("urgent");

    const detail = await app.request(`/api/multiremi/issues/${parent.id}`);
    const detailBody = await detail.json();
    expect(detailBody.issue.dueDate).toBe("2026-06-10T04:00:00.000Z");
    expect(detailBody.issue.acceptanceCriteria).toEqual(["works"]);
    expect(detailBody.children.map((item: any) => item.id)).toEqual([child.id]);
    expect(detailBody.childProgress).toEqual({ parentIssueId: parent.id, total: 1, done: 1 });

    const compatChildren = await app.request(`/api/issues/${parent.id}/children`);
    const compatChildrenBody = await compatChildren.json();
    expect(compatChildrenBody.total).toBe(1);
    expect(compatChildrenBody.issues[0]).toMatchObject({
      id: child.id,
      workspace_id: "local",
      identifier: child.key,
      parent_issue_id: parent.id,
      created_at: child.createdAt,
    });
    expect(compatChildrenBody.issues[0].workspaceId).toBeUndefined();
    expect(compatChildrenBody.issues[0].key).toBeUndefined();
    expect(compatChildrenBody.issues[0].labels).toBeUndefined();

    const nativeChildren = await app.request(`/api/multiremi/issues/${parent.id}/children`);
    const nativeChildrenBody = await nativeChildren.json();
    expect(nativeChildrenBody.issues[0]).toMatchObject({
      id: child.id,
      workspaceId: "local",
      key: child.key,
      parentIssueId: parent.id,
      createdAt: child.createdAt,
    });
    expect(nativeChildrenBody.issues[0].workspace_id).toBeUndefined();
    expect(nativeChildrenBody.issues[0].identifier).toBeUndefined();

    const progress = await app.request("/api/issues/child-progress?workspaceId=local");
    expect((await progress.json()).progress).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);

    const remoteParent = store.createIssue({ title: "Remote API parent", workspaceId: "remote" });
    const remoteChild = store.createIssue({ title: "Remote API child", workspaceId: "remote", parentIssueId: remoteParent.id });

    const camelProgress = await app.request("/api/issues/child-progress?workspaceId=remote");
    expect((await camelProgress.json()).progress).toEqual([{ parentIssueId: parent.id, total: 1, done: 1 }]);
    const snakeProgress = await app.request("/api/issues/child-progress?workspace_id=remote");
    expect((await snakeProgress.json()).progress).toEqual([{ parentIssueId: remoteParent.id, total: 1, done: 0 }]);

    const camelBatchChildren = await app.request(`/api/issues/children?parentIds=${remoteParent.id}`);
    expect(await camelBatchChildren.json()).toEqual({ issues: [], total: 0 });
    const snakeBatchChildren = await app.request(`/api/issues/children?parent_ids=${remoteParent.id}`);
    const snakeBatchChildrenBody = await snakeBatchChildren.json();
    expect(snakeBatchChildrenBody.total).toBe(1);
    expect(snakeBatchChildrenBody.issues[0]).toMatchObject({
      id: remoteChild.id,
      workspace_id: "remote",
      identifier: remoteChild.key,
      parent_issue_id: remoteParent.id,
      created_at: remoteChild.createdAt,
    });
    expect(snakeBatchChildrenBody.issues[0].workspaceId).toBeUndefined();
    expect(snakeBatchChildrenBody.issues[0].key).toBeUndefined();
  });

  it("serves issue dependency endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const blocker = store.createIssue({ title: "API blocker" });
    const blocked = store.createIssue({ title: "API blocked" });

    const created = await app.request(`/api/issues/${blocked.id}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ depends_on_issue_id: blocker.id, type: "blocked_by" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.dependency).toMatchObject({
      workspace_id: "local",
      issue_id: blocked.id,
      depends_on_issue_id: blocker.id,
      type: "blocked_by",
      depends_on_issue: {
        id: blocker.id,
        workspace_id: "local",
        title: "API blocker",
      },
    });
    expect(createdBody.dependency.dependsOnIssueId).toBeUndefined();
    expect(createdBody.dependency.depends_on_issue.workspaceId).toBeUndefined();

    const compatListed = await app.request(`/api/issues/${blocker.id}/dependencies`);
    const compatListedBody = await compatListed.json();
    expect(compatListedBody.dependencies[0]).toMatchObject({
      id: createdBody.dependency.id,
      issue_id: blocked.id,
      depends_on_issue_id: blocker.id,
    });
    expect(compatListedBody.dependencies[0].issueId).toBeUndefined();

    const listed = await app.request(`/api/multiremi/issues/${blocker.id}/dependencies`);
    const listedBody = await listed.json();
    expect(listedBody.total).toBe(1);
    expect(listedBody.dependencies[0].dependsOnIssueId).toBe(blocker.id);

    const detail = await app.request(`/api/multiremi/issues/${blocked.id}`);
    expect((await detail.json()).dependencies[0].id).toBe(createdBody.dependency.id);

    const invalid = await app.request(`/api/issues/${blocked.id}/dependencies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid request body" });

    const deleted = await app.request(`/api/issues/${blocked.id}/dependencies/${createdBody.dependency.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ status: "ok" });
    expect(store.listIssueDependencies(blocked.id)).toEqual([]);
  });

  it("assigns issues through API endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Grace Hopper", email: "grace@example.com" });
    const app = createMultiremiApp({ store });

    const created = await app.request("/api/multiremi/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Assignable issue", assigneeId: "grace@example.com" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.issue.assigneeType).toBe("member");
    expect(createdBody.task).toBeNull();

    const assigned = await app.request(`/api/multiremi/issues/${createdBody.issue.id}/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeId: "cod", prompt: "Please implement" }),
    });
    expect(assigned.status).toBe(200);
    const assignedBody = await assigned.json();
    expect(assignedBody.issue.assigneeId).toBe(agent.id);
    expect(assignedBody.task.agentId).toBe(agent.id);
    expect(assignedBody.task.prompt).toBe("Please implement");

    const camelReassigned = await app.request(`/api/issues/${createdBody.issue.key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigneeId: "Grace Hopper" }),
    });
    expect(camelReassigned.status).toBe(200);
    const camelReassignedBody = await camelReassigned.json();
    expect(camelReassignedBody.assignee_type).toBe("agent");
    expect(camelReassignedBody.assignee_id).toBe(agent.id);

    const reassigned = await app.request(`/api/issues/${createdBody.issue.key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignee_id: "Grace Hopper" }),
    });
    const reassignedBody = await reassigned.json();
    expect(reassignedBody.assignee_type ?? reassignedBody.assigneeType).toBe("member");
    expect(reassignedBody.assignee_id ?? reassignedBody.assigneeId).toBe(member.id);
  });

  it("serves issue metadata endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Metadata API" });

    const set = await app.request(`/api/multiremi/issues/${issue.id}/metadata/pipeline_status`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "waiting_review" }),
    });
    expect(set.status).toBe(200);
    expect((await set.json()).metadata.pipeline_status).toBe("waiting_review");

    const listed = await app.request(`/api/multiremi/issues/${issue.id}/metadata`);
    expect((await listed.json()).metadata).toEqual({ pipeline_status: "waiting_review" });

    const other = store.createIssue({ title: "Other Metadata API" });
    store.setIssueMetadataKey(other.id, "pipeline_status", "done");
    const filtered = await app.request(`/api/issues?metadata=${encodeURIComponent(JSON.stringify({ pipeline_status: "waiting_review" }))}`);
    expect((await filtered.json()).issues.map((item: any) => item.id)).toEqual([issue.id]);

    const deleted = await app.request(`/api/multiremi/issues/${issue.id}/metadata/pipeline_status`, { method: "DELETE" });
    expect((await deleted.json()).metadata).toEqual({});
  });

  it("serves issue label endpoints", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store });
    const issue = store.createIssue({ title: "Label API", workspaceId: "local" });

    const created = await app.request("/api/multiremi/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Review", color: "3399FF", workspace_id: "local" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.label.color).toBe("#3399ff");

    const listed = await app.request("/api/multiremi/labels?workspaceId=local");
    expect((await listed.json()).total).toBe(1);

    const updated = await app.request(`/api/labels/${createdBody.label.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewed", color: "#22aa66" }),
    });
    const updatedBody = await updated.json();
    expect(updatedBody.name).toBe("Reviewed");
    expect(updatedBody.workspace_id).toBe("local");
    expect(updatedBody.workspaceId).toBeUndefined();

    const compatibilityDetail = await app.request(`/api/labels/${createdBody.label.id}`);
    const compatibilityDetailBody = await compatibilityDetail.json();
    expect(compatibilityDetailBody).toMatchObject({ id: createdBody.label.id, name: "Reviewed", workspace_id: "local" });
    expect(compatibilityDetailBody.label).toBeUndefined();

    const compatibilityList = await app.request("/api/labels?workspace_id=local");
    const compatibilityListBody = await compatibilityList.json();
    expect(compatibilityListBody.labels[0].workspace_id).toBe("local");
    expect(compatibilityListBody.labels[0].workspaceId).toBeUndefined();

    const remoteLabel = store.createLabel({ name: "Remote Label", color: "#112244", workspaceId: "remote" });
    const camelWorkspaceLabelList = await app.request("/api/labels?workspaceId=remote");
    const camelWorkspaceLabelListBody = await camelWorkspaceLabelList.json();
    expect(camelWorkspaceLabelListBody.labels.some((label: any) => label.id === remoteLabel.id)).toBe(false);
    const snakeWorkspaceLabelList = await app.request("/api/labels?workspace_id=remote");
    const snakeWorkspaceLabelListBody = await snakeWorkspaceLabelList.json();
    expect(snakeWorkspaceLabelListBody.labels.map((label: any) => label.id)).toEqual([remoteLabel.id]);

    const camelWorkspaceLabel = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Camel Workspace", color: "#445566", workspaceId: "remote" }),
    });
    const camelWorkspaceLabelBody = await camelWorkspaceLabel.json();
    expect(camelWorkspaceLabel.status).toBe(201);
    expect(camelWorkspaceLabelBody.workspace_id).toBe("local");

    const attached = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label_id: createdBody.label.id }),
    });
    expect(attached.status).toBe(200);
    const attachedBody = await attached.json();
    expect(attachedBody.labels[0].name).toBe("Reviewed");
    expect(attachedBody.labels[0].workspace_id).toBe("local");
    expect(attachedBody.labels[0].workspaceId).toBeUndefined();
    expect(attachedBody.total).toBeUndefined();

    const detail = await app.request(`/api/multiremi/issues/${issue.id}`);
    expect((await detail.json()).issue.labels[0].color).toBe("#22aa66");

    const issueLabels = await app.request(`/api/issues/${issue.id}/labels`);
    const issueLabelsBody = await issueLabels.json();
    expect(issueLabelsBody.labels[0].workspace_id).toBe("local");
    expect(issueLabelsBody.total).toBeUndefined();

    const missingLabelId = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingLabelId.status).toBe(400);
    expect(await missingLabelId.json()).toEqual({ error: "label_id is required" });

    const camelLabelId = await app.request(`/api/issues/${issue.id}/labels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ labelId: createdBody.label.id }),
    });
    expect(camelLabelId.status).toBe(400);
    expect(await camelLabelId.json()).toEqual({ error: "label_id is required" });

    const invalidLabelJson = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidLabelJson.status).toBe(400);
    expect(await invalidLabelJson.json()).toEqual({ error: "invalid request body" });
    const missingName = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ color: "#112233" }),
    });
    expect(missingName.status).toBe(400);
    expect(await missingName.json()).toEqual({ error: "name is required" });
    const invalidColor = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Invalid color", color: "blue" }),
    });
    expect(invalidColor.status).toBe(400);
    expect(await invalidColor.json()).toEqual({ error: "color must be a 6-digit hex value like #3b82f6" });
    const duplicate = await app.request("/api/labels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reviewed", color: "#334455" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: "a label with that name already exists" });

    const detached = await app.request(`/api/issues/${issue.id}/labels/${createdBody.label.id}`, {
      method: "DELETE",
    });
    expect((await detached.json()).labels).toHaveLength(0);
    const deleted = await app.request(`/api/labels/${createdBody.label.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const missing = await app.request(`/api/labels/${createdBody.label.id}`);
    expect(missing.status).toBe(404);
  });

  it("inherits project scope and default assignee for non-intake task creations and dispatches a task", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const executor = store.createAgent({ name: "Default executor", provider: "claude" });
    const worker = store.createAgent({ name: "Follow-up worker", provider: "codex" });
    const project = store.createProject({
      title: "Delivery project",
      defaultAssigneeType: "agent",
      defaultAssigneeId: executor.id,
    });
    const otherProject = store.createProject({ title: "Sibling project" });
    const sourceIssue = store.createIssue({
      title: "Execution parent",
      workspaceId: "local",
      projectId: project.id,
      status: "in_progress",
    });
    const task = store.createTask({
      workspaceId: "local",
      issueId: sourceIssue.id,
      agentId: worker.id,
      prompt: "follow up",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${taskToken.token}`,
    };

    // No project + no assignee: inherits the source issue's project, backfills
    // its default executor, and assign-on-create dispatches a task.
    const inherited = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Follow-up inherits scope" }),
    });
    expect(inherited.status).toBe(201);
    const inheritedBody = await inherited.json();
    expect(inheritedBody).toMatchObject({
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: executor.id,
    });
    expect(inheritedBody.issue_kind).not.toBe("intake");
    expect(inheritedBody.source_issue_id).toBeNull();
    expect(store.listTasksForIssue(inheritedBody.id)).toHaveLength(1);

    // Explicit assignee wins over the project default.
    const explicit = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Follow-up explicit assignee",
        project_id: project.id,
        assignee_type: "agent",
        assignee_id: worker.id,
      }),
    });
    expect(explicit.status).toBe(201);
    const explicitBody = await explicit.json();
    expect(explicitBody).toMatchObject({ assignee_type: "agent", assignee_id: worker.id });
    expect(store.listTasksForIssue(explicitBody.id)).toHaveLength(1);

    // Explicit null assignee opts out of inheritance: stays unassigned, no task.
    const unassigned = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Follow-up explicitly unassigned",
        project_id: project.id,
        assignee_type: null,
        assignee_id: null,
      }),
    });
    expect(unassigned.status).toBe(201);
    const unassignedBody = await unassigned.json();
    expect(unassignedBody.assignee_type).toBeNull();
    expect(unassignedBody.assignee_id).toBeNull();
    expect(store.listTasksForIssue(unassignedBody.id)).toHaveLength(0);

    // A non-intake creation may target another active project explicitly; the
    // requested project (without defaults) leaves the issue unassigned.
    const crossProject = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Follow-up other project", project_id: otherProject.id }),
    });
    expect(crossProject.status).toBe(201);
    const crossProjectBody = await crossProject.json();
    expect(crossProjectBody.project_id).toBe(otherProject.id);
    expect(crossProjectBody.assignee_id).toBeNull();

    // Human/API callers without a task token get the same backfill when they
    // send a project and omit the assignee fields entirely.
    const humanInherited = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Human create inherits default", project_id: project.id }),
    });
    expect(humanInherited.status).toBe(201);
    const humanInheritedBody = await humanInherited.json();
    expect(humanInheritedBody).toMatchObject({ assignee_type: "agent", assignee_id: executor.id });
    expect(store.listTasksForIssue(humanInheritedBody.id)).toHaveLength(1);
  });

  it("covers the intake matrix: project inheritance, explicit assignee, and explicit null opt-out", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const executor = store.createAgent({ name: "Intake default executor", provider: "claude" });
    const worker = store.createAgent({ name: "Intake worker", provider: "codex" });
    const project = store.createProject({
      title: "Intake project",
      defaultAssigneeType: "agent",
      defaultAssigneeId: executor.id,
    });
    const otherProject = store.createProject({ title: "Out-of-scope project" });
    const intakeIssue = store.createIssue({
      title: "Intake triage",
      workspaceId: "local",
      projectId: project.id,
      issueKind: "intake",
    });
    const task = store.createTask({
      workspaceId: "local",
      issueId: intakeIssue.id,
      agentId: worker.id,
      prompt: "triage",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${taskToken.token}`,
    };

    // No project + no assignee: inherits the intake project, backfills its
    // default executor, and dispatches a task.
    const inherited = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Generated inherits scope" }),
    });
    expect(inherited.status).toBe(201);
    const inheritedBody = await inherited.json();
    expect(inheritedBody).toMatchObject({
      issue_kind: "execution",
      source_issue_id: intakeIssue.id,
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: executor.id,
      status: "todo",
    });
    expect(store.listTasksForIssue(inheritedBody.id)).toHaveLength(1);

    // Explicit project (same scope) + no assignee: same backfill.
    const explicitProject = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Generated explicit project", project_id: project.id }),
    });
    expect(explicitProject.status).toBe(201);
    const explicitProjectBody = await explicitProject.json();
    expect(explicitProjectBody).toMatchObject({
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: executor.id,
    });
    expect(store.listTasksForIssue(explicitProjectBody.id)).toHaveLength(1);

    // No project + explicit assignee: the explicit executor wins over the default.
    const explicitAssignee = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Generated explicit assignee",
        assignee_type: "agent",
        assignee_id: worker.id,
      }),
    });
    expect(explicitAssignee.status).toBe(201);
    const explicitAssigneeBody = await explicitAssignee.json();
    expect(explicitAssigneeBody).toMatchObject({
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: worker.id,
    });
    expect(store.listTasksForIssue(explicitAssigneeBody.id)).toHaveLength(1);

    // No project + explicit null assignee: opts out of inheritance, no task.
    const unassigned = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Generated explicitly unassigned",
        assignee_type: null,
        assignee_id: null,
      }),
    });
    expect(unassigned.status).toBe(201);
    const unassignedBody = await unassigned.json();
    expect(unassignedBody.assignee_type).toBeNull();
    expect(unassignedBody.assignee_id).toBeNull();
    expect(store.listTasksForIssue(unassignedBody.id)).toHaveLength(0);

    // Explicit project outside the intake scope is rejected.
    const crossProject = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Generated out of scope", project_id: otherProject.id }),
    });
    expect(crossProject.status).toBe(400);
    expect(await crossProject.json()).toEqual({
      error: "Generated issues must stay in the intake project's scope",
    });
  });

  it("lets a projectless intake pick a project explicitly but rejects omitting it", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const executor = store.createAgent({ name: "Projectless intake executor", provider: "claude" });
    const worker = store.createAgent({ name: "Projectless intake worker", provider: "codex" });
    const project = store.createProject({
      title: "Selectable project",
      defaultAssigneeType: "agent",
      defaultAssigneeId: executor.id,
    });
    const intakeIssue = store.createIssue({
      title: "Projectless intake",
      workspaceId: "local",
      issueKind: "intake",
    });
    const task = store.createTask({
      workspaceId: "local",
      issueId: intakeIssue.id,
      agentId: worker.id,
      prompt: "triage",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store });
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${taskToken.token}`,
    };

    // The requested project binds the generated issue and supplies its default.
    const chosen = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Generated with chosen project", project_id: project.id }),
    });
    expect(chosen.status).toBe(201);
    const chosenBody = await chosen.json();
    expect(chosenBody).toMatchObject({
      project_id: project.id,
      assignee_type: "agent",
      assignee_id: executor.id,
      source_issue_id: intakeIssue.id,
    });
    expect(store.listTasksForIssue(chosenBody.id)).toHaveLength(1);

    // Omitting the project while active projects exist stays an error.
    const missingProject = await app.request("/api/issues", {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Generated without project" }),
    });
    expect(missingProject.status).toBe(400);
    expect(await missingProject.json()).toEqual({
      error: "project_id is required when active projects are available",
    });
  });

  it("requires a project for task creations when the workspace has active projects", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const worker = store.createAgent({ name: "Projectless worker", provider: "codex" });
    store.createProject({ title: "Some active project" });
    const sourceIssue = store.createIssue({ title: "Projectless parent", workspaceId: "local" });
    const task = store.createTask({
      workspaceId: "local",
      issueId: sourceIssue.id,
      agentId: worker.id,
      prompt: "follow up",
    });
    const taskToken = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store });

    const missingProject = await app.request("/api/issues", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${taskToken.token}`,
      },
      body: JSON.stringify({ title: "Orphan follow-up" }),
    });
    expect(missingProject.status).toBe(400);
    expect(await missingProject.json()).toEqual({
      error: "project_id is required when active projects are available",
    });
  });

  it("reports the dispatch outcome on create instead of failing silently", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Dispatch agent", provider: "claude" });
    const member = store.createWorkspaceMember({ name: "Dispatch member" });
    const emptySquad = store.createSquad({ name: "Empty squad" });
    const app = createMultiremiApp({ store });
    const create = (body: Record<string, unknown>) =>
      app.request("/api/issues", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    // 1. No assignee: created, explicitly not dispatched, no failure activity.
    const unassigned = await create({ title: "Nobody owns this" });
    expect(unassigned.status).toBe(201);
    const unassignedBody = await unassigned.json();
    expect(unassignedBody).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "no_assignee",
      task_id: null,
    });
    expect(unassignedBody.dispatch_error).toBeUndefined();
    expect(store.listIssueActivity(unassignedBody.id).map((activity) => activity.type)).not.toContain("dispatch_skipped");

    // 2. Assignee resolves to no runnable agent (squad with no agent members):
    //    the skip reason lands in the response AND on the issue activity feed.
    const squadIssue = await create({ title: "Squad has no agents", assignee_type: "squad", assignee_id: emptySquad.id });
    expect(squadIssue.status).toBe(201);
    const squadBody = await squadIssue.json();
    expect(squadBody).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "no_runnable_agent",
      task_id: null,
    });
    expect(squadBody.dispatch_error).toContain("No runnable agent");
    const skipActivity = store.listIssueActivity(squadBody.id).find((activity) => activity.type === "dispatch_skipped");
    expect(skipActivity).toBeDefined();
    expect(skipActivity!.data).toMatchObject({
      reason: "no_runnable_agent",
      assignee_type: "squad",
      assignee_id: emptySquad.id,
    });
    // The skip is user-visible on the timeline endpoint, not just in the store.
    const timeline = await app.request(`/api/issues/${squadBody.id}/timeline`);
    const timelineBody = await timeline.json();
    const entries = Array.isArray(timelineBody) ? timelineBody : timelineBody.entries;
    expect(entries.some((entry: any) => entry.action === "dispatch_skipped")).toBe(true);

    // 3. Member assignee: no task by design (inbox notification instead).
    const memberIssue = await create({ title: "Human work", assignee_type: "member", assignee_id: member.id });
    expect(memberIssue.status).toBe(201);
    expect(await memberIssue.json()).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "member_assignee",
      task_id: null,
    });

    // 4. Backlog is a parking lot: assignment stands, dispatch waits.
    const backlogIssue = await create({ title: "Parked", status: "backlog", assignee_type: "agent", assignee_id: agent.id });
    expect(backlogIssue.status).toBe(201);
    expect(await backlogIssue.json()).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "backlog_status",
      task_id: null,
    });

    // 5. Runnable agent: dispatched, with the task id in the response.
    const dispatched = await create({ title: "Agent work", assignee_type: "agent", assignee_id: agent.id });
    expect(dispatched.status).toBe(201);
    const dispatchedBody = await dispatched.json();
    const dispatchedTaskId = dispatchedBody.task_id;
    expect(dispatchedBody).toMatchObject({
      dispatch_status: "dispatched",
      dispatch_skipped_reason: null,
    });
    expect(typeof dispatchedTaskId).toBe("string");
    expect(store.getTask(dispatchedTaskId)?.issueId).toBe(dispatchedBody.id);
  });

  it("reports a generic assignment failure as assign_failed with a dispatch_skipped activity", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Broken dispatch agent", provider: "claude" });
    const app = createMultiremiApp({ store });
    // Force the non-"No runnable agent" error path: any store-level assignment
    // failure (races, integrity checks) must surface, not just the known one.
    store.assignIssue = () => {
      throw new Error("Simulated dispatch outage");
    };

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Doomed dispatch", assignee_type: "agent", assignee_id: agent.id }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "assign_failed",
      dispatch_error: "Simulated dispatch outage",
      task_id: null,
    });
    const skipActivity = store.listIssueActivity(body.id).find((activity) => activity.type === "dispatch_skipped");
    expect(skipActivity).toBeDefined();
    expect(skipActivity!.data).toMatchObject({ reason: "assign_failed", error: "Simulated dispatch outage" });
  });

  it("keeps the dispatch-outcome contract on the idempotent generated-issue replay", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Intake agent", provider: "claude" });
    const intake = store.createIssue({ title: "Intake source", workspaceId: "local", issueKind: "intake" });
    const intakeTask = store.createTask({
      workspaceId: "local",
      issueId: intake.id,
      agentId: agent.id,
      prompt: "triage",
    });
    const taskToken = await store.createTaskAccessToken(intakeTask, "local");
    const app = createMultiremiApp({ store });
    const create = (body: Record<string, unknown>) =>
      app.request("/api/issues", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${taskToken.token}`,
        },
        body: JSON.stringify(body),
      });

    // Unassigned generated issue: the replay must repeat the explicit
    // "skipped" outcome, not fall back to the bare compatibility shape.
    const first = await create({ title: "Generated unassigned" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ dispatch_status: "skipped", dispatch_skipped_reason: "no_assignee", task_id: null });
    const replay = await create({ title: "Generated unassigned" });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json();
    expect(replayBody.id).toBe(firstBody.id);
    expect(replayBody).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "no_assignee",
      task_id: null,
    });

    // Dispatched generated issue: the replay reports the existing task.
    const assigned = await create({ title: "Generated assigned", assignee_type: "agent", assignee_id: agent.id });
    expect(assigned.status).toBe(201);
    const assignedBody = await assigned.json();
    const assignedTaskId = assignedBody.task_id;
    expect(assignedBody.dispatch_status).toBe("dispatched");
    expect(typeof assignedTaskId).toBe("string");
    const assignedReplay = await create({ title: "Generated assigned", assignee_type: "agent", assignee_id: agent.id });
    expect(assignedReplay.status).toBe(200);
    const assignedReplayBody = await assignedReplay.json();
    expect(assignedReplayBody.id).toBe(assignedBody.id);
    expect(assignedReplayBody).toMatchObject({
      dispatch_status: "dispatched",
      dispatch_skipped_reason: null,
      task_id: assignedTaskId,
    });

    // Unassigning cancels the issue's task; the replay must flip back to an
    // explicit "skipped" instead of resurfacing the cancelled task as
    // dispatched.
    store.assignIssue(assignedBody.id, {});
    expect(store.getTask(assignedTaskId)?.status).toBe("cancelled");
    const unassignedReplay = await create({ title: "Generated assigned", assignee_type: "agent", assignee_id: agent.id });
    expect(unassignedReplay.status).toBe(200);
    const unassignedReplayBody = await unassignedReplay.json();
    expect(unassignedReplayBody.id).toBe(assignedBody.id);
    expect(unassignedReplayBody).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "no_assignee",
      task_id: null,
    });

    // A generic assignment failure must replay as assign_failed with its
    // original error (recovered from the dispatch_skipped activity), not
    // degrade into no_runnable_agent.
    const realAssignIssue = store.assignIssue.bind(store);
    store.assignIssue = () => {
      throw new Error("Simulated dispatch outage");
    };
    const failed = await create({ title: "Generated failing", assignee_type: "agent", assignee_id: agent.id });
    store.assignIssue = realAssignIssue;
    expect(failed.status).toBe(201);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({ dispatch_status: "skipped", dispatch_skipped_reason: "assign_failed" });
    const failedReplay = await create({ title: "Generated failing", assignee_type: "agent", assignee_id: agent.id });
    expect(failedReplay.status).toBe(200);
    const failedReplayBody = await failedReplay.json();
    expect(failedReplayBody.id).toBe(failedBody.id);
    expect(failedReplayBody).toMatchObject({
      dispatch_status: "skipped",
      dispatch_skipped_reason: "assign_failed",
      dispatch_error: "Simulated dispatch outage",
      task_id: null,
    });
  });
});
