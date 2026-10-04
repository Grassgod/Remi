/** MUL-458: credential-verified human actions force-start waiting issues. */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { IssuesRepo } from "@multiremi/store/repos/issues-repo.js";
import { createLocalStore, resetMultiremiTestEnv, signTestJwt } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

interface HumanFixture {
  store: MultiremiStore;
  app: ReturnType<typeof createMultiremiApp>;
  headers: Record<string, string>;
  memberUserId: string;
  agentId: string;
  prerequisiteId: string;
  issueId: string;
}

async function humanFixture(kind: "jwt" | "pat", suffix: string): Promise<HumanFixture> {
  const store = createLocalStore();
  const user = store.getOrCreateUser({
    email: `mul458-${kind}-${suffix}@example.test`,
    name: `MUL-458 ${kind} ${suffix}`,
  });
  store.createWorkspaceMember({ workspaceId: "local", userId: user.id, name: user.name, role: "member" });
  const runtime = store.registerRuntime({
    id: `rt_mul458_${kind}_${suffix}`,
    name: `MUL-458 ${kind} ${suffix}`,
    provider: "claude",
  });
  const agent = store.createAgent({
    name: `MUL-458 worker ${kind} ${suffix}`,
    provider: "claude",
    runtimeId: runtime.id,
    visibility: "workspace",
  });
  const prerequisite = store.createIssue({ title: `Prerequisite ${suffix}`, status: "in_progress" });
  const issue = store.createIssue({
    title: `Waiting ${suffix}`,
    status: "backlog",
    blockedBy: [prerequisite.id],
    assigneeType: "agent",
    assigneeId: agent.id,
  });
  const token = kind === "pat"
    ? (await store.createAccessToken({
        workspaceId: "local",
        userId: user.id,
        name: `MUL-458 ${suffix}`,
        type: "pat",
        purpose: "session",
      })).token
    : signTestJwt({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 60 });
  return {
    store,
    app: createMultiremiApp({ store, authToken: "mul458-root" }),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    memberUserId: user.id,
    agentId: agent.id,
    prerequisiteId: prerequisite.id,
    issueId: issue.id,
  };
}

function forceActivities(store: MultiremiStore, issueId: string) {
  return store.listIssueActivity(issueId).filter((entry) => entry.type === "dependency_force_started");
}

describe("MUL-458 human dependency force (SQLite)", () => {
  it.each(["jwt", "pat"] as const)("force-starts a waiting issue from a %s member comment", async (kind) => {
    const fixture = await humanFixture(kind, `comment-${kind}`);
    const response = await fixture.app.request(`/api/issues/${fixture.issueId}/comments`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ body: "Please start despite the prerequisite." }),
    });
    expect(response.status).toBe(201);
    const comment = await response.json() as { id: string; author_type: string; author_id: string };
    expect(comment).toMatchObject({ author_type: "member", author_id: fixture.memberUserId });

    const tasks = fixture.store.listTasksForIssue(fixture.issueId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.triggerCommentId).toBe(comment.id);
    expect(tasks[0]!.prompt).toContain("unfinished prerequisites");
    expect(fixture.store.getIssue(fixture.issueId)?.status).toBe("todo");
    const activities = forceActivities(fixture.store, fixture.issueId);
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ actorType: "member", actorId: fixture.memberUserId });
    expect(activities[0]!.data).toMatchObject({
      source: "comment",
      commentId: comment.id,
      taskId: tasks[0]!.id,
      assigneeDispatched: true,
      unmet: [{ dependsOnIssueId: fixture.prerequisiteId }],
    });
  });

  it("dispatches only the mentioned non-owner and records assignee_dispatched=false", async () => {
    const fixture = await humanFixture("pat", "mention-non-owner");
    const mentioned = fixture.store.createAgent({ name: "Mentioned specialist", provider: "claude", visibility: "workspace" });
    const response = await fixture.app.request(`/api/issues/${fixture.issueId}/comments`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ body: `[@${mentioned.name}](mention://agent/${mentioned.id}) please inspect` }),
    });
    expect(response.status).toBe(201);
    const tasks = fixture.store.listTasksForIssue(fixture.issueId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(mentioned.id);
    expect(tasks.some((task) => task.agentId === fixture.agentId)).toBe(false);
    expect(forceActivities(fixture.store, fixture.issueId)[0]!.data).toMatchObject({
      source: "mention",
      agentId: mentioned.id,
      assigneeDispatched: false,
      assignee_dispatched: false,
    });
  });

  it("dispatches owner and squad mentions to the effective assignee", async () => {
    const owner = await humanFixture("pat", "mention-owner");
    expect((await owner.app.request(`/api/issues/${owner.issueId}/comments`, {
      method: "POST",
      headers: owner.headers,
      body: JSON.stringify({ body: `[@Owner](mention://agent/${owner.agentId}) please start` }),
    })).status).toBe(201);
    expect(owner.store.listTasksForIssue(owner.issueId)).toHaveLength(1);
    expect(owner.store.listTasksForIssue(owner.issueId)[0]!.agentId).toBe(owner.agentId);
    expect(forceActivities(owner.store, owner.issueId)[0]!.data).toMatchObject({
      source: "mention",
      agentId: owner.agentId,
      assigneeDispatched: true,
    });

    const squadCase = await humanFixture("pat", "mention-squad");
    const leader = squadCase.store.createAgent({ name: "Mention squad leader", provider: "claude", visibility: "workspace" });
    const squad = squadCase.store.createSquad({ name: "Mention squad", leaderId: leader.id });
    squadCase.store.assignIssue(squadCase.issueId, { assigneeType: "squad", assigneeId: squad.id });
    expect((await squadCase.app.request(`/api/issues/${squadCase.issueId}/comments`, {
      method: "POST",
      headers: squadCase.headers,
      body: JSON.stringify({ body: `[@${squad.name}](mention://squad/${squad.id}) please start` }),
    })).status).toBe(201);
    expect(squadCase.store.listTasksForIssue(squadCase.issueId)).toHaveLength(1);
    expect(squadCase.store.listTasksForIssue(squadCase.issueId)[0]!.agentId).toBe(leader.id);
    expect(forceActivities(squadCase.store, squadCase.issueId)[0]!.data).toMatchObject({
      source: "mention",
      agentId: leader.id,
      assigneeDispatched: true,
    });
  });

  it("force-starts a waiting issue from a member rerun and honors its agent override", async () => {
    const fixture = await humanFixture("jwt", "rerun");
    const override = fixture.store.createAgent({ name: "Rerun override", provider: "claude", visibility: "workspace" });
    const response = await fixture.app.request(`/api/issues/${fixture.issueId}/rerun`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ agent_id: override.id }),
    });
    expect(response.status).toBe(202);
    const tasks = fixture.store.listTasksForIssue(fixture.issueId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.agentId).toBe(override.id);
    expect(forceActivities(fixture.store, fixture.issueId)[0]).toMatchObject({
      actorType: "member",
      actorId: fixture.memberUserId,
    });
    expect(forceActivities(fixture.store, fixture.issueId)[0]!.data).toMatchObject({
      source: "rerun",
      agentId: override.id,
      assigneeDispatched: false,
    });
  });

  it("keeps task-token comment, mention, rerun and task-create behind the gate", async () => {
    const fixture = await humanFixture("pat", "task-token");
    const leader = fixture.store.createAgent({ name: "Waiting leader", provider: "claude", visibility: "workspace" });
    const teammate = fixture.store.createAgent({ name: "Waiting teammate", provider: "claude", visibility: "workspace" });
    const squad = fixture.store.createSquad({
      name: "Waiting squad",
      leaderId: leader.id,
      memberIds: [teammate.id],
    });
    const sourceIssue = fixture.store.createIssue({
      title: "Agent source",
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const sourceTask = fixture.store.createTask({ agentId: leader.id, issueId: sourceIssue.id, prompt: "Lead" });
    fixture.store.createIssueDependency(sourceIssue.id, {
      dependsOnIssueId: fixture.prerequisiteId,
      type: "blocked_by",
    });
    fixture.store.updateIssue(sourceIssue.id, { status: "backlog" });
    const { token } = await fixture.store.createTaskAccessToken(sourceTask, fixture.memberUserId);
    const taskHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const spoofedComment = await fixture.app.request(`/api/issues/${sourceIssue.id}/comments`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ body: "Agent comment", author_type: "member", author_id: fixture.memberUserId }),
    });
    expect(spoofedComment.status).toBe(201);
    const persisted = await spoofedComment.json() as { id: string };
    expect(fixture.store.getIssueComment(persisted.id)).toMatchObject({
      authorType: "agent",
      authorId: leader.id,
      taskId: sourceTask.id,
    });

    const mention = await fixture.app.request(`/api/issues/${sourceIssue.id}/comments`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ body: `[@${teammate.name}](mention://agent/${teammate.id}) help` }),
    });
    expect(mention.status).toBe(201);
    const mentionId = ((await mention.json()) as { id: string }).id;
    expect(fixture.store.listIssueActivity(sourceIssue.id)
      .find((entry) => entry.type === "comment_mention_skipped" && (entry.data as any)?.commentId === mentionId)?.data)
      .toMatchObject({ reason: "dependencies_unmet", agentId: teammate.id });

    const rerun = await fixture.app.request(`/api/issues/${sourceIssue.id}/rerun`, {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({ agent_id: fixture.agentId, dependencyForce: { source: "rerun", actorMemberId: fixture.memberUserId } }),
    });
    expect(rerun.status).toBe(409);
    expect(await rerun.json()).toMatchObject({ code: "dependencies_unmet" });

    const taskCreate = await fixture.app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: taskHeaders,
      body: JSON.stringify({
        agentId: teammate.id,
        issueId: sourceIssue.id,
        prompt: "Spoof task create",
        dependencyForce: { source: "comment", actorMemberId: fixture.memberUserId },
      }),
    });
    expect(taskCreate.status).toBe(409);
    expect(await taskCreate.json()).toMatchObject({ code: "dependencies_unmet" });
    expect(fixture.store.listTasksForIssue(sourceIssue.id)).toHaveLength(1);
    expect(forceActivities(fixture.store, sourceIssue.id)).toHaveLength(0);
    expect(fixture.store.getIssue(sourceIssue.id)?.status).toBe("backlog");
  });

  it.each(["dependencyForce", "dependency_force"] as const)(
    "strips a public %s marker before the task funnel",
    async (spelling) => {
      const fixture = await humanFixture("pat", `strip-${spelling}`);
      const response = await fixture.app.request("/api/multiremi/tasks", {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({
          agentId: fixture.agentId,
          issueId: fixture.issueId,
          prompt: "Forged force marker",
          [spelling]: { source: "comment", actorMemberId: fixture.memberUserId },
        }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "dependencies_unmet" });
      expect(fixture.store.listTasksForIssue(fixture.issueId)).toHaveLength(0);
      expect(forceActivities(fixture.store, fixture.issueId)).toHaveLength(0);
    },
  );

  it("follows Q-B for three consecutive member comments while writing only one force record", async () => {
    const fixture = await humanFixture("pat", "three-comments");
    for (const body of ["first", "second", "third"]) {
      const response = await fixture.app.request(`/api/issues/${fixture.issueId}/comments`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({ body }),
      });
      expect(response.status).toBe(201);
    }
    expect(fixture.store.listTasksForIssue(fixture.issueId)).toHaveLength(true ? 1 : 3);
    expect(fixture.store.listIssueActivity(fixture.issueId).filter(activity => activity.type === "pending_turn_coalesced"))
      .toHaveLength(true ? 2 : 0);
    expect(forceActivities(fixture.store, fixture.issueId)).toHaveLength(1);
    expect(fixture.store.getIssue(fixture.issueId)?.status).toBe("todo");
  });

  it("re-derives an in-review parent when its waiting child is started by comment", async () => {
    const fixture = await humanFixture("pat", "parent-rederive");
    const parent = fixture.store.createIssue({ title: "Parent under review", status: "in_review" });
    const child = fixture.store.createIssue({
      title: "Waiting child",
      status: "backlog",
      parentIssueId: parent.id,
      blockedBy: [fixture.prerequisiteId],
      assigneeType: "agent",
      assigneeId: fixture.agentId,
    });
    const response = await fixture.app.request(`/api/issues/${child.id}/comments`, {
      method: "POST",
      headers: fixture.headers,
      body: JSON.stringify({ body: "Start the child now" }),
    });
    expect(response.status).toBe(201);
    expect(fixture.store.getIssue(child.id)?.status).toBe("todo");
    expect(fixture.store.getIssue(parent.id)?.status).toBe("in_progress");
    expect(fixture.store.listIssueActivity(parent.id).some((entry) => entry.type === "parent_status_derived")).toBe(true);
  });

  it("dispatches without a force record when the dependency gate kill switch is off", async () => {
    const fixture = await humanFixture("pat", "kill-switch");
    const previous = process.env.MULTIREMI_DEPENDENCY_GATE;
    process.env.MULTIREMI_DEPENDENCY_GATE = "0";
    try {
      const response = await fixture.app.request(`/api/issues/${fixture.issueId}/comments`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({ body: "Gate disabled" }),
      });
      expect(response.status).toBe(201);
      expect(fixture.store.listTasksForIssue(fixture.issueId)).toHaveLength(1);
      expect(forceActivities(fixture.store, fixture.issueId)).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.MULTIREMI_DEPENDENCY_GATE;
      else process.env.MULTIREMI_DEPENDENCY_GATE = previous;
    }
  });

  it("rolls back task, status and force activity together when force audit fails", async () => {
    const fixture = await humanFixture("pat", "rollback");
    const injected = spyOn(IssuesRepo.prototype, "recordDependencyForceStarted")
      .mockImplementation(() => { throw new Error("injected force audit failure"); });
    try {
      const response = await fixture.app.request(`/api/issues/${fixture.issueId}/comments`, {
        method: "POST",
        headers: fixture.headers,
        body: JSON.stringify({ body: "This comment remains durable" }),
      });
      expect(response.status).toBe(400);
      expect(fixture.store.listIssueComments(fixture.issueId).some((comment) => comment.body === "This comment remains durable")).toBe(true);
      expect(fixture.store.getIssue(fixture.issueId)?.status).toBe("backlog");
      expect(fixture.store.listTasksForIssue(fixture.issueId)).toHaveLength(0);
      expect(forceActivities(fixture.store, fixture.issueId)).toHaveLength(0);
    } finally {
      injected.mockRestore();
    }
  });
});
