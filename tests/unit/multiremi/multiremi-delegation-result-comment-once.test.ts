/**
 * MUL-456 fix round 1, blocker 2: the terminal transaction resolves the result
 * comment exactly once.
 *
 * QA round 1 injected a later task comment between the bridge-metadata read
 * (`tasks-repo.ts` result_comment_id) and the prompt read and observed two
 * different ids committed in the same transaction. The fix resolves the value
 * once and hands it to the drain; this suite counts the SELECTs on the real
 * terminal path and asserts that bridge metadata and prompt agree.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore } from "@multiremi/store.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import type { MultiremiIssue, MultiremiTask } from "@multiremi/contracts/types.js";

const pgAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
let sequence = 0;

/** The PG fixture creates and drops a database per case; see the sibling suite. */
const PG_TEST_TIMEOUT = 30_000;

const RESULT_COMMENT_SELECT = "SELECT id FROM multiremi_issue_comments";

async function withStore(backend: "sqlite" | "postgres", run: (store: MultiremiStore) => Promise<void>): Promise<void> {
  if (backend === "sqlite") {
    const db = new Database(":memory:");
    try {
      const store = new MultiremiStore(db);
      store.ensureLocalWorkspace();
      await run(store);
    } finally {
      db.close();
    }
    return;
  }
  const admin = new Bun.SQL(pgAdminUrl!, { max: 1 });
  const name = `mul456f1r_${process.pid}_${++sequence}`;
  const url = new URL(pgAdminUrl!);
  url.pathname = `/${name}`;
  let db: PostgresSyncDatabase | null = null;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    await run(store);
  } finally {
    db?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
}

function fixture(store: MultiremiStore) {
  const leaderRuntime = store.registerRuntime({ name: "Leader runtime", provider: "claude", workspaceId: "local" });
  const workerRuntime = store.registerRuntime({ name: "Worker runtime", provider: "claude", workspaceId: "local" });
  const leader = store.createAgent({ name: "Leader", provider: "claude", runtimeId: leaderRuntime.id });
  const worker = store.createAgent({ name: "Worker", provider: "claude", runtimeId: workerRuntime.id });
  const squad = store.createSquad({ name: "Core", leaderId: leader.id, memberIds: [worker.id] });
  const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "squad", assigneeId: squad.id });
  const child = store.createIssue({ title: "Child", parentIssueId: parent.id, status: "in_progress",
    assigneeType: "agent", assigneeId: worker.id });
  const leaderSession = store.createIssueSession(parent.id, { title: "Dispatch round" });
  const leaderTask = store.createTask({ agentId: leader.id, issueId: parent.id,
    issueSessionId: leaderSession.id, prompt: "Coordinate." });
  return { leaderRuntime, workerRuntime, leader, worker, parent, child, leaderSession, leaderTask };
}

async function dispatch(store: MultiremiStore, source: MultiremiTask, issue: MultiremiIssue, agentId: string) {
  const app = createMultiremiApp({ store, authToken: "result-comment-root" });
  const token = await store.createTaskAccessToken(source, "local");
  const response = await app.request("/api/multiremi/tasks", {
    method: "POST",
    headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, issueId: issue.id, prompt: "Execute delegated work." }),
  });
  expect(response.status).toBe(201);
  return store.getTask(((await response.json()) as { task: { id: string } }).task.id)!;
}

function finishLeaderRound(store: MultiremiStore, f: ReturnType<typeof fixture>): void {
  expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(f.leaderTask.id);
  store.buildTaskSessionProjection(f.leaderTask.id);
  store.startTask(f.leaderTask.id);
  store.completeTask(f.leaderTask.id, { output: "Task completed." });
}

/**
 * Wrap the store's db handle so the terminal path's comment SELECTs are counted
 * and a later comment is injected the moment the first one has resolved.
 *
 * Injecting *after* the first read returns is what makes the mismatch visible:
 * the bridge metadata has already captured comment A, and a second read (the
 * shape QA measured) would see the newly written comment B. With the fix the
 * second read never happens, so bridge and prompt both stay on A.
 */
function instrumentDb(store: MultiremiStore, onFirstResultCommentSelect: () => void) {
  const db = (store as unknown as {
    ctx: { db: { query: (sql: string) => Record<string, unknown> } };
  }).ctx.db;
  const original = db.query.bind(db);
  let selects = 0;
  db.query = (sql: string) => {
    const statement = original(sql);
    if (!sql.includes(RESULT_COMMENT_SELECT)) return statement;
    selects += 1;
    if (selects !== 1) return statement;
    // Call through the original statement object: bun:sqlite's `get` reads
    // `this` internally.
    const boundGet = (...params: unknown[]) => (statement.get as (...params: unknown[]) => unknown)(...params);
    return {
      ...statement,
      get: (...params: unknown[]) => {
        const row = boundGet(...params);
        onFirstResultCommentSelect();
        return row;
      },
    };
  };
  return { count: () => selects };
}

/** A single raw comment INSERT, so the injection adds no nested transaction. */
function insertRawComment(db: { run: (sql: string, ...p: unknown[]) => unknown }, input: {
  id: string; issueId: string; issueSessionId: string; taskId: string; authorType: string;
  authorId: string; body: string; createdAt: string;
}): void {
  db.run(
    `INSERT INTO multiremi_issue_comments (
       id, issue_id, issue_session_id, author_type, author_id, task_id, parent_id, body, type, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'comment', ?, ?)`,
    [input.id, input.issueId, input.issueSessionId, input.authorType, input.authorId, input.taskId,
      input.body, input.createdAt, input.createdAt],
  );
}

/** The store's raw db handle, reached the same way the injector reaches it. */
function rawDb(store: MultiremiStore) {
  return (store as unknown as { ctx: { db: { run: (sql: string, ...p: unknown[]) => unknown } } }).ctx.db;
}

for (const backend of ["sqlite", "postgres"] as const) {
  describe.skipIf(backend === "postgres" && !pgAdminUrl)(`MUL-456 result comment resolved once (${backend})`, () => {
    it("uses one id for the bridge metadata and the prompt even when a later comment lands mid-transaction", async () => {
      await withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        finishLeaderRound(store, f);
        expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
        store.buildTaskSessionProjection(childTask.id);
        store.startTask(childTask.id);
        const first = store.createIssueComment(f.child.id, {
          authorType: "agent", authorId: f.worker.id, taskId: childTask.id,
          issueSessionId: childTask.issueSessionId, body: "First result",
        });
        // Two comments exist before the terminal transaction — the second is the
        // newest. Comments do not take the workspace lifecycle lock, so the
        // mid-transaction write installed below is a real concurrent
        // interleaving, not a test-only state.
        const later = store.createIssueComment(f.child.id, {
          authorType: "agent", authorId: f.worker.id, taskId: childTask.id,
          issueSessionId: childTask.issueSessionId, body: "Later result",
        });
        const injectedAt = new Date(Date.now() + 1000).toISOString();
        const injector = instrumentDb(store, () => {
          insertRawComment(rawDb(store), {
            id: "cmt_injected_mid_transaction",
            issueId: f.child.id,
            issueSessionId: childTask.issueSessionId!,
            taskId: childTask.id,
            authorType: "agent",
            authorId: f.worker.id,
            body: "Injected mid-transaction",
            createdAt: injectedAt,
          });
        });
        store.completeTask(childTask.id, { output: "Final result" });
        const returnTask = store.listTasksForIssue(f.parent.id)
          .find((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id)!;
        expect(returnTask).toBeDefined();
        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
        const bridgeCommentId = (bridge.metadata as Record<string, unknown>).result_comment_id as string;
        // Bridge and prompt name the same comment, and it is the one the single
        // resolution saw — the newest comment that existed when the terminal
        // transaction began. A second read would have picked up the comment
        // injected mid-transaction and the prompt would then disagree with the
        // already-committed metadata, which is exactly QA's finding.
        expect(bridgeCommentId).not.toBe(first.id);
        expect(bridgeCommentId).toBe(later.id);
        expect(returnTask.prompt).toContain(`Result comment: ${bridgeCommentId}`);
        // The prompt's Result comment line is the bridge's id, so the injected
        // comment id never appears on that line.
        const promptLine = returnTask.prompt.split("\n").find((line) => line.startsWith("Result comment: "));
        expect(promptLine).toBe(`Result comment: ${bridgeCommentId}`);
        // One resolution on the terminal path: the fix threads the first value
        // through the drain instead of issuing a second SELECT.
        expect(injector.count()).toBe(1);
      });
    }, PG_TEST_TIMEOUT);

    it("records null and the ruling's fallback line when the run never commented", async () => {
      await withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        finishLeaderRound(store, f);
        expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
        store.buildTaskSessionProjection(childTask.id);
        store.startTask(childTask.id);
        const injector = instrumentDb(store, () => {});
        store.cancelTask(childTask.id);
        expect(injector.count()).toBe(1);
        const returnTask = store.listTasksForIssue(f.parent.id)
          .find((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id)!;
        expect(returnTask.prompt).toContain("Result comment: none at completion");
        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id)!;
        expect((bridge.metadata as Record<string, unknown>).result_comment_id).toBeNull();
      });
    }, PG_TEST_TIMEOUT);

    it("still delivers a bridge and a claimable return into an archived dispatch Session", async () => {
      // Ruling: the archived state is a list filter, not an end of life. The
      // return must keep landing in the Session the leader dispatched from, and
      // the daemon must still be able to claim it.
      await withStore(backend, async (store) => {
        const f = fixture(store);
        const childTask = await dispatch(store, f.leaderTask, f.child, f.worker.id);
        // Finish the leader's round, then archive the Session it dispatched
        // from — the state QA reproduced before ending the delegated task.
        finishLeaderRound(store, f);
        store.updateIssueSession(f.leaderSession.id, { status: "archived" });
        expect(store.getIssueSession(f.leaderSession.id)?.status).toBe("archived");
        expect(store.claimTask(f.workerRuntime.id)?.id).toBe(childTask.id);
        store.buildTaskSessionProjection(childTask.id);
        store.startTask(childTask.id);
        store.completeTask(childTask.id, { output: "Report from the archived round." });

        const bridge = store.listSessionEvents(f.leaderSession.id)
          .find((event) => event.kind === "delegation_report" && event.taskId === childTask.id);
        expect(bridge).toBeDefined();
        const returnTask = store.listTasksForIssue(f.parent.id)
          .find((task) => task.agentId === f.leader.id && task.parentTaskId === childTask.id);
        expect(returnTask).toBeDefined();
        expect(returnTask!.status).toBe("queued");
        expect(returnTask!.issueSessionId).toBe(f.leaderSession.id);
        expect(store.getTask(childTask.id)?.delegationReturnTaskId).toBe(returnTask!.id);
        // The queued return is really claimable — the daemon is not left with a
        // task it can never pick up because its Session is archived.
        expect(store.claimTask(f.leaderRuntime.id)?.id).toBe(returnTask!.id);
        store.buildTaskSessionProjection(returnTask!.id);
        expect(store.startTask(returnTask!.id).status).toBe("running");
        expect(store.completeTask(returnTask!.id, { output: "Reviewed." }).status).toBe("completed");
      });
    }, PG_TEST_TIMEOUT);
  });
}
