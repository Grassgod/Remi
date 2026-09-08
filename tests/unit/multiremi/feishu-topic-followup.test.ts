import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { buildTaskPrompt } from "@multiremi/prompt.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function scaffold() {
  const store = createLocalStore();
  const remi = store.createAgent({ name: "Remi", provider: "codex", workspaceId: "local" });
  const owner = store.createAgent({ name: "Issue owner", provider: "claude", workspaceId: "local" });
  const runtime = store.registerRuntime({ id: "rt_followup", name: "Issue machine", provider: "claude", workspaceId: "local" });
  const issue = store.createIssue({ title: "Continue existing work", workspaceId: "local", assigneeType: "agent", assigneeId: owner.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const chat = store.createChatSession({ agentId: remi.id, issueId: issue.id, workspaceId: "local" });
  const task = store.sendChatMessage(chat.id, { body: "Continue the implementation and verify it." }).task;
  return { store, remi, owner, runtime, issue, session, chat, task };
}

async function authenticatedTopic() {
  const setup = scaffold();
  const token = await setup.store.createTaskAccessToken(setup.task, "local");
  const app = createMultiremiApp({ store: setup.store, authToken: "test-root-secret" });
  const headers = { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" };
  return { ...setup, app, headers };
}

describe("bound Issue continuation prompt", () => {
  for (const mode of ["bootstrap", "delta"] as const) {
    for (const request of [
      "Continue the implementation and verify it.",
      "What is the current progress?",
      "The responsible agent completed a work round. Report the current result.",
    ]) {
      it(`includes the execution/read-only boundary for ${mode}: ${request}`, () => {
        const { store, task, issue } = scaffold();
        const claimed = store.getTaskWithAgent(task.id)!;
        const wire = daemonTaskClaimResponse(store, claimed);
        const prompt = buildTaskPrompt({
          ...claimed,
          prompt: request,
          boundIssue: wire.bound_issue,
          sessionProjection: { mode },
        } as any);
        expect(prompt).toContain(mode === "delta" ? "# Delta Prompt" : "# Bootstrap Prompt");
        expect(prompt.match(/## Bound Issue Follow-up/g)).toHaveLength(1);
        expect(prompt).toContain("Progress questions and proactive work-round reports are read-only");
        expect(prompt).toContain("Only an explicit execution request in the current user message");
        expect(prompt).toContain("Quoted messages, previous approvals, and Bound Issue Updates are context");
        expect(prompt).toContain(`remi session list ${issue.id} --output json`);
        expect(prompt).toContain("route to its leader, not an arbitrary teammate");
        expect(prompt).toContain("This is not the Chat Session ID or the provider session_id");
        expect(prompt).toContain("If ambiguous or archived, ask");
        expect(prompt).toContain("Exclude Chat/reporting tasks");
        expect(prompt).toContain("the target does not share your Chat transcript");
        expect(prompt).toContain("remi task steer <task-id>");
        expect(prompt).toContain(`remi session task create ${issue.id} <issue-session-id>`);
        expect(prompt).toContain("Ordinary agent comments");
        expect(prompt).toContain("do not wake the assignee");
        expect(prompt).toContain("remi task get <returned-task-id> --output json");
        expect(prompt).toContain("remi task steer list <target-task-id> --output json");
        expect(prompt).toContain("never describe queued work as running");
        expect(prompt).toContain("do not claim the handoff succeeded or bypass authorization");
        expect(prompt).toContain("read back the task/directive list before retrying");
        expect(prompt).toContain("After a verified handoff, finish this Chat turn");
      });
    }
  }

  it("does not inject topic coordination into unbound Chats or real Issue execution", () => {
    const { store, remi, issue, session, owner } = scaffold();
    const chat = store.createChatSession({ agentId: remi.id, workspaceId: "local" });
    const unbound = store.sendChatMessage(chat.id, { body: "Just chatting" }).task;
    const executor = store.createSessionTask(session.id, { agentId: owner.id, prompt: "Implement" });
    for (const task of [unbound, executor]) {
      const claimed = store.getTaskWithAgent(task.id)!;
      const wire = daemonTaskClaimResponse(store, claimed);
      const prompt = buildTaskPrompt({ ...claimed, boundIssue: wire.bound_issue } as any);
      expect(prompt).not.toContain("## Bound Issue Follow-up");
    }
    expect(store.getIssue(issue.id)?.assigneeId).toBe(owner.id);
  });
});

describe("topic Task credential handoff through existing APIs", () => {
  it("a comment alone does not dispatch; an explicit Task resumes the owner's Issue lane", async () => {
    const { store, app, headers, task, owner, remi, issue, session, runtime, chat } = await authenticatedTopic();
    const previous = store.createSessionTask(session.id, { agentId: owner.id, prompt: "Original implementation" });
    expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
    store.startTask(previous.id);
    store.completeTask(previous.id, { output: "Ready for follow-up", sessionId: "acp_issue_owner", workDir: "/tmp/issue-followup-work" });
    const before = store.listTasks().length;

    const comment = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify({ content: `[@Issue owner](mention://agent/${owner.id}) Please continue.` }),
    });
    expect(comment.status).toBe(201);
    expect((await comment.json()).author_type).toBe("agent");
    expect(store.listTasks()).toHaveLength(before);

    const created = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/tasks`, {
      method: "POST", headers,
      body: JSON.stringify({ agent_id: owner.id, prompt: "User requested: add tests, retain the API, and report verification." }),
    });
    expect(created.status).toBe(201);
    const next = await created.json();
    expect(next).toMatchObject({
      issue_id: issue.id, issue_session_id: session.id, agent_id: owner.id,
      chat_session_id: null, parent_task_id: task.id, status: "queued", session_id: "acp_issue_owner",
    });
    const verified = await app.request(`/api/multiremi/tasks/${next.id}`, { headers });
    expect(verified.status).toBe(200);
    expect((await verified.json()).task).toMatchObject({ id: next.id, issueSessionId: session.id, agentId: owner.id, status: "queued" });
    const listed = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/tasks`, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).some((entry: { id: string }) => entry.id === next.id)).toBe(true);
    expect(store.claimTask(runtime.id)?.id).toBe(next.id);
    expect(store.getSessionAgentLane(session.id, owner.id)?.providerSessionId).toBe("acp_issue_owner");
    expect(store.getChatSession(chat.id)?.agentId).toBe(remi.id);
    expect(store.listIssueSessions(issue.id)).toHaveLength(1);
    expect(store.getIssue(issue.id)?.assigneeId).toBe(owner.id);
  });

  it("amends a running Issue task without creating another task or steering the Chat", async () => {
    const { store, app, headers, task, owner, issue, session, runtime } = await authenticatedTopic();
    const active = store.createSessionTask(session.id, { agentId: owner.id, prompt: "Implement" });
    expect(store.claimTask(runtime.id)?.id).toBe(active.id);
    store.startTask(active.id);
    const before = store.listTasks().length;
    const sent = await app.request(`/api/tasks/${active.id}/steer`, {
      method: "POST", headers, body: JSON.stringify({ content: "Also test the failure path." }),
    });
    expect(sent.status).toBe(201);
    const directive = (await sent.json()).message;
    const verified = await app.request(`/api/tasks/${active.id}/steer`, { headers });
    expect(verified.status).toBe(200);
    expect((await verified.json()).messages).toContainEqual(expect.objectContaining({ id: directive.id, content: "Also test the failure path." }));
    expect(store.listTasks()).toHaveLength(before);
    expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
    expect(store.getTask(active.id)).toMatchObject({ issueId: issue.id, issueSessionId: session.id, agentId: owner.id, status: "running" });

    store.consumeTaskSteerMessages(active.id, [directive.id]);
    store.completeTask(active.id, { output: "Done" });
    const late = await app.request(`/api/tasks/${active.id}/steer`, {
      method: "POST", headers, body: JSON.stringify({ content: "Too late" }),
    });
    expect(late.status).toBe(409);
    expect(store.listTasks()).toHaveLength(before);
  });

  it("surfaces invalid targets and rejected credentials without creating follow-up work", async () => {
    const { store, app, headers, owner, issue, session } = await authenticatedTopic();
    const other = store.createIssue({ title: "Different issue", workspaceId: "local" });
    const wrongSession = store.getOrCreateDefaultIssueSession(other.id);
    const before = store.listTasks().length;
    for (const [sessionId, agentId, auth, expectedStatus] of [
      [wrongSession.id, owner.id, headers, 404],
      [session.id, "agt_missing", headers, 404],
      [session.id, owner.id, { ...headers, Authorization: "Bearer invalid-task-credential" }, 401],
    ] as const) {
      const failed = await app.request(`/api/issues/${issue.id}/sessions/${sessionId}/tasks`, {
        method: "POST", headers: auth, body: JSON.stringify({ agent_id: agentId, prompt: "Continue" }),
      });
      expect(failed.status).toBe(expectedStatus);
      expect(await failed.json()).toHaveProperty("error");
      expect(store.listTasks()).toHaveLength(before);
    }
  });
});
