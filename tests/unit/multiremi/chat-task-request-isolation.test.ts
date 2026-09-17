import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

async function fixture(topic = false) {
  const store = createLocalStore();
  const agent = store.createAgent({ name: "Chat worker", provider: "codex" });
  const executor = store.createAgent({ name: "Project executor", provider: "claude" });
  const project = store.createProject({
    title: "Former Chat project",
    defaultAssigneeType: "agent",
    defaultAssigneeId: executor.id,
  });
  const issue = store.createIssue({ title: "Former Chat Issue", projectId: project.id, issueKind: "intake" });
  const defaultSession = store.getOrCreateDefaultIssueSession(issue.id);
  const session = store.createIssueSession(issue.id, { title: "Original task session" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "local" });
  if (topic) bindFeishuTopicFixture(store, db!, chat.id, issue.id);
  const task = store.createTask({
    agentId: agent.id,
    chatSessionId: chat.id,
    prompt: "Continue the conversation",
    ...(topic ? { issueId: issue.id, issueSessionId: session.id } : {}),
  });
  // Model the persisted audit row of a task already running when the migration
  // detaches its ordinary Chat. The task credential remains valid for this run.
  db!.run(`UPDATE multiremi_tasks SET status = 'running', issue_id = ?, issue_session_id = ? WHERE id = ?`,
    [issue.id, session.id, task.id]);
  const token = await store.createTaskAccessToken(store.getTask(task.id)!, "local");
  const app = createMultiremiApp({ store, authToken: "request-isolation-root" });
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  return { store, app, headers, agent, executor, project, issue, defaultSession, session, chat, task };
}

describe("Chat task request isolation", () => {
  it("returns 400 for ordinary Chat plus an explicit or comment-derived Issue without creating a task", async () => {
    const { store, app, headers, agent, issue, chat } = await fixture();
    const comment = store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Issue trigger" });
    const before = store.listTasks().length;
    for (const input of [
      { issueId: issue.id },
      { triggerCommentId: comment.id },
      { trigger_comment_id: comment.id },
    ]) {
      const response = await app.request("/api/multiremi/tasks", {
        method: "POST", headers,
        body: JSON.stringify({ agentId: agent.id, chatSessionId: chat.id, prompt: "Try attaching an Issue", ...input }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Only Feishu Issue topics can create Chat transport tasks with an Issue" });
      expect(store.listTasks()).toHaveLength(before);
    }
  });

  it("keeps the old running audit row but exposes no Issue or Issue Session through CLI context", async () => {
    const { store, app, headers, issue, session, chat, task } = await fixture();
    expect(store.getTask(task.id)).toMatchObject({ status: "running", issueId: issue.id, issueSessionId: session.id });

    const response = await app.request("/api/cli/context", { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).current).toMatchObject({
      task: { id: task.id, status: "running", issue_id: null, session_id: null, chat_id: chat.id },
      issue: null,
      session: null,
      project: null,
      chat: { id: chat.id },
    });
    expect(store.getTask(task.id)).toMatchObject({ issueId: issue.id, issueSessionId: session.id });
  });

  it("does not inherit the old intake Issue, project, or project assignee when the running Chat creates an Issue", async () => {
    const { store, app, headers, task } = await fixture();
    for (const input of [{}, { project_id: null }]) {
      const response = await app.request("/api/issues", {
        method: "POST", headers,
        body: JSON.stringify({ title: "Independent new Issue", ...input }),
      });
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({ project_id: null, source_issue_id: null, assignee_type: null, assignee_id: null });
      expect(store.getIssue(body.id)?.contextRefs).toEqual([]);
      expect(store.listTasksForIssue(body.id)).toHaveLength(0);
    }
    expect(store.getTask(task.id)?.status).toBe("running");
  });

  it("still honors an explicitly selected project from an ordinary Chat", async () => {
    const { app, headers, project, executor } = await fixture();
    const response = await app.request("/api/issues", {
      method: "POST", headers,
      body: JSON.stringify({ title: "Explicit project request", project_id: project.id }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      project_id: project.id, source_issue_id: null, assignee_type: "agent", assignee_id: executor.id,
    });
  });

  it("does not reuse the old Issue Session for an explicit comment", async () => {
    const { app, headers, issue, defaultSession, session } = await fixture();
    const response = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST", headers, body: JSON.stringify({ content: "An explicit new comment from Chat" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.issue_session_id).toBe(defaultSession.id);
    expect(body.issue_session_id).not.toBe(session.id);
  });

  it("cannot reuse the old Issue project as implicit knowledge write scope", async () => {
    const { app, headers, project } = await fixture();
    const response = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST", headers,
      body: JSON.stringify({ kind: "memory", title: "Old scope", body: "Do not inherit Issue authority" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "task knowledge target does not match its issue project" });
  });

  it("preserves Issue context and project inheritance for a real Feishu Issue topic", async () => {
    const { store, app, headers, issue, session, project, executor, chat, task } = await fixture(true);
    const context = await app.request("/api/cli/context", { headers });
    expect(context.status).toBe(200);
    expect((await context.json()).current).toMatchObject({
      task: { id: task.id, issue_id: issue.id, session_id: session.id, chat_id: chat.id },
      issue: { id: issue.id }, session: { id: session.id }, project: { id: project.id },
    });

    const response = await app.request("/api/issues", {
      method: "POST", headers, body: JSON.stringify({ title: "A topic follow-up" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      project_id: project.id, source_issue_id: issue.id, assignee_type: "agent", assignee_id: executor.id,
    });

    const comment = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST", headers, body: JSON.stringify({ content: "Topic comment stays on its session" }),
    });
    expect(comment.status).toBe(201);
    expect((await comment.json()).issue_session_id).toBe(session.id);

    const knowledge = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST", headers, body: JSON.stringify({ kind: "memory", title: "Topic finding", body: "Scoped to the topic Issue" }),
    });
    expect(knowledge.status).toBe(202);
    const knowledgeBody = await knowledge.json();
    expect(store.getKnowledgeSubmission(knowledgeBody.submission_id)?.sourceIssueId).toBe(issue.id);
  });

  it("accepts matching Feishu topic transport tasks and rejects a different Issue with 400", async () => {
    const { store, app, headers, agent, chat, issue } = await fixture(true);
    const other = store.createIssue({ title: "Unrelated Issue" });
    for (const [issueId, status] of [[issue.id, 201], [other.id, 400]] as const) {
      const before = store.listTasks().length;
      const response = await app.request("/api/multiremi/tasks", {
        method: "POST", headers,
        body: JSON.stringify({ agentId: agent.id, chatSessionId: chat.id, issueId, prompt: "Topic transport" }),
      });
      expect(response.status).toBe(status);
      expect(store.listTasks()).toHaveLength(before + (status === 201 ? 1 : 0));
      if (status === 201) expect((await response.json()).task).toMatchObject({ issueId, chatSessionId: chat.id });
    }
  });
});
