import { createResponsibleTestIssue } from './helpers.js';
import { attemptMessagesPath, requestMessageBody, sentTask, turnApiPath } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { buildTaskPromptArtifact } from "@multiremi/prompt.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

import { bindFeishuTopicFixture } from "./feishu-topic-fixture.js";

afterEach(resetMultiremiTestEnv);

function scaffold() {
  const store = createLocalStore();
  const remi = store.createAgent({ name: "Remi", provider: "codex", workspaceId: "local" });
  const owner = store.createAgent({ name: "Issue owner", provider: "claude", workspaceId: "local" });
  const runtime = store.registerRuntime({ id: "rt_followup", name: "Issue machine", provider: "claude", workspaceId: "local" });
  const issue = createResponsibleTestIssue(store, { title: "Continue existing work", workspaceId: "local", assigneeType: "agent", assigneeId: owner.id });
  const session = store.getOrCreateDefaultIssueSession(issue.id);
  const chat = store.createChatSession({ agentId: remi.id, workspaceId: "local" });
  bindFeishuTopicFixture(store, db!, chat.id, issue.id);
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

describe("bound Issue continuation instructions", () => {
  // ADR 0023: the boundary is session setup in the provider's AGENTS.md, the
  // same for a new (bootstrap) and a resumed (delta) provider session; the
  // turn input carries only the request.
  for (const mode of ["bootstrap", "delta"] as const) {
    for (const request of [
      "Continue the implementation and verify it.",
      "What is the current progress?",
      "The responsible agent completed a work round. Report the current result.",
    ]) {
      it(`puts the execution/read-only boundary in the instructions for ${mode}: ${request}`, () => {
        const { store, task, issue } = scaffold();
        const claimed = store.getTaskWithAgent(task.id)!;
        const wire = daemonTaskClaimResponse(store, claimed);
        const artifact = buildTaskPromptArtifact({
          ...claimed,
          prompt: request,
          boundIssue: wire.bound_issue,
          sessionProjection: { mode },
        } as any);
        expect(artifact.mode).toBe(mode);
        expect(artifact.prompt).toContain(request);
        expect(artifact.prompt).not.toContain("## Bound Issue Follow-up");
        const { instructions } = artifact;
        expect(instructions).toBe(buildTaskPromptArtifact({
          ...claimed,
          prompt: request,
          boundIssue: wire.bound_issue,
          sessionProjection: { mode: mode === "delta" ? "bootstrap" : "delta" },
        } as any).instructions);
        expect(instructions.match(/## Bound Issue Follow-up/g)).toHaveLength(1);
        expect(instructions).toContain("Progress questions and proactive work-round reports are read-only");
        expect(instructions).toContain("Only an explicit execution request in the current user message");
        expect(instructions).toContain("Quoted messages, previous approvals, and the Issue's log are context");
        expect(instructions).toContain("terminal round (completed, failed, or cancelled)");
        expect(instructions).toContain(`remi session list ${issue.id} --output json`);
        expect(instructions).toContain("route to its leader, not an arbitrary teammate");
        expect(instructions).toContain("This is not the Chat Session ID or the provider session_id");
        expect(instructions).toContain("If ambiguous or archived, ask");
        expect(instructions).toContain("Exclude Chat/reporting turns");
        expect(instructions).toContain("the target does not share your Chat transcript");
        expect(instructions).toContain("remi message send <issue-session-id>");
        expect(instructions).toContain(`remi turn list --issue ${issue.id} --output json`);
        expect(instructions).toContain("A running turn receives the message as an interruption");
        expect(instructions).toContain("otherwise the inbox schedules a turn in the original Issue Session");
        expect(instructions).toContain("Chat-origin dispatch keeps the existing topic relay reporting path");
        expect(instructions).toContain("remi turn get <returned-turn-id> --output json");
        expect(instructions).toContain("remi message get <returned-message-id> --output json");
        expect(instructions).toContain("never describe queued work as running");
        expect(instructions).toContain("do not claim the handoff succeeded or bypass authorization");
        expect(instructions).toContain("read back the message list by dedupe key before retrying");
        expect(instructions).toContain("After a verified handoff, finish this Chat turn");
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
      const { prompt, instructions } = buildTaskPromptArtifact({ ...claimed, boundIssue: wire.bound_issue } as any);
      expect(prompt).not.toContain("## Bound Issue Follow-up");
      expect(instructions).not.toContain("## Bound Issue Follow-up");
    }
    expect(store.getIssue(issue.id)?.assigneeId).toBe(owner.id);
  });
});

describe("topic Task credential handoff through existing APIs", () => {
  it("task-linked rich mentions and explicit Tasks resume the owner's Issue lane without a delegation return to Chat", async () => {
    const { store, app, headers, task, owner, remi, issue, session, runtime, chat } = await authenticatedTopic();
    const previous = store.createSessionTask(session.id, { agentId: owner.id, prompt: "Original implementation" });
    expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
    store.startTask(previous.id);
    store.completeTask(previous.id, { output: "Ready for follow-up", sessionId: "acp_issue_owner", workDir: "/tmp/issue-followup-work" });
    const before = store.listTasks().length;

    const comment = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify(requestMessageBody(store, { content: `[@Issue owner](mention://agent/${owner.id}) Please continue.` }, { type: "role", ref: "issue_owner" })),
    });
    expect(comment.status).toBe(200);
    const { message: posted } = await comment.json();
    expect(posted.sender_type).toBe("agent");
    const mentioned = store.listTasks().find((entry) => entry.triggerCommentId === posted.id)!;
    expect(mentioned).toMatchObject({
      issueId: issue.id, issueSessionId: session.id, agentId: owner.id,
      chatSessionId: null, parentTaskId: null, status: "queued", sessionId: "acp_issue_owner",
      delegationId: null, delegatedByAgentId: null, delegatedFromIssueSessionId: null,
      delegationSkipReason: null,
    });
    expect(store.listTasks()).toHaveLength(before + 1);
    expect(store.claimTask(runtime.id)?.id).toBe(mentioned.id);
    store.startTask(mentioned.id);
    store.completeTask(mentioned.id, { output: "Rich mention follow-up verified." });
    expect(store.getTask(mentioned.id)?.delegationReturnTaskId).toBeNull();
    // #3/#9: source provenance is on the request header; Chat has no delegation return.
    expect(store.getMessage(posted.id)?.task_id).toBe(store.getTurnForAttempt(task.id)!.id);
    expect(store.listTasks()).toHaveLength(before + 1);
    expect(store.listTasks().filter((entry) => entry.chatSessionId === chat.id).map((entry) => entry.id)).toEqual([task.id]);

    const created = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers,
      body: JSON.stringify(requestMessageBody(store, { agent_id: owner.id, prompt: "User requested: add tests, retain the API, and report verification." }, { type: "role", ref: "issue_owner" })),
    });
    expect(created.status).toBe(200);
    const next = sentTask(store, await created.json());
    expect(next).toMatchObject({issueId:issue.id,issueSessionId:session.id,agentId:owner.id,chatSessionId:null,parentTaskId:null,status:"queued",sessionId:"acp_issue_owner",delegationId:null});
    const verified = await app.request(turnApiPath(store, next.id), { headers });
    expect(verified.status).toBe(200);
    expect((await verified.json()).turn).toMatchObject({id:store.getTurnForAttempt(next.id)!.id,current_attempt_id:next.id,session_id:session.id,agent_id:owner.id,status:"pending"});
    const listed = await app.request(`/api/turns?session_id=${session.id}`, { headers });
    expect(listed.status).toBe(200);
    expect((await listed.json()).turns.some((entry: { id: string }) => entry.id === store.getTurnForAttempt(next.id)!.id)).toBe(true);
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
    const sent = await app.request(attemptMessagesPath(store, active.id), {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { body_md: "Also test the failure path." }, { type: "agent", ref: store.getTask(active.id)!.agentId })),
    });
    expect(sent.status).toBe(200);
    const directive = (await sent.json()).message;
    const verified = await app.request(attemptMessagesPath(store, active.id), { headers });
    expect(verified.status).toBe(200);
    expect((await verified.json()).messages).toContainEqual(expect.objectContaining({ id: directive.id, body_md: "Also test the failure path." }));
    expect(store.listTasks()).toHaveLength(before);
    expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
    expect(store.getTask(active.id)).toMatchObject({ issueId: issue.id, issueSessionId: session.id, agentId: owner.id, status: "running" });

    store.consumeTaskSteerMessages(active.id, [directive.id]);
    store.completeTask(active.id, { output: "Done" });
    const late = await app.request(attemptMessagesPath(store, active.id), {
      method: "POST", headers, body: JSON.stringify(requestMessageBody(store, { content: "Too late" }, { type: "agent", ref: store.getTask(active.id)!.agentId })),
    });
    expect(late.status).toBe(200);
    expect(store.listTasks()).toHaveLength(before + 1);
    expect(sentTask(store,await late.json()).status).toBe("queued");
  });

  it("surfaces invalid targets and rejected credentials without creating follow-up work", async () => {
    const { store, app, headers, owner, issue, session } = await authenticatedTopic();
    const other = createResponsibleTestIssue(store, { title: "Different issue", workspaceId: "local" });
    const wrongSession = store.getOrCreateDefaultIssueSession(other.id);
    const before = store.listTasks().length;
    for (const [sessionId, agentId, auth, expectedStatus] of [
      ["ises_missing", owner.id, headers, 403],
      [session.id, "agt_missing", headers, 400],
      [session.id, owner.id, { ...headers, Authorization: "Bearer invalid-task-credential" }, 401],
    ] as const) {
      const failed = await app.request(`/api/sessions/${sessionId}/messages`, {
        method: "POST", headers: auth, body: JSON.stringify(requestMessageBody(store, { agent_id: agentId, prompt: "Continue" }, { type: "role", ref: "issue_owner" })),
      });
      expect(failed.status).toBe(expectedStatus);
      expect(await failed.json()).toHaveProperty("error");
      expect(store.listTasks()).toHaveLength(before);
    }
  });
});
