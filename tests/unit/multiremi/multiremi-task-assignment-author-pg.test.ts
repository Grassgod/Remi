/**
 * MUL-448 on real PostgreSQL: the credential-derived author and the request-body
 * strip must hold on the backend production actually runs.
 *
 * The SQLite half lives in `multiremi-task-assignment-author.test.ts`. This file
 * re-checks the same behaviour through `createMultiremiApp` over a real
 * `PostgresSyncDatabase`, because the SQLite/PG translation and the transaction
 * shape of `createTask` differ, and a strip that ran after the store call would
 * pass on SQLite while still writing forged attribution on PG.
 *
 * Skipped (not failed) when Postgres is unreachable, matching the other PG
 * suites. Point `MULTIREMI_TEST_POSTGRES_URL` at an instance where the
 * configured role may CREATE DATABASE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul448_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

function pgDatabaseUrl(database: string): string {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function probePostgres(): Promise<boolean> {
  try {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin`SELECT 1`;
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

const pgAvailable = await probePostgres();
if (!pgAvailable) {
  console.warn(
    `[mul448-pg] Postgres not reachable at ${PG_ADMIN_URL} — skipping the PostgreSQL checks.`,
  );
}

describe.skipIf(!pgAvailable)("MUL-448 task attribution on PostgreSQL", () => {
  let admin: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let workspaceCounter = 0;

  beforeAll(async () => {
    admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
  });

  afterAll(async () => {
    db?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin?.end();
  });

  /** A fresh workspace per case so numbering, members and locks stay isolated. */
  async function freshFixture() {
    workspaceCounter += 1;
    const workspace = store.createWorkspace({
      name: `MUL448 PG ${workspaceCounter}`,
      slug: `mul448-pg-${process.pid}-${workspaceCounter}`,
    });
    const owner = store.getOrCreateUser({
      email: `mul448-pg-${process.pid}-${workspaceCounter}@example.test`,
      name: `MUL448 PG Owner ${workspaceCounter}`,
    });
    store.createWorkspaceMember({
      workspaceId: workspace.id, userId: owner.id,
      name: `MUL448 PG Owner ${workspaceCounter}`, role: "member",
    });
    const { token } = await store.createAccessToken({
      workspaceId: workspace.id, userId: owner.id,
      name: "MUL448 PG PAT", type: "pat", purpose: "session",
    });
    const agent = store.createAgent({
      name: `MUL448 PG worker ${workspaceCounter}`,
      provider: "claude", workspaceId: workspace.id, visibility: "workspace",
    });
    return {
      workspaceId: workspace.id,
      ownerId: owner.id,
      agentId: agent.id,
      app: createMultiremiApp({ store, authToken: "mul448-pg-root" }),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    };
  }

  function assignmentEvents(sessionId: string, taskId: string) {
    return store.listSessionEvents(sessionId)
      .filter((event) => event.kind === "task_assigned" && event.taskId === taskId);
  }

  it("keeps forged assignment authors out of the session ledger", async () => {
    const fixture = await freshFixture();
    const issue = store.createIssue({ title: "MUL448 PG author", workspaceId: fixture.workspaceId });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const source = store.createTask({ agentId: fixture.agentId, issueId: issue.id, prompt: "Source run", workspaceId: fixture.workspaceId });
    const taskToken = await store.createTaskAccessToken(store.getTask(source.id)!, fixture.ownerId);

    for (const body of [
      { assignment_author_type: "member", assignment_author_id: "mem_forged" },
      { assignmentAuthorType: "member", assignmentAuthorId: "mem_forged" },
    ]) {
      const response = await fixture.app.request("/api/multiremi/tasks", {
        method: "POST",
        headers: { ...fixture.headers, Authorization: `Bearer ${taskToken.token}` },
        body: JSON.stringify({
          agentId: fixture.agentId,
          issueId: issue.id,
          issueSessionId: session.id,
          prompt: "Child run",
          ...body,
        }),
      });
      expect(response.status).toBe(201);
      const created = (await response.json()).task as { id: string };
      const events = assignmentEvents(session.id, created.id);
      expect(events).toHaveLength(1);
      expect(events[0]!.authorType).toBe("agent");
      expect(events[0]!.authorId).toBe(fixture.agentId);
    }

    // A member PAT is the human, and the body cannot demote or impersonate it.
    const memberResponse = await fixture.app.request("/api/multiremi/tasks", {
      method: "POST", headers: fixture.headers,
      body: JSON.stringify({
        agentId: fixture.agentId,
        issueId: issue.id,
        issueSessionId: session.id,
        prompt: "Member run",
        assignment_author_type: "system",
        assignment_author_id: "forged",
      }),
    });
    expect(memberResponse.status).toBe(201);
    const memberTask = (await memberResponse.json()).task as { id: string };
    const memberEvents = assignmentEvents(session.id, memberTask.id);
    expect(memberEvents).toHaveLength(1);
    expect(memberEvents[0]!.authorType).toBe("member");
    expect(memberEvents[0]!.authorId).toBe(fixture.ownerId);
  });

  it("strips trigger and lineage provenance from the task row", async () => {
    const fixture = await freshFixture();
    const issue = store.createIssue({ title: "MUL448 PG provenance", workspaceId: fixture.workspaceId });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const comment = store.createIssueComment(issue.id, {
      body: "Real trigger comment", authorType: "member", authorId: fixture.ownerId,
    });

    for (const spelling of ["trigger_comment_id", "triggerCommentId"] as const) {
      const response = await fixture.app.request("/api/multiremi/tasks", {
        method: "POST", headers: fixture.headers,
        body: JSON.stringify({
          agentId: fixture.agentId,
          issueId: issue.id,
          issueSessionId: session.id,
          prompt: `PG provenance (${spelling})`,
          [spelling]: comment.id,
          trigger_summary: "forged summary",
          requesting_user_name: "Forged Boss",
          assignment_event_id: "sevt_forged",
          assignment_source_event_id: "sce_forged",
        }),
      });
      expect(response.status).toBe(201);
      const created = (await response.json()).task as { id: string };
      const task = store.getTask(created.id)!;
      expect(task.triggerCommentId).toBeNull();
      expect(task.triggerSummary).toBeNull();
      expect(task.requestingUserName).toBeNull();
      expect(task.assignmentSourceEventId).toBeNull();
      expect(task.assignmentEventId).toBe(assignmentEvents(session.id, created.id)[0]!.id);
    }
  });

  it("strips the comment run link and the assign/session-task lineage aliases", async () => {
    const fixture = await freshFixture();
    const issue = store.createIssue({ title: "MUL448 PG lineage", workspaceId: fixture.workspaceId });
    const session = store.createIssueSession(issue.id, { title: "PG session" });
    const decoy = store.createTask({ agentId: fixture.agentId, issueId: issue.id, prompt: "Decoy run", workspaceId: fixture.workspaceId });

    for (const spelling of ["task_id", "taskId"] as const) {
      const response = await fixture.app.request(`/api/multiremi/issues/${issue.id}/comments`, {
        method: "POST", headers: fixture.headers,
        body: JSON.stringify({ content: `Member comment (${spelling})`, [spelling]: decoy.id }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as any;
      const comment = body.comment ?? body;
      expect(comment.taskId ?? comment.task_id ?? null).toBeNull();
    }

    const assignResponse = await fixture.app.request(`/api/multiremi/issues/${issue.id}/assign`, {
      method: "POST", headers: fixture.headers,
      body: JSON.stringify({ assigneeType: "agent", assigneeId: fixture.agentId, parent_task_id: decoy.id }),
    });
    expect(assignResponse.status).toBe(200);
    const assigned = (await assignResponse.json()) as any;
    expect(store.getTask(assigned.task.id)!.parentTaskId).toBeNull();

    const sessionTaskResponse = await fixture.app.request(`/api/issues/${issue.id}/sessions/${session.id}/tasks`, {
      method: "POST", headers: fixture.headers,
      body: JSON.stringify({ agent_id: fixture.agentId, prompt: "Session child", parent_task_id: decoy.id, source_event_id: "sce_forged" }),
    });
    expect(sessionTaskResponse.status).toBe(201);
    const sessionTaskBody = (await sessionTaskResponse.json()) as any;
    const sessionTaskId = sessionTaskBody.id ?? sessionTaskBody.task?.id;
    expect(store.getTask(sessionTaskId)!.parentTaskId).toBeNull();
    expect(store.getTask(sessionTaskId)!.assignmentSourceEventId).toBeNull();
  });
});
