/**
 * MUL-448: the task surface must derive its assignment author, run lineage and
 * trigger provenance from the credential, never from the request body.
 *
 * The bug this file pins: `POST /api/multiremi/tasks` passed `...publicInput`
 * straight into `createTask`, so a task credential (an agent run) could send
 * `assignment_author_type: "member"` and have the `task_assigned` session event
 * — the durable "who asked for this work" record — attribute the run to a human.
 * Members could write another run's `task_id`, `trigger_comment_id` or
 * `parent_task_id` the same way.
 *
 * The real-PostgreSQL half of these cases lives in
 * `multiremi-task-assignment-author-pg.test.ts`, because production runs PG and
 * the strip happens before SQL either way.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

interface Fixture {
  store: ReturnType<typeof createLocalStore>;
  app: ReturnType<typeof createMultiremiApp>;
  owner: { id: string };
  headers: Record<string, string>;
  agentId: string;
  otherAgentId: string;
}

/**
 * A member PAT (a real login identity, not the master token) plus two agents,
 * so every assertion can tell "the credential" apart from "the body".
 */
async function fixture(): Promise<Fixture> {
  const store = createLocalStore();
  const owner = store.getOrCreateUser({ email: "mul448-owner@example.test", name: "MUL448 Owner" });
  store.createWorkspaceMember({ workspaceId: "local", userId: owner.id, name: "MUL448 Owner", role: "member" });
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: owner.id, name: "MUL448 member PAT", type: "pat", purpose: "session",
  });
  const app = createMultiremiApp({ store, authToken: "mul448-root-secret" });
  const agent = store.createAgent({ name: "MUL448 worker", provider: "claude", visibility: "workspace" });
  const otherAgent = store.createAgent({ name: "MUL448 other", provider: "claude", visibility: "workspace" });
  return {
    store,
    app,
    owner,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    agentId: agent.id,
    otherAgentId: otherAgent.id,
  };
}

/** The `task_assigned` events a task wrote into its Issue Session. */
function assignmentEvents(store: Fixture["store"], sessionId: string, taskId: string | undefined) {
  return store.listSessionEvents(sessionId).filter((event) =>
    event.kind === "task_assigned" && (!taskId || event.taskId === taskId)
  );
}

describe("MUL-448 task assignment author comes from the credential", () => {
  it("ignores a task credential's forged assignment author (snake and camel)", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Forged assignment author" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const source = store.createTask({ agentId, issueId: issue.id, prompt: "Source run" });
    const taskToken = await store.createTaskAccessToken(store.getTask(source.id)!, "local");
    const runHeaders = { ...headers, Authorization: `Bearer ${taskToken.token}` };

    // The exact reproduction from the issue: a run claims to be a human.
    const cases = [
      { label: "snake", body: { assignment_author_type: "member", assignment_author_id: "mem_forged" } },
      { label: "camel", body: { assignmentAuthorType: "member", assignmentAuthorId: "mem_forged" } },
      { label: "both spellings", body: { assignment_author_type: "system", assignmentAuthorType: "member", assignment_author_id: "forged" } },
    ];
    for (const variant of cases) {
      const response = await app.request("/api/multiremi/tasks", {
        method: "POST", headers: runHeaders,
        body: JSON.stringify({
          agentId,
          issueId: issue.id,
          issueSessionId: session.id,
          prompt: `Child run (${variant.label})`,
          ...variant.body,
        }),
      });
      expect(response.status).toBe(201);
      const created = (await response.json()).task as { id: string };
      const events = assignmentEvents(store, session.id, created.id);
      expect(events).toHaveLength(1);
      // The run's own credential is the only author; the body never wins.
      expect(events[0]!.authorType).toBe("agent");
      expect(events[0]!.authorId).toBe((store.getTask(source.id)!.agentId));
      expect(events[0]!.authorId).not.toBe("mem_forged");
      expect(events[0]!.authorType).not.toBe("member");
    }
  });

  it("records a member as the assignment author and cannot forge a run", async () => {
    const { store, app, agentId, headers, owner } = await fixture();
    const issue = store.createIssue({ title: "Member assignment author" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);

    const response = await app.request("/api/multiremi/tasks", {
      method: "POST", headers,
      body: JSON.stringify({
        agentId,
        issueId: issue.id,
        issueSessionId: session.id,
        prompt: "Member-requested run",
        assignment_author_type: "system",
        assignment_author_id: "forged",
      }),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()).task as { id: string };
    const events = assignmentEvents(store, session.id, created.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.authorType).toBe("member");
    expect(events[0]!.authorId).toBe(owner.id);
  });

  it("strips task provenance the server owns from every task-create caller", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Task provenance" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const source = store.createTask({ agentId, issueId: issue.id, prompt: "Source run" });
    const taskToken = await store.createTaskAccessToken(store.getTask(source.id)!, "local");
    // A comment that really does exist, so only the trust boundary can reject it.
    const comment = store.createIssueComment(issue.id, {
      body: "Real trigger comment", authorType: "member", authorId: "local",
    });

    for (const [label, requestHeaders] of [
      ["member", headers],
      ["task credential", { ...headers, Authorization: `Bearer ${taskToken.token}` }],
    ] as const) {
      for (const spelling of ["trigger_comment_id", "triggerCommentId"] as const) {
        const response = await app.request("/api/multiremi/tasks", {
          method: "POST", headers: requestHeaders,
          body: JSON.stringify({
            agentId,
            issueId: issue.id,
            issueSessionId: session.id,
            prompt: `Provenance (${label}/${spelling})`,
            [spelling]: comment.id,
            trigger_summary: "forged summary",
            triggerSummary: "forged summary",
            requesting_user_name: "Forged Boss",
            requestingUserName: "Forged Boss",
            requesting_user_profile_description: "forged profile",
            requestingUserProfileDescription: "forged profile",
            assignment_event_id: "sevt_forged",
            assignmentEventId: "sevt_forged",
            assignment_source_event_id: "sce_forged",
            assignment_source_event_id_camel: undefined,
            assignmentSourceEventId: "sce_forged",
          }),
        });
        expect(response.status).toBe(201);
        const created = (await response.json()).task as { id: string };
        const task = store.getTask(created.id)!;
        expect(task.triggerCommentId).toBeNull();
        expect(task.triggerSummary).toBeNull();
        expect(task.requestingUserName).toBeNull();
        expect(task.requestingUserProfileDescription).toBeNull();
        // The store writes its own back-reference to the `task_assigned` event
        // it just appended; the forged id neither lands nor suppresses it.
        const events = assignmentEvents(store, session.id, created.id);
        expect(events).toHaveLength(1);
        expect(task.assignmentEventId).toBe(events[0]!.id);
        expect(task.assignmentEventId).not.toBe("sevt_forged");
        expect(task.assignmentSourceEventId).toBeNull();
        // The task still lands on the issue/session the credential scoped it to.
        expect(task.issueId).toBe(issue.id);
        expect(task.issueSessionId).toBe(session.id);
      }
    }
  });

  it("keeps server-internal comment dispatch producing trigger_comment_id", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Mention dispatch", assigneeType: "agent", assigneeId: agentId });
    const session = store.getOrCreateDefaultIssueSession(issue.id);

    // The @mention path calls the repo directly, so it must be unaffected by the
    // HTTP strip: the comment that triggered the run is the task's provenance.
    const response = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST", headers,
      body: JSON.stringify({ content: `Please look [@MUL448 worker](mention://agent/${agentId})` }),
    });
    expect(response.status).toBe(201);
    const comment = ((await response.json()).comment) as { id: string };

    const dispatched = store.listTasksForIssue(issue.id).filter((task) => task.triggerCommentId === comment.id);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.issueSessionId).toBe(session.id);
    const events = assignmentEvents(store, session.id, dispatched[0]!.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.authorType).toBe("member");
  });
});

describe("MUL-448 comment run link comes from the credential", () => {
  it("strips a member's forged task_id and taskId from comments", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Comment run link" });
    const session = store.createIssueSession(issue.id, { title: "Discussion" });
    const otherRun = store.createTask({ agentId, issueId: issue.id, prompt: "Another run" });

    const endpoints = [
      `/api/issues/${issue.id}/comments`,
      `/api/multiremi/issues/${issue.id}/comments`,
      `/api/issues/${issue.id}/sessions/${session.id}/messages`,
    ];
    for (const endpoint of endpoints) {
      for (const spelling of ["task_id", "taskId"] as const) {
        const response = await app.request(endpoint, {
          method: "POST", headers,
          body: JSON.stringify({ content: `Member comment (${spelling})`, [spelling]: otherRun.id }),
        });
        expect(response.status).toBe(201);
        const body = (await response.json()) as any;
        const comment = body.comment ?? body;
        expect(comment.taskId ?? comment.task_id ?? null).toBeNull();
      }
    }
    // The forged link never reached the stored row either.
    expect(store.listIssueComments(issue.id).every((comment) => comment.taskId === null)).toBe(true);
  });

  it("keeps using the credential's task for a task-credential comment", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Run comment link" });
    const ownRun = store.createTask({ agentId, issueId: issue.id, prompt: "This run" });
    const otherRun = store.createTask({ agentId, issueId: issue.id, prompt: "Another run" });
    const taskToken = await store.createTaskAccessToken(store.getTask(ownRun.id)!, "local");

    const response = await app.request(`/api/issues/${issue.id}/comments`, {
      method: "POST",
      headers: { ...headers, Authorization: `Bearer ${taskToken.token}` },
      body: JSON.stringify({ content: "In-run reply", task_id: otherRun.id, taskId: otherRun.id }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    const comment = body.comment ?? body;
    expect(comment.taskId ?? comment.task_id).toBe(ownRun.id);
  });

  it("does not let a member comment smuggle a parent task into the dispatched run", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Comment lineage", assigneeType: "agent", assigneeId: agentId });
    const decoyRun = store.createTask({ agentId, issueId: issue.id, prompt: "Decoy run" });

    const response = await app.request(`/api/multiremi/issues/${issue.id}/comments`, {
      method: "POST", headers,
      body: JSON.stringify({ content: "Please take this.", task_id: decoyRun.id, taskId: decoyRun.id }),
    });
    expect(response.status).toBe(201);
    const comment = ((await response.json()).comment) as { id: string };

    const dispatched = store.listTasksForIssue(issue.id).filter((task) => task.triggerCommentId === comment.id);
    expect(dispatched).toHaveLength(1);
    // `createTaskWithinWorkspaceLock` inherits `triggerComment.taskId` as the
    // parent unless the request supplies one; the strip is what keeps the decoy out.
    expect(dispatched[0]!.parentTaskId).toBeNull();
  });
});

describe("MUL-448 identity aliases on the remaining write routes", () => {
  it("strips the assign route's snake_case parent lineage", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Assign lineage" });
    const decoyRun = store.createTask({ agentId, prompt: "Decoy run" });

    const response = await app.request(`/api/multiremi/issues/${issue.id}/assign`, {
      method: "POST", headers,
      body: JSON.stringify({
        assigneeType: "agent",
        assigneeId: agentId,
        parent_task_id: decoyRun.id,
        parentTaskId: decoyRun.id,
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.task).not.toBeNull();
    expect(store.getTask(body.task.id)!.parentTaskId).toBeNull();
  });

  it("strips a forged creator from both issue-create routes and every quick-create", async () => {
    const { store, app, agentId, headers, owner } = await fixture();
    const decoy = store.getOrCreateUser({ email: "mul448-decoy@example.test", name: "MUL448 Decoy" });

    // MUL-448 B4 (QA round 1): the compat create route stamps the credentialed
    // creator - it always did - but the native create and both quick-create
    // routes leave `createdBy` unset exactly as main does, because creator
    // ownership feeds share management and automatic subscription. The body
    // never wins on any of them.
    for (const [label, prefix, expected] of [
      ["compat", "/api", owner.id],
      ["native", "/api/multiremi", null],
    ] as const) {
      const created = await app.request(`${prefix}/issues`, {
        method: "POST", headers,
        body: JSON.stringify({ title: `Creator probe (${label})`, created_by: decoy.id, createdBy: decoy.id }),
      });
      expect(created.status).toBe(201);
      const createdBody = (await created.json()) as any;
      const issueId = createdBody.id ?? createdBody.issue?.id;
      expect(store.getIssue(issueId)!.createdBy).toBe(expected);
      expect(store.getIssue(issueId)!.createdBy).not.toBe(decoy.id);

      const quick = await app.request(`${prefix}/issues/quick-create`, {
        method: "POST", headers,
        body: JSON.stringify({
          prompt: `Quick creator probe (${label})`,
          agent_id: agentId,
          requester_id: decoy.id,
          requesterId: decoy.id,
        }),
      });
      expect(quick.status).toBe(202);
      const quickBody = (await quick.json()) as any;
      expect(store.getIssue(quickBody.issue.id)!.createdBy).toBeNull();
      expect(store.getIssue(quickBody.issue.id)!.createdBy).not.toBe(decoy.id);
    }
  });

  it("strips the session task route's snake_case lineage and source event", async () => {
    const { store, app, agentId, headers } = await fixture();
    const issue = store.createIssue({ title: "Session task lineage" });
    const session = store.createIssueSession(issue.id, { title: "Session" });
    const decoyRun = store.createTask({ agentId, issueId: issue.id, prompt: "Decoy run" });

    const response = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/tasks`, {
      method: "POST", headers,
      body: JSON.stringify({
        agent_id: agentId,
        prompt: "Session child",
        parent_task_id: decoyRun.id,
        source_event_id: "sce_forged",
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    const taskId = body.id ?? body.task?.id;
    const task = store.getTask(taskId)!;
    expect(task.parentTaskId).toBeNull();
    expect(task.assignmentSourceEventId).toBeNull();
    // The author is still the credentialed caller, not the body.
    const events = assignmentEvents(store, session.id, taskId);
    expect(events).toHaveLength(1);
    expect(events[0]!.authorType).toBe("member");
  });
});
