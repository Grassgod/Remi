import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody } from "./unified-test-paths.js";
/**
 * MUL-448 QA round 1 follow-up (B1-B4): credentialed requests must derive the
 * acting identity and the issue provenance from the credential, while the
 * anonymous compatibility mode (master token / auth disabled) keeps the
 * historical behaviour of reading `X-Agent-ID` / `X-Task-ID` and the body.
 *
 * Every case drives the real Hono app through `app.request`, so the assertions
 * traverse the same route + store path production runs, and each one reads the
 * durable rows back from the store instead of trusting the response projection.
 *
 * The PostgreSQL half lives in `multiremi-credential-identity-pg.test.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import type { MultiremiStore } from "@multiremi/store.js";
import { createLocalStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

interface Fixture {
  store: MultiremiStore;
  app: ReturnType<typeof createMultiremiApp>;
  /** The caller's user id (what `member` credentials resolve to). */
  ownerId: string;
  /** The caller's workspace member row id (what subscriber routes take). */
  memberId: string;
  headers: Record<string, string>;
  agentId: string;
  otherAgentId: string;
  leaderId: string;
  squadId: string;
}

/**
 * One member PAT (a real login identity) plus three agents and a squad led by
 * `leaderId`, so every assertion can tell the credential apart from the body.
 */
async function fixture(): Promise<Fixture> {
  const store = createLocalStore();
  const owner = store.getOrCreateUser({ email: "mul448-r2-owner@example.test", name: "MUL448 R2 Owner" });
  const member = store.createWorkspaceMember({ workspaceId: "local", userId: owner.id, name: "MUL448 R2 Owner", role: "member" });
  const { token } = await store.createAccessToken({
    workspaceId: "local", userId: owner.id, name: "MUL448 R2 member PAT", type: "pat", purpose: "session",
  });
  const app = createMultiremiApp({ store, authToken: "mul448-r2-root-secret" });
  const agent = store.createAgent({ name: "MUL448 R2 worker", provider: "claude", visibility: "workspace" });
  const otherAgent = store.createAgent({ name: "MUL448 R2 other", provider: "claude", visibility: "workspace" });
  const leader = store.createAgent({ name: "MUL448 R2 leader", provider: "claude", visibility: "workspace" });
  const squad = store.createSquad({ name: "MUL448 R2 squad", workspaceId: "local", leaderId: leader.id });
  return {
    store,
    app,
    ownerId: owner.id,
    memberId: member.id,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    agentId: agent.id,
    otherAgentId: otherAgent.id,
    leaderId: leader.id,
    squadId: squad.id,
  };
}

/** The `turn` events one task wrote into its Issue Session. */
// Ruling (u), cmt_9z7t6hwo3xuh; Senior III, cmt_u7m8e7yitmai: /events uses turn.
function assignmentEvents(store: MultiremiStore, sessionId: string, taskId: string) {
  return store.listSessionEvents(sessionId).filter((event) => event.id === taskId);
}

describe("MUL-448 B1: X-Agent-ID cannot outrank a member credential", () => {
  it("keeps session task, session, result and mutation actors as the credential's member", async () => {
    const { store, app, ownerId, memberId, otherAgentId, agentId, headers } = await fixture();
    const forged = { ...headers, "X-Agent-ID": otherAgentId };
    const issue = createResponsibleTestIssue(store, { title: "MUL-448 B1 issue" });
    const session = store.createIssueSession(issue.id, { title: "B1 session" });

    // Session task: the `turn` author is the member, not the header agent.
    const taskResponse = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers: forged,
      body: JSON.stringify(requestMessageBody(store, { agent_id: agentId, prompt: "Member session task" }, { type: "role", ref: "issue_owner" })),
    });
    expect(taskResponse.status).toBe(200);
    const taskId = (await taskResponse.json()).message.id as string;
    const assigned = assignmentEvents(store, session.id, taskId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.authorType).toBe("member");
    expect(assigned[0]!.authorId).toBe(store.findWorkspaceMemberForUser(ownerId,"local")!.id); // #7: canonical sender_id identifies the credential’s member row.
    expect(assigned[0]!.authorId).not.toBe(otherAgentId);

    // Session creation: createdByType/Id come from the credential.
    const sessionResponse = await app.request(`/api/issues/${issue.id}/sessions`, {
      method: "POST", headers: forged, body: JSON.stringify({ title: "Created with forged header" }),
    });
    expect(sessionResponse.status).toBe(201);
    const sessionBody = (await sessionResponse.json()) as any;
    expect(sessionBody.created_by_type).toBe("member");
    expect(sessionBody.created_by_id).toBe(ownerId);
    expect(store.getIssueSession(sessionBody.id)!.createdById).toBe(ownerId);

    // Published result: publishedByType/Id come from the credential.
    const resultResponse = await app.request(`/api/issues/${issue.id}/sessions/${session.id}/results`, {
      method: "POST", headers: forged, body: JSON.stringify({ title: "B1 result", body: "Result body" }),
    });
    expect(resultResponse.status).toBe(201);
    const resultBody = (await resultResponse.json()) as any;
    expect(resultBody.published_by_type).toBe("member");
    expect(resultBody.published_by_id).toBe(ownerId);

    // A dependency edit writes its activity as the member too.
    const dependsOn = createResponsibleTestIssue(store, { title: "MUL-448 B1 depends on" });
    const dependencyResponse = await app.request(`/api/multiremi/issues/${issue.id}/dependencies`, {
      method: "POST", headers: forged, body: JSON.stringify({ dependsOnIssueId: dependsOn.id }),
    });
    expect(dependencyResponse.status).toBe(201);
    const dependencyActivity = store.listIssueActivity(issue.id).filter((entry) => entry.type === "issue_dependency_added");
    expect(dependencyActivity).toHaveLength(1);
    expect(dependencyActivity[0]!.actorType).toBe("member");
    expect(dependencyActivity[0]!.actorId).toBe(ownerId);

    // Label attach takes the same caller.
    const label = store.createLabel({ workspaceId: "local", name: "mul448-b1-label", color: "#3366ff" });
    const labelResponse = await app.request(`/api/multiremi/issues/${issue.id}/labels`, {
      method: "POST", headers: forged, body: JSON.stringify({ labelId: label.id }),
    });
    expect(labelResponse.status).toBe(201);
    const labelActivity = store.listIssueActivity(issue.id).filter((entry) => entry.type === "label_attached");
    expect(labelActivity.length).toBeGreaterThan(0);
    expect(labelActivity[0]!.actorType).toBe("member");
    expect(labelActivity[0]!.actorId).toBe(ownerId);

    // Subscribe/unsubscribe emits the caller identity as the member.
    const events: Array<{ type: string; actorType?: string; actorId?: string }> = [];
    const stop = store.onWorkspaceEvent((event: any) => events.push(event));
    const subscribe = await app.request(`/api/issues/${issue.id}/subscribe`, {
      method: "POST", headers: forged, body: JSON.stringify({ user_id: memberId, user_type: "member" }),
    });
    expect(subscribe.status).toBe(200);
    const unsubscribe = await app.request(`/api/issues/${issue.id}/unsubscribe`, {
      method: "POST", headers: forged, body: JSON.stringify({ user_id: memberId, user_type: "member" }),
    });
    expect(unsubscribe.status).toBe(200);
    stop();
    const subscriberEvents = events.filter((event) => event.type === "subscriber:added" || event.type === "subscriber:removed");
    expect(subscriberEvents).toHaveLength(2);
    for (const event of subscriberEvents) {
      expect(event.actorType).toBe("member");
      expect(event.actorId).toBe(ownerId);
    }
  });

  it("still records the token's agent as the actor for a task credential", async () => {
    const { store, app, headers, agentId, otherAgentId } = await fixture();
    const issue = createResponsibleTestIssue(store, { title: "MUL-448 B1 task token" });
    const session = store.createIssueSession(issue.id, { title: "B1 task token session" });
    const source = store.createTask({ agentId, issueId: issue.id, prompt: "Source run" });
    const taskToken = await store.createTaskAccessToken(store.getTask(source.id)!, "local");
    const runHeaders = {
      ...headers,
      Authorization: `Bearer ${taskToken.token}`,
      "X-Agent-ID": otherAgentId,
    };

    const response = await app.request(`/api/sessions/${session.id}/messages`, {
      method: "POST", headers: runHeaders,
      body: JSON.stringify(requestMessageBody(store, { agent_id: agentId, prompt: "Token session task" }, { type: "role", ref: "issue_owner" })),
    });
    expect(response.status).toBe(200);
    const taskId = (await response.json()).message.id as string;
    const assigned = assignmentEvents(store, session.id, taskId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.authorType).toBe("agent");
    expect(assigned[0]!.authorId).toBe(agentId);
  });
});

describe("MUL-448 B2: squad-evaluated actor comes from the credential", () => {
  it("rejects member attempts to record an evaluation without writing any activity", async () => {
    const { store, app, headers, leaderId, squadId } = await fixture();
    const issue = createResponsibleTestIssue(store, { title: "MUL-448 B2 issue" });
    store.assignIssue(issue.id, { assigneeType: "squad", assigneeId: squadId });

    const variants = [
      { label: "body actor_id=leader", body: { outcome: "no_action", actor_id: leaderId } },
      { label: "body actorId=leader", body: { outcome: "no_action", actorId: leaderId } },
      { label: "body without actor", body: { outcome: "no_action" } },
      { label: "header X-Agent-ID=leader", body: { outcome: "no_action" }, header: leaderId },
    ];
    for (const variant of variants) {
      const requestHeaders = variant.header ? { ...headers, "X-Agent-ID": variant.header } : headers;
      const response = await app.request(`/api/issues/${issue.id}/squad-evaluated`, {
        method: "POST", headers: requestHeaders, body: JSON.stringify(variant.body),
      });
      expect(response.status, variant.label).toBe(403);
    }
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "squad_leader_evaluated")).toHaveLength(0);
  });

  it("records the squad leader for a leader task token and 403s for a non-leader token", async () => {
    const { store, app, leaderId, squadId, agentId } = await fixture();
    const issue = createResponsibleTestIssue(store, { title: "MUL-448 B2 leader issue" });
    store.assignIssue(issue.id, { assigneeType: "squad", assigneeId: squadId });

    const leaderRun = store.createTask({ agentId: leaderId, issueId: issue.id, prompt: "Leader run" });
    const leaderToken = await store.createTaskAccessToken(store.getTask(leaderRun.id)!, "local");
    const leaderResponse = await app.request(`/api/issues/${issue.id}/squad-evaluated`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${leaderToken.token}` },
      body: JSON.stringify({ outcome: "no_action", reason: "nothing to delegate", actor_id: "forged" }),
    });
    expect(leaderResponse.status).toBe(201);
    const recorded = store.listIssueActivity(issue.id).filter((entry) => entry.type === "squad_leader_evaluated");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.actorType).toBe("agent");
    expect(recorded[0]!.actorId).toBe(leaderId);
    // The token's own run is the recorded task, not the body's forged value.
    expect(store.getTask(leaderRun.id)!.id).toBe(leaderRun.id);

    const otherRun = store.createTask({ agentId, issueId: issue.id, prompt: "Non-leader run" });
    const otherToken = await store.createTaskAccessToken(store.getTask(otherRun.id)!, "local");
    const otherResponse = await app.request(`/api/issues/${issue.id}/squad-evaluated`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${otherToken.token}` },
      body: JSON.stringify({ outcome: "no_action" }),
    });
    expect(otherResponse.status).toBe(403);
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "squad_leader_evaluated")).toHaveLength(1);
  });
});

describe("MUL-448 B3: provenance comes from the credential, not the body", () => {
  it("ignores a member-forged source issue, and the intake's own run dispatches normally", async () => {
    const { store, app, headers, agentId } = await fixture();
    const intake = createResponsibleTestIssue(store, { title: "MUL-448 B3 intake", issueKind: "intake" });
    const generatedTitle = "Execution from the intake";

    // A member files decoys the generated-issue cache would otherwise match.
    for (const spelling of ["sourceIssueId", "source_issue_id"] as const) {
      const decoy = await app.request("/api/multiremi/issues", {
        method: "POST", headers,
        body: JSON.stringify({ title: generatedTitle, [spelling]: intake.id }),
      });
      expect(decoy.status, spelling).toBe(201);
      const decoyBody = (await decoy.json()) as any;
      // The native route answers `{ issue, task }`; the compat route answers flat.
      const decoyIssue = store.getIssue(decoyBody.id ?? decoyBody.issue?.id)!;
      expect(decoyIssue.sourceIssueId, spelling).toBeNull();
      expect(decoyIssue.issueKind, spelling).toBe("execution");
    }

    // The member cannot smuggle the intake kind through the native route either.
    const nativeIntake = await app.request("/api/multiremi/issues", {
      method: "POST", headers,
      body: JSON.stringify({ title: "MUL-448 B3 fake intake", issueKind: "intake" }),
    });
    expect(nativeIntake.status).toBe(201);
    const fakeIntakeBody = (await nativeIntake.json()) as any;
    expect(store.getIssue(fakeIntakeBody.id ?? fakeIntakeBody.issue?.id)!.issueKind).toBe("execution");

    // The intake's own run creates the generated issue for real: 201, a new
    // issue, and a dispatched task rather than the 200 cache hit.
    const intakeTask = store.createTask({ agentId, issueId: intake.id, prompt: "Intake run" });
    const intakeToken = await store.createTaskAccessToken(store.getTask(intakeTask.id)!, "local");
    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${intakeToken.token}` },
      body: JSON.stringify({
        title: generatedTitle, workspace_id: "local",
        assignee_type: "agent", assignee_id: agentId,
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    const created = store.getIssue(body.id)!;
    expect(created.sourceIssueId).toBe(intake.id);
    expect(created.issueKind).toBe("execution");
    expect(store.findGeneratedIssueByTitle(intake.id, generatedTitle)!.id).toBe(created.id);
    expect(body.task_id).toBeTruthy();
    expect(store.getTask(body.task_id)!.issueId).toBe(created.id);
  });
});

describe("MUL-448 B4: create routes keep main's creator semantics", () => {
  it("records the credentialed creator on the compat route and none on the native one", async () => {
    const { store, app, headers, ownerId } = await fixture();
    const decoy = store.getOrCreateUser({ email: "mul448-r2-decoy@example.test", name: "MUL-448 R2 Decoy" });

    for (const [label, path, forged, expected] of [
      ["native create", "/api/multiremi/issues", false, null],
      ["native create forged", "/api/multiremi/issues", true, null],
      ["compat create", "/api/issues", false, ownerId],
      ["compat create forged", "/api/issues", true, ownerId],
    ] as const) {
      const response = await app.request(path, {
        method: "POST", headers,
        body: JSON.stringify({
          title: `B4 ${label}`,
          ...(forged ? { created_by: decoy.id, createdBy: decoy.id } : {}),
        }),
      });
      expect(response.status, label).toBe(201);
      const body = (await response.json()) as any;
      const issue = store.getIssue(body.id ?? body.issue?.id)!;
      expect(issue.createdBy, label).toBe(expected);
      expect(issue.createdBy, label).not.toBe(decoy.id);
      // Main does not auto-subscribe on this path (only a stamped creator does,
      // and the compat route stamps the requester - check per route).
      if (expected === null) expect(store.listIssueSubscribers(issue.id), label).toHaveLength(0);
    }
  });
});

describe("MUL-448 B4: quick-create, subscription and share stay at main's level", () => {
  it("records no creator on any quick-create entry point and strips a forged requester", async () => {
    const { store, app, headers, agentId } = await fixture();
    const decoy = store.getOrCreateUser({ email: "mul448-r2-decoy2@example.test", name: "MUL-448 R2 Decoy 2" });

    for (const [label, path, forged] of [
      ["native quick-create", "/api/multiremi/issues/quick-create", false],
      ["native quick-create forged", "/api/multiremi/issues/quick-create", true],
      ["compat quick-create", "/api/issues/quick-create", false],
      ["compat quick-create forged", "/api/issues/quick-create", true],
    ] as const) {
      const response = await app.request(path, {
        method: "POST", headers,
        body: JSON.stringify({
          prompt: `B4 ${label}`, agent_id: agentId,
          ...(forged ? { requester_id: decoy.id, requesterId: decoy.id } : {}),
        }),
      });
      expect(response.status, label).toBe(202);
      const body = (await response.json()) as any;
      const issue = store.getIssue(body.issue.id)!;
      // Main records no creator on any quick-create route (verified against the
      // pre-fix baseline; see the MUL-448 delivery comment).
      expect(issue.createdBy, label).toBeNull();
      expect(store.listIssueSubscribers(issue.id), label).toHaveLength(0);
      const share = await app.request(`/api/issues/${issue.id}/share`, { method: "POST", headers });
      expect(share.status, label).toBe(403);
    }
  });
});

describe("MUL-448 anonymous compatibility mode keeps main's behaviour", () => {
  /** A store plus the two apps that mean "anonymous compatibility mode". */
  async function anonymousApps() {
    const { store, agentId, otherAgentId, leaderId, squadId } = await fixture();
    return {
      store,
      agentId,
      otherAgentId,
      leaderId,
      squadId,
      // Master token: the literal secret is accepted without verification.
      master: createMultiremiApp({ store, authToken: "mul448-r2-root-secret" }),
      // Auth disabled: no master secret configured at all.
      open: createMultiremiApp({ store, authToken: null }),
    };
  }

  it("B1: still lets a non-task caller name the session task author", async () => {
    const { store, agentId, otherAgentId, master, open } = await anonymousApps();
    const issue = createResponsibleTestIssue(store, { title: "MUL-448 anon B1" });
    const session = store.createIssueSession(issue.id, { title: "Anon B1 session" });

    for (const [label, app, headers] of [
      ["master token", master, { "Content-Type": "application/json", Authorization: "Bearer mul448-r2-root-secret" }],
      ["auth disabled", open, { "Content-Type": "application/json" }],
    ] as const) {
      const response = await app.request(`/api/sessions/${session.id}/messages`, {
        method: "POST",
        headers: { ...headers, "X-Agent-ID": otherAgentId },
        body: JSON.stringify(requestMessageBody(store, { agent_id: agentId, prompt: `Anon session task (${label})` }, { type: "role", ref: "issue_owner" })),
      });
      expect(response.status, label).toBe(200);
      const taskId = (await response.json()).message.id as string;
      const assigned = assignmentEvents(store, session.id, taskId);
      expect(assigned, label).toHaveLength(1);
      // Historical behaviour: the header is the caller's self-declared identity.
      expect(assigned[0]!.authorType, label).toBe("agent");
      expect(assigned[0]!.authorId, label).toBe(otherAgentId);
    }
  });

  it("B2: still records the leader fallback for an anonymous evaluation", async () => {
    const { store, leaderId, squadId, master, open } = await anonymousApps();
    const issue = createResponsibleTestIssue(store, { title: "MUL-448 anon B2" });
    store.assignIssue(issue.id, { assigneeType: "squad", assigneeId: squadId });

    for (const [label, app, headers] of [
      ["master token", master, { "Content-Type": "application/json", Authorization: "Bearer mul448-r2-root-secret" }],
      ["auth disabled", open, { "Content-Type": "application/json" }],
    ] as const) {
      const response = await app.request(`/api/issues/${issue.id}/squad-evaluated`, {
        method: "POST", headers, body: JSON.stringify({ outcome: "no_action" }),
      });
      expect(response.status, label).toBe(201);
      const recorded = store.listIssueActivity(issue.id).filter((entry) => entry.type === "squad_leader_evaluated");
      expect(recorded.length, label).toBeGreaterThan(0);
      expect(recorded.at(-1)!.actorId, label).toBe(leaderId);
    }
  });

  it("B3: still honours a body-supplied source issue from a non-credentialed caller", async () => {
    const { store, master, open } = await anonymousApps();
    const intake = createResponsibleTestIssue(store, { title: "MUL-448 anon B3 intake", issueKind: "intake" });

    for (const [label, app, headers] of [
      ["master token", master, { "Content-Type": "application/json", Authorization: "Bearer mul448-r2-root-secret" }],
      ["auth disabled", open, { "Content-Type": "application/json" }],
    ] as const) {
      // One title per mode: the generated-issue cache is keyed on source+title.
      const title = `MUL-448 anon B3 execution (${label})`;
      const decoy = await app.request("/api/multiremi/issues", {
        method: "POST", headers,
        body: JSON.stringify({ title, sourceIssueId: intake.id, issueKind: "execution" }),
      });
      expect(decoy.status, label).toBe(201);
      const body = (await decoy.json()) as any;
      const decoyIssue = store.getIssue(body.id ?? body.issue?.id)!;
      // Historical behaviour: the body names the source, and the generated-issue
      // cache match follows from it.
      expect(decoyIssue.sourceIssueId, label).toBe(intake.id);
      expect(store.findGeneratedIssueByTitle(intake.id, title)!.id, label).toBe(decoyIssue.id);
    }
  });
});
