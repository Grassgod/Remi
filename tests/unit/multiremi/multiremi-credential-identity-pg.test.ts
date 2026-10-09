import { createResponsibleTestIssue } from './helpers.js';
import { requestMessageBody, sentTask } from "./unified-test-paths.js";
/**
 * MUL-448 QA round 1 follow-up (B1-B4) on real PostgreSQL.
 *
 * The SQLite half lives in `multiremi-credential-identity.test.ts`. This file
 * re-runs the same credential-vs-body matrix through `createMultiremiApp` on a
 * real `PostgresSyncDatabase`, because the SQL translation, the transaction
 * shape and the activity writes differ between the two backends - a strip that
 * ran after the store call would still pass on SQLite.
 *
 * Skipped (not failed) when Postgres is unreachable, matching the other PG
 * suites. Point `MULTIREMI_TEST_POSTGRES_URL` at an instance whose role may
 * CREATE DATABASE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul448_r2_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

function pgDatabaseUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe("SELECT 1");
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn("[mul448-r2-pg] Postgres unreachable; skipping the PostgreSQL checks.");
}

describe.skipIf(!pgAvailable)("MUL-448 credential identity on PostgreSQL", () => {
  let admin: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let workspaceCounter = 0;

  beforeAll(async () => {
    admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe("DROP DATABASE IF EXISTS " + TEST_DB + " WITH (FORCE)");
    await admin.unsafe("CREATE DATABASE " + TEST_DB);
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    db?.close();
    await admin?.unsafe("DROP DATABASE IF EXISTS " + TEST_DB + " WITH (FORCE)");
    await admin?.end();
  });

  /** A fresh workspace per case so numbering, members and squads stay isolated. */
  async function freshFixture() {
    workspaceCounter += 1;
    const workspace = store.createWorkspace({
      name: "MUL448 R2 PG " + workspaceCounter,
      slug: "mul448-r2-pg-" + process.pid + "-" + workspaceCounter,
    });
    const owner = store.getOrCreateUser({
      email: "mul448-r2-pg-" + process.pid + "-" + workspaceCounter + "@example.test",
      name: "MUL448 R2 PG Owner " + workspaceCounter,
    });
    const member = store.createWorkspaceMember({
      workspaceId: workspace.id, userId: owner.id,
      name: "MUL448 R2 PG Owner " + workspaceCounter, role: "member",
    });
    const tokenResult = await store.createAccessToken({
      workspaceId: workspace.id, userId: owner.id,
      name: "MUL448 R2 PG PAT", type: "pat", purpose: "session",
    });
    const agent = store.createAgent({
      name: "MUL448 R2 PG worker " + workspaceCounter,
      provider: "claude", workspaceId: workspace.id, visibility: "workspace",
    });
    const otherAgent = store.createAgent({
      name: "MUL448 R2 PG other " + workspaceCounter,
      provider: "claude", workspaceId: workspace.id, visibility: "workspace",
    });
    const leader = store.createAgent({
      name: "MUL448 R2 PG leader " + workspaceCounter,
      provider: "claude", workspaceId: workspace.id, visibility: "workspace",
    });
    const squad = store.createSquad({
      name: "MUL448 R2 PG squad " + workspaceCounter, workspaceId: workspace.id, leaderId: leader.id,
    });
    return {
      workspaceId: workspace.id,
      ownerId: owner.id,
      memberId: member.id,
      agentId: agent.id,
      otherAgentId: otherAgent.id,
      leaderId: leader.id,
      squadId: squad.id,
      app: createMultiremiApp({ store, authToken: "mul448-r2-pg-root" }),
      headers: { Authorization: "Bearer " + tokenResult.token, "Content-Type": "application/json" },
    };
  }

  // Ruling (u), cmt_9z7t6hwo3xuh; Senior III, cmt_u7m8e7yitmai: /events uses turn.
  function assignmentEvents(sessionId: string, taskId: string) {
    return store.listSessionEvents(sessionId)
      .filter((event) => event.id === taskId);
  }

  it("B1: a member's forged X-Agent-ID loses to the credential", async () => {
    const fixture = await freshFixture();
    const forged = { ...fixture.headers, "X-Agent-ID": fixture.otherAgentId };

    const issue = createResponsibleTestIssue(store, { title: "MUL448 R2 PG B1", workspaceId: fixture.workspaceId });
    const session = store.createIssueSession(issue.id, { title: "PG B1 session" });
    const sessionTasksPath = `/api/sessions/${session.id}/messages`;
    const taskResponse = await fixture.app.request(sessionTasksPath, {
      method: "POST", headers: forged,
      body: JSON.stringify(requestMessageBody(store, { agent_id: fixture.agentId, prompt: "PG session task" })),
    });
    expect(taskResponse.status).toBe(200);
    const taskId = (await taskResponse.json()).message.id;
    const assigned = assignmentEvents(session.id, taskId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.authorType).toBe("member");
    expect(store.getWorkspaceMember(assigned[0]!.authorId!)?.userId).toBe(fixture.ownerId);

    const sessionsPath = "/api/issues/" + issue.id + "/sessions";
    const sessionResponse = await fixture.app.request(sessionsPath, {
      method: "POST", headers: forged, body: JSON.stringify({ title: "PG forged session" }),
    });
    expect(sessionResponse.status).toBe(201);
    expect(((await sessionResponse.json()) as any).created_by_id).toBe(fixture.ownerId);

    const resultsPath = sessionsPath + "/" + session.id + "/results";
    const resultResponse = await fixture.app.request(resultsPath, {
      method: "POST", headers: forged, body: JSON.stringify({ title: "PG result", body: "Body" }),
    });
    expect(resultResponse.status).toBe(201);
    const resultBody = (await resultResponse.json()) as any;
    expect(resultBody.published_by_type).toBe("member");
    expect(resultBody.published_by_id).toBe(fixture.ownerId);

    const dependsOn = createResponsibleTestIssue(store, { title: "MUL448 R2 PG B1 dependency", workspaceId: fixture.workspaceId });
    const dependenciesPath = "/api/multiremi/issues/" + issue.id + "/dependencies";
    const dependencyResponse = await fixture.app.request(dependenciesPath, {
      method: "POST", headers: forged, body: JSON.stringify({ dependsOnIssueId: dependsOn.id }),
    });
    expect(dependencyResponse.status).toBe(201);
    const activity = store.listIssueActivity(issue.id).filter((entry) => entry.type === "issue_dependency_added");
    expect(activity).toHaveLength(1);
    expect(activity[0]!.actorType).toBe("member");
    expect(activity[0]!.actorId).toBe(fixture.ownerId);

    const source = store.createTask({
      agentId: fixture.agentId, issueId: issue.id, prompt: "Source run", workspaceId: fixture.workspaceId,
    });
    const taskToken = await store.createTaskAccessToken(store.getTask(source.id)!, fixture.ownerId);
    const tokenHeaders = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + taskToken.token,
      "X-Agent-ID": fixture.otherAgentId,
    };
    const tokenResponse = await fixture.app.request(sessionTasksPath, {
      method: "POST", headers: tokenHeaders,
      body: JSON.stringify(requestMessageBody(store, { agent_id: fixture.agentId, prompt: "PG token session task" })),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenResult = await tokenResponse.json();
    expect(tokenResult.wake_applied).toBe("inbox_only");
    expect(tokenResult.wake_reason).toBe("self");
    const tokenTaskId = tokenResult.message.id;
    const tokenAssigned = assignmentEvents(session.id, tokenTaskId);
    expect(tokenAssigned).toHaveLength(1);
    expect(tokenAssigned[0]!.authorType).toBe("agent");
    expect(tokenAssigned[0]!.authorId).toBe(fixture.agentId);
  });

  it("B2: member evaluations are rejected and only the leader records one", async () => {
    const fixture = await freshFixture();
    const issue = createResponsibleTestIssue(store, { title: "MUL448 R2 PG B2", workspaceId: fixture.workspaceId });
    store.assignIssue(issue.id, { assigneeType: "squad", assigneeId: fixture.squadId });
    const evaluationPath = "/api/issues/" + issue.id + "/squad-evaluated";

    const variants = [
      { label: "body actor_id", headers: fixture.headers, body: { outcome: "no_action", actor_id: fixture.leaderId } },
      { label: "no actor", headers: fixture.headers, body: { outcome: "no_action" } },
      { label: "X-Agent-ID", headers: { ...fixture.headers, "X-Agent-ID": fixture.leaderId }, body: { outcome: "no_action" } },
    ];
    for (const variant of variants) {
      const response = await fixture.app.request(evaluationPath, {
        method: "POST", headers: variant.headers, body: JSON.stringify(variant.body),
      });
      expect(response.status, variant.label).toBe(403);
    }

    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "squad_leader_evaluated")).toHaveLength(0);

    const leaderRun = store.createTask({
      agentId: fixture.leaderId, issueId: issue.id, prompt: "PG leader run", workspaceId: fixture.workspaceId,
    });
    const leaderToken = await store.createTaskAccessToken(store.getTask(leaderRun.id)!, fixture.ownerId);
    const leaderResponse = await fixture.app.request(evaluationPath, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + leaderToken.token },
      body: JSON.stringify({ outcome: "action", actor_id: "forged" }),
    });
    expect(leaderResponse.status).toBe(201);
    const recorded = store.listIssueActivity(issue.id).filter((entry) => entry.type === "squad_leader_evaluated");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.actorType).toBe("agent");
    expect(recorded[0]!.actorId).toBe(fixture.leaderId);
  });

  it("B3/B4: forged source lineage is dropped and no creator is stamped", async () => {
    const fixture = await freshFixture();
    const intake = createResponsibleTestIssue(store, {
      title: "MUL448 R2 PG intake", issueKind: "intake", workspaceId: fixture.workspaceId,
    });
    const generatedTitle = "MUL448 R2 PG execution";

    for (const spelling of ["sourceIssueId", "source_issue_id"]) {
      const decoy = await fixture.app.request("/api/multiremi/issues", {
        method: "POST", headers: fixture.headers,
        body: JSON.stringify({ title: generatedTitle, [spelling]: intake.id, created_by: "someone-else" }),
      });
      expect(decoy.status, spelling).toBe(201);

      const body = (await decoy.json()) as any;
      const decoyIssue = store.getIssue(body.id ?? body.issue?.id)!;
      expect(decoyIssue.sourceIssueId, spelling).toBeNull();
      expect(decoyIssue.createdBy, spelling).toBeNull();
      expect(store.listIssueSubscribers(decoyIssue.id), spelling).toHaveLength(0);
    }

    const nativeIntake = await fixture.app.request("/api/multiremi/issues", {
      method: "POST", headers: fixture.headers,
      body: JSON.stringify({ title: "MUL448 R2 PG fake intake", issueKind: "intake" }),
    });
    expect(nativeIntake.status).toBe(201);
    const fakeBody = (await nativeIntake.json()) as any;
    expect(store.getIssue(fakeBody.id ?? fakeBody.issue?.id)!.issueKind).toBe("execution");

    const intakeTask = store.createTask({ agentId: fixture.agentId, issueId: intake.id, prompt: "PG intake run" });
    const intakeToken = await store.createTaskAccessToken(store.getTask(intakeTask.id)!, fixture.ownerId);

    const generated = await fixture.app.request("/api/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + intakeToken.token },
      body: JSON.stringify({
        title: generatedTitle, workspace_id: fixture.workspaceId,
        assignee_type: "agent", assignee_id: fixture.agentId,
      }),
    });
    expect(generated.status).toBe(201);
    const generatedBody = (await generated.json()) as any;
    const created = store.getIssue(generatedBody.id)!;
    expect(created.sourceIssueId).toBe(intake.id);
    expect(created.issueKind).toBe("execution");
    expect(generatedBody.task_id).toBeTruthy();
  });

  it("keeps the anonymous compatibility mode's historical identity reading", async () => {
    const fixture = await freshFixture();
    const open = createMultiremiApp({ store, authToken: null });
    const issue = createResponsibleTestIssue(store, { title: "MUL448 R2 PG anon", workspaceId: fixture.workspaceId });
    const session = store.createIssueSession(issue.id, { title: "PG anon session" });
    const response = await open.request(
      `/api/sessions/${session.id}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-ID": fixture.otherAgentId },
        body: JSON.stringify(requestMessageBody(store, { agent_id: fixture.agentId, prompt: "PG anon session task" })),
      },
    );
    expect(response.status).toBe(200);
    const taskId = (await response.json()).message.id;
    const assigned = assignmentEvents(session.id, taskId);
    expect(assigned).toHaveLength(1);
    expect(assigned[0]!.authorType).toBe("agent");
    expect(assigned[0]!.authorId).toBe(fixture.otherAgentId);
  });
});
