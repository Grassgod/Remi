import { createResponsibleTestIssue } from './helpers.js';
import { issueMessagesPath, requestMessageBody, taskRequestPath, sentTask, mutateExecutionFixture } from "./unified-test-paths.js";
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
  const issue = createResponsibleTestIssue(store, { title: "Former Chat Issue", projectId: project.id, issueKind: "intake" });
  const defaultSession = store.getOrCreateDefaultIssueSession(issue.id);
  const session = store.createIssueSession(issue.id, { title: "Original task session" });
  const chat = store.createChatSession({ agentId: agent.id, creatorId: "local" });
  if (topic) bindFeishuTopicFixture(store, db!, chat.id, issue.id);
  const task = store.createTask({
    agentId: agent.id,
    chatSessionId: chat.id,
    prompt: "Continue the conversation",
    ...(topic ? { issueId: issue.id } : {}),
    conversationSessionId: chat.id,
  });
  // Model the persisted audit row of a task already running when the migration
  // detaches its ordinary Chat. The task credential remains valid for this run.
  // A retained Chat turn has one canonical session; its old Issue is audit data.
  db!.run("UPDATE multiremi_turns SET status='running',issue_id=?,session_id=? WHERE current_attempt_id=?", [issue.id,chat.id,task.id]);
  db!.run("UPDATE multiremi_turn_attempts SET status='running' WHERE id=?",[task.id]);
  const token = await store.createTaskAccessToken(store.getTask(task.id)!, "local");
  const app = createMultiremiApp({ store, authToken: "request-isolation-root" });
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  return { store, app, headers, agent, executor, project, issue, defaultSession, session, chat, task };
}

describe("Chat task request isolation", () => {
  it("uses the Chat conversation and ignores a body-supplied Issue without creating a turn", async () => {
    const { store, app, headers, agent, issue, chat } = await fixture();
    const before = store.listTasks().length;
    const response = await app.request(taskRequestPath(store, { chatSessionId: chat.id, issueId: issue.id }), {
      method: "POST", headers,
      body: JSON.stringify(requestMessageBody(store, { agentId: agent.id, chatSessionId: chat.id, prompt: "Try attaching an Issue", issueId: issue.id })),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).message).toMatchObject({session_id:chat.id,wake_reason:"self"});
    expect(store.listTasks()).toHaveLength(before);
  });

  it("ignores a body-supplied trigger comment instead of deriving an Issue from it", async () => {
    const { store, app, headers, agent, issue, chat } = await fixture();
    // MUL-448: `trigger_comment_id` is server-derived (the mention dispatcher
    // calls the repo directly), so the public task route strips it. That also
    // removes the old path where a body could pull an Issue into a Chat task.
    const comment = store.createIssueComment(issue.id, { authorType: "member", authorId: "local", body: "Issue trigger" });
    for (const spelling of ["triggerCommentId", "trigger_comment_id"] as const) {
      const response = await app.request(taskRequestPath(store, { chatSessionId: chat.id }), {
        method: "POST", headers,
        body: JSON.stringify(requestMessageBody(store, {
          agentId: agent.id,
          chatSessionId: chat.id,
          prompt: "Try attaching an Issue",
          [spelling]: comment.id,
        })),
      });
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result.message).toMatchObject({session_id:chat.id,wake_reason:"self"});
      expect(result.message.reply_to_id).toBeNull();
      expect(result.turn_id).toBeUndefined();
    }
  });

  it("keeps the old running audit row but exposes no Issue or Issue Session through CLI context", async () => {
    const { store, app, headers, issue, session, chat, task } = await fixture();
    expect(store.getTask(task.id)).toMatchObject({ status: "running", issueId: issue.id, issueSessionId: null });

    const response = await app.request("/api/cli/context", { headers });
    expect(response.status).toBe(200);
    expect((await response.json()).current).toMatchObject({
      task: { id: task.id, status: "running", issue_id: null, session_id: null, chat_id: chat.id },
      issue: null,
      session: null,
      project: null,
      chat: { id: chat.id },
    });
    expect(store.getTask(task.id)).toMatchObject({ issueId: issue.id, issueSessionId: null });
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
    const { store, app, headers, issue, defaultSession, session } = await fixture();
    const response = await app.request(issueMessagesPath(store, issue.id), {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { content: "An explicit new comment from Chat" }, { type: "role", ref: "issue_owner" })),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message.session_id).toBe(defaultSession.id);
    expect(body.message.session_id).not.toBe(session.id);
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
      task: { id: task.id, issue_id: issue.id, session_id: null, chat_id: chat.id },
      issue: { id: issue.id }, session: null, project: { id: project.id },
    });

    const response = await app.request("/api/issues", {
      method: "POST", headers, body: JSON.stringify({ title: "A topic follow-up" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      project_id: project.id, source_issue_id: issue.id, assignee_type: "agent", assignee_id: executor.id,
    });

    const comment = await app.request(issueMessagesPath(store, issue.id), {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { content: "Topic comment stays on its session" }, { type: "role", ref: "issue_owner" })),
    });
    expect(comment.status).toBe(200);
    expect((await comment.json()).message.session_id).toBe(store.getOrCreateDefaultIssueSession(issue.id).id);

    const knowledge = await app.request(`/api/projects/${project.id}/docs`, {
      method: "POST", headers, body: JSON.stringify({ kind: "memory", title: "Topic finding", body: "Scoped to the topic Issue" }),
    });
    expect(knowledge.status).toBe(202);
    const knowledgeBody = await knowledge.json();
    expect(store.getKnowledgeSubmission(knowledgeBody.submission_id)?.sourceIssueId).toBe(issue.id);
  });

  it("ignores transport Issue overrides and keeps the persisted Feishu topic binding", async () => {
    const { store, app, headers, agent, chat, issue, task } = await fixture(true);
    const other = createResponsibleTestIssue(store, { title: "Unrelated Issue" });
    for (const issueId of [issue.id, other.id]) {
      const before = store.listTasks().length;
      const response = await app.request(`/api/sessions/${chat.id}/messages`, {
        method: "POST",headers,
        body:JSON.stringify(requestMessageBody(store,{agentId:agent.id,issueId,prompt:"Topic transport"})),
      });
      expect(response.status).toBe(200);
      expect((await response.json()).message).toMatchObject({session_id:chat.id,wake_reason:"self"});
      expect(store.listTasks()).toHaveLength(before);
      expect(store.getTask(task.id)?.issueId).toBe(issue.id);
    }
  });
});
