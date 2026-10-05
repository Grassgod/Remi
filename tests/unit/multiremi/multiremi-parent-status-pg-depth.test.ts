import { issueMessagesPath, requestMessageBody } from "./unified-test-paths.js";
import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
/**
 * MUL-400 S1 on real PostgreSQL: the same transaction-depth ceiling the SQLite
 * suite asserts, plus the two cases that only a second connection can produce —
 * the E2 hook's own atomicity and the "two children end while the owner is
 * busy" coalescing contract.
 *
 * Depth 1 is a hard contract for these entry points, not a bridge limit (Senior
 * ruling cmt_96e1yqxgifms §1,
 * docs/adr/0011-transaction-ownership-and-side-effect-timing.md). The depth
 * counter wraps the `PostgresSyncDatabase` the store was built with and counts
 * every `transaction()` frame, outer and nested: a nested frame is a SAVEPOINT
 * (MUL-405), the cross-repo-reuse safety net (ADR 0011 §2), not a frame a
 * guarded helper may add. It also records the actual transaction-control SQL:
 * before the outer COMMIT, no second BEGIN or premature COMMIT is allowed, and a
 * nested layer may only SAVEPOINT / RELEASE SAVEPOINT / ROLLBACK TO SAVEPOINT.
 * The post-commit hook, atomicity, rollback and event checks stay as they are.
 *
 * Skipped (not failed) when Postgres is unreachable, matching the other PG
 * suites. Point `MULTIREMI_TEST_POSTGRES_URL` at an instance where the
 * configured role may CREATE DATABASE.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createMultiremiApp } from "@multiremi/api.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { StoreContext } from "@multiremi/store/context.js";
import { MultiremiStore, daemonRuntimeId } from "@multiremi/store.js";
import { inboxFlowFixture, triggerInboxFlow } from "./fixtures/inbox-flow-fixture.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul406_pg_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

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
    `[mul406-pg] Postgres not reachable at ${PG_ADMIN_URL} — skipping the PostgreSQL depth checks.`,
  );
}

interface TransactionControl {
  sql: string;
  invocationDepth: number;
  callbackDepth: number;
  inTransaction: boolean;
}

interface DepthCounter {
  max: number;
  controls: TransactionControl[];
  taskInserts: TransactionControl[];
  reset(): void;
  assertTransactionControl(label?: string): void;
}

/** Wrap `transaction()` on the real handle; the store's proxy forwards to it. */
function transactionDepthCounter(database: PostgresSyncDatabase): DepthCounter {
  const original = database.transaction.bind(database);
  const counter: DepthCounter = {
    max: 0,
    controls: [],
    taskInserts: [],
    reset() {
      counter.assertTransactionControl("before the next entry point");
      counter.max = 0;
      counter.controls = [];
      counter.taskInserts = [];
    },
    assertTransactionControl(label = "PG transaction control") {
      let outerOpen = false;
      const savepoints: string[] = [];
      for (const control of counter.controls) {
        const detail = `${label}: ${control.sql}`;
        if (control.sql === "BEGIN") {
          expect(outerOpen, detail).toBe(false);
          expect(control.inTransaction, detail).toBe(false);
          expect(control.invocationDepth, detail).toBe(1);
          expect(control.callbackDepth, detail).toBe(0);
          outerOpen = true;
        } else if (control.sql === "COMMIT" || control.sql === "ROLLBACK") {
          expect(outerOpen, detail).toBe(true);
          expect(control.inTransaction, detail).toBe(true);
          expect(control.invocationDepth, detail).toBe(1);
          expect(control.callbackDepth, detail).toBe(0);
          expect(savepoints, detail).toHaveLength(0);
          outerOpen = false;
        } else {
          expect(outerOpen, detail).toBe(true);
          expect(control.inTransaction, detail).toBe(true);
          expect(control.invocationDepth, detail).toBeGreaterThan(1);
          expect(control.sql, detail).toMatch(/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) \w+$/);
          const name = control.sql.split(" ").at(-1)!;
          if (control.sql.startsWith("SAVEPOINT ")) savepoints.push(name);
          else {
            // RELEASE or ROLLBACK TO ends the level; main's skeleton sends no RELEASE after a ROLLBACK TO.
            expect(savepoints.at(-1), detail).toBe(name);
            savepoints.pop();
          }
        }
      }
      expect(outerOpen, label).toBe(false);
      expect(savepoints, label).toHaveLength(0);
    },
  };
  let depth = 0;
  let callbackDepth = 0;
  // Observe statements at the bridge boundary and retain callback ownership.
  const target = database as unknown as { execute(sql: string, params: unknown[]): unknown };
  const execute = target.execute.bind(database);
  target.execute = (sql, params) => {
    const command = sql.trim().toUpperCase();
    if (/INSERT\s+INTO\s+MULTIREMI_TURN_ATTEMPTS\b/.test(command)) {
      counter.taskInserts.push({ sql: command, invocationDepth: depth, callbackDepth, inTransaction: database.inTransaction });
    }
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START TRANSACTION|END|ABORT)\b/.test(command)) {
      counter.controls.push({ sql: command, invocationDepth: depth, callbackDepth, inTransaction: database.inTransaction });
    }
    return execute(sql, params);
  };
  (database as unknown as { transaction: unknown }).transaction =
    (fn: (...args: never[]) => unknown) => {
      const run = original((...args: never[]) => {
        callbackDepth += 1;
        try { return fn(...args); }
        finally { callbackDepth -= 1; }
      }) as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => {
        depth += 1;
        counter.max = Math.max(counter.max, depth);
        try {
          return run(...args);
        } finally {
          depth -= 1;
        }
      };
    };
  return counter;
}

function waitForWorkerPhase(
  worker: Worker,
  expectedPhase: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`worker did not reach ${expectedPhase} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (event: MessageEvent<Record<string, unknown>>) => {
      if (event.data.phase === "error") {
        cleanup();
        reject(new Error(String(event.data.error ?? "worker failed")));
      } else if (event.data.phase === expectedPhase) {
        cleanup();
        resolve(event.data);
      }
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(event.error ?? new Error(event.message));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
  });
}

describe.skipIf(!pgAvailable)("MUL-400 S1 on PostgreSQL", () => {
  let admin: Bun.SQL;
  let db: PostgresSyncDatabase;
  let store: MultiremiStore;
  let counter: DepthCounter;
  let workspaceCounter = 0;

  beforeAll(async () => {
    admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    db = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    counter = transactionDepthCounter(db);
  });

  afterAll(async () => {
    db?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(() => counter.reset());
  afterEach(() => counter.assertTransactionControl());

  /** A fresh workspace per case, so issue numbering and locks stay isolated. */
  function freshWorkspace(): { workspaceId: string; agent: string; runtime: string } {
    workspaceCounter += 1;
    const workspaceId = store.createWorkspace({
      name: `MUL406 PG ${workspaceCounter}`,
      slug: `mul406-pg-${process.pid}-${workspaceCounter}`,
    }).id;
    const runtime = store.registerRuntime({
      id: `rt_mul406_${workspaceCounter}`,
      name: "Depth worker",
      provider: "claude",
      maxConcurrency: 8,
      workspaceId,
    });
    const agent = store.createAgent({
      name: `Depth owner ${workspaceCounter}`,
      provider: "claude",
      runtimeId: runtime.id,
      workspaceId,
    });
    return { workspaceId, agent: agent.id, runtime: runtime.id };
  }

  function staleLaneClaim() {
    const { workspaceId, agent, runtime } = freshWorkspace();
    const issue = store.createIssue({ title: "PG stale lane", workspaceId });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(session.id, { agentId: agent, prompt: "Claim stale lane" });
    store.getOrCreateSessionAgentLane(session.id, agent);
    db.run(
      `UPDATE multiremi_session_lanes SET provider_session_id = 'expired',
       provider = 'claude', runtime_id = ?, provider_cursor_seq = 1,
       execution_fingerprint = 'expired' WHERE session_id = ? AND reader_type = 'agent' AND reader_id = ?`,
      [runtime, session.id, agent],
    );
    return { issue, task, runtime };
  }

  it("publishes a stale lane reset once after claim commits on Postgres", () => {
    const { issue, task, runtime } = staleLaneClaim();
    const events: boolean[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "session_agent_lane_reset") {
        events.push(db.inTransaction);
      }
    });
    try {
      expect(store.claimTask(runtime)?.id).toBe(task.id);
    } finally {
      unsubscribe();
    }
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "session_agent_lane_reset")).toHaveLength(1);
    expect(events).toEqual([false]);
  });

  it("rolls back a stale lane reset without publishing on Postgres", () => {
    const { issue, task, runtime } = staleLaneClaim();
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "session_agent_lane_reset") {
        events.push(event.type);
      }
    });
    const original = StoreContext.prototype.appendIssueActivity;
    let observedBeforeRollback = false;
    StoreContext.prototype.appendIssueActivity = function patched(this: StoreContext, issueId, input, queue) {
      original.call(this, issueId, input, queue);
      if (input.type !== "session_agent_lane_reset") return;
      const reader = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
      try {
        const rows = reader.query("SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = 'session_agent_lane_reset'").all(issue.id);
        const selected = reader.query("SELECT status FROM multiremi_turn_execution_records WHERE id = ?").get(task.id) as { status: string };
        observedBeforeRollback = rows.length === 0 && selected.status === "queued";
      } finally {
        reader.close();
      }
      throw new Error("PG claim rollback injection");
    };
    try {
      expect(() => store.claimTask(runtime)).toThrow("PG claim rollback injection");
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribe();
    }
    expect(observedBeforeRollback).toBe(true);
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "session_agent_lane_reset")).toHaveLength(0);
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(events).toEqual([]);
  });

  for (const path of ["held parent", "assign unassign", "update unassign"] as const) {
    function activityCase() {
      const { workspaceId, agent } = freshWorkspace();
      const issue = store.createIssue({
        title: `PG audit ${path}`, workspaceId, status: "in_progress",
        assigneeType: "agent", assigneeId: agent,
      });
      let taskId: string | null = null;
      if (path === "held parent") {
        store.createIssue({ title: "PG open child", workspaceId, parentIssueId: issue.id, status: "in_progress" });
      } else {
        taskId = store.createTask({ agentId: agent, issueId: issue.id, prompt: "PG queued work" }).id;
      }
      const run = () => path === "held parent"
        ? store.updateIssue(issue.id, { status: "done" }, { holdParentStatus: true })
        : path === "assign unassign"
          ? store.assignIssue(issue.id, { assigneeType: null, assigneeId: null })
          : store.updateIssue(issue.id, { assigneeType: null, assigneeId: null });
      return { issue, taskId, run, action: path === "held parent" ? "parent_status_held" : "issue_unassigned" };
    }

    it(`${path}: publishes its activity after PG commit`, () => {
      const { issue, run, action } = activityCase();
      const events: Array<{ action: string; inTransaction: boolean }> = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created") events.push({
          action: (event.payload.entry as { action: string }).action,
          inTransaction: db.inTransaction,
        });
      });
      try {
        run();
      } finally {
        unsubscribe();
      }
      expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === action)).toHaveLength(1);
      expect(events.filter((event) => event.action === action)).toEqual([{ action, inTransaction: false }]);
      expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
    });

    it(`${path}: rolls back its activity with no PG broadcast`, () => {
      const { issue, taskId, run, action } = activityCase();
      const events: string[] = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created") events.push((event.payload.entry as { action: string }).action);
      });
      const original = StoreContext.prototype.appendIssueActivity;
      let invisibleBeforeRollback = false;
      StoreContext.prototype.appendIssueActivity = function patched(this: StoreContext, issueId, input, queue) {
        original.call(this, issueId, input, queue);
        if (input.type !== action) return;
        const reader = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
        try {
          const rows = reader.query("SELECT id FROM multiremi_issue_activity WHERE issue_id = ? AND type = ?").all(issue.id, action);
          const task = taskId
            ? reader.query("SELECT status FROM multiremi_turn_execution_records WHERE id = ?").get(taskId) as { status: string }
            : null;
          invisibleBeforeRollback = rows.length === 0 && (!task || task.status === "queued");
        } finally {
          reader.close();
        }
        throw new Error("PG activity rollback injection");
      };
      try {
        expect(run).toThrow("PG activity rollback injection");
      } finally {
        StoreContext.prototype.appendIssueActivity = original;
        unsubscribe();
      }
      expect(invisibleBeforeRollback).toBe(true);
      expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === action)).toHaveLength(0);
      if (taskId) expect(store.getTask(taskId)?.status).toBe("queued");
      expect(events).toEqual([]);
    });
  }

  it("keeps updateIssue(child -> done) at depth 1 on Postgres (owner busy: coalesced)", () => {
    const { workspaceId, agent } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG busy parent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const running = store.createTask({ agentId: agent, issueId: parent.id, prompt: "current round" });
    runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [running.id]);
    const child = store.createIssue({
      title: "PG busy child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
    });

    counter.reset();
    store.updateIssue(child.id, { status: "done" });
    expect(counter.max).toBe(1);
    expect(counter.taskInserts).toHaveLength(1);
    expect(counter.taskInserts[0]).toMatchObject({ invocationDepth: 1, callbackDepth: 1, inTransaction: true });
    const queued = store.listTasksForIssue(parent.id).filter((task) => task.status === "queued");
    expect(queued).toHaveLength(1);
    expect(store.listIssueComments(parent.id).filter(comment => comment.authorType === "system")[0]!.body)
      .toContain("is done");
  });

  it("keeps updateIssue(child -> done) at depth 1 on Postgres (owner free: fresh round)", () => {
    const { workspaceId, agent } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG free parent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const child = store.createIssue({
      title: "PG free child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
    });

    counter.reset();
    store.updateIssue(child.id, { status: "done" });
    expect(counter.max).toBe(1);
    expect(counter.taskInserts).toHaveLength(1);
    expect(counter.taskInserts[0]).toMatchObject({ invocationDepth: 1, callbackDepth: 1, inTransaction: true });
    expect(store.listTasksForIssue(parent.id).filter((task) => task.status === "queued")).toHaveLength(1);
  });

  for (const scenario of ["e3", "e4"] as const) {
    it(`inserts the ${scenario} pending turn inside its state transaction at depth 1 on Postgres`, () => {
      const flow = inboxFlowFixture(store, scenario);
      counter.reset();
      triggerInboxFlow(store, flow);
      expect(counter.max).toBe(1);
      expect(counter.taskInserts).toHaveLength(1);
      expect(counter.taskInserts[0]).toMatchObject({ invocationDepth: 1, callbackDepth: 1, inTransaction: true });
    });
  }

  /**
   * MUL-457 QA round 1, blocker 1: on real Postgres the status write and its
   * audit rows were three separate transactions, so an injected failure after
   * the grant-used INSERT still left the parent `done` and the listeners
   * notified. Both writers must now roll the whole thing back, and the SCM
   * effect must stay retryable.
   */
  it("rolls the API status and audit rows back on a grant-used failure (Postgres)", () => {
    const { workspaceId, agent } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG grant parent", workspaceId, status: "in_progress",
      assigneeType: "agent", assigneeId: agent,
    });
    store.updateIssue(store.createIssue({
      title: "PG grant child", workspaceId, parentIssueId: parent.id, status: "in_progress",
    }).id, { status: "done" });
    store.grantParentDone(parent.id, workspaceId);
    store.createIssueComment(parent.id, { body: "PG summary", authorType: "agent", authorId: agent });

    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") events.push(entry?.action ?? "");
    });
    const original = StoreContext.prototype.appendIssueActivity;
    let injected = false;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      issueId: string,
      input: { type: string },
      ...rest: unknown[]
    ) {
      original.call(this, issueId, input as never, ...rest as [never]);
      if (input.type === "parent_done_grant_used") {
        injected = true;
        throw new Error("pg grant-used injection");
      }
    } as typeof StoreContext.prototype.appendIssueActivity;
    let thrown: Error | null = null;
    try {
      store.updateIssue(parent.id, { status: "done", actorType: "agent", actorId: agent });
    } catch (err) {
      thrown = err as Error;
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribe();
    }
    expect(injected).toBe(true);
    expect(thrown?.message).toBe("pg grant-used injection");
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    const types = store.listIssueActivity(parent.id).map((entry) => entry.type);
    expect(types).not.toContain("issue_updated");
    expect(types).not.toContain("parent_done_grant_used");
    expect(events).toHaveLength(0);

    // The retry settles exactly once.
    store.updateIssue(parent.id, { status: "done", actorType: "agent", actorId: agent });
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "parent_done_grant_used")).toHaveLength(1);
  });

  it("returns 409 details under data on Postgres (both prefixes)", async () => {
    // HTTP routes resolve the compatibility prefix against `local`, so this
    // case seeds its own agent there instead of a throwaway workspace.
    const agent = store.createAgent({
      name: `PG 409 owner ${workspaceCounter += 1}`,
      provider: "claude",
      workspaceId: "local",
    }).id;
    const workspaceId = "local";
    const parent = store.createIssue({
      title: "PG 409 parent", workspaceId, status: "in_progress",
      assigneeType: "agent", assigneeId: agent,
    });
    store.updateIssue(store.createIssue({
      title: "PG 409 child", workspaceId, parentIssueId: parent.id, status: "in_progress",
    }).id, { status: "done" });
    store.grantParentDone(parent.id, workspaceId);
    const task = store.createTask({ agentId: agent, issueId: parent.id, prompt: "PG 409 round" });
    const taskToken = await store.createTaskAccessToken(task, workspaceId);
    const app = createMultiremiApp({ store });
    for (const base of ["/api/issues", "/api/multiremi/issues"]) {
      const response = await app.request(`${base}/${parent.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${taskToken.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      expect(response.status, base).toBe(409);
      const body = await response.json();
      expect(body, base).toMatchObject({
        code: "final_summary_missing",
        data: { lastChildClosedAt: expect.any(String) },
      });
      expect(body.last_child_closed_at, base).toBeUndefined();
    }
  });

  it("rolls the SCM status, audit rows and effect mark back on a grant-used failure (Postgres)", () => {
    const { workspaceId, agent } = freshWorkspace();
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const repoId = `repo_pg_mul457_${workspaceCounter}`;
    store.updateWorkspace(workspaceId, {
      repos: [{
        id: repoId,
        name: "pg-mul457",
        url: "git@github.com:acme/pg-mul457.git",
        source: "github",
        default_branch: "main",
      }],
      settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
    });
    const connection = store.createScmConnection({
      workspaceId, name: "PG SCM atomic", provider: "github", mode: "hybrid",
      accessToken: "test-only-token", webhookSecret: "pg-webhook-secret", repositoryIds: [repoId],
    });
    const parent = store.createIssue({
      title: "PG SCM atomic parent", workspaceId, status: "in_progress",
      assigneeType: "agent", assigneeId: agent,
    });
    store.updateIssue(store.createIssue({
      title: "PG SCM atomic child", workspaceId, parentIssueId: parent.id, status: "in_progress",
    }).id, { status: "done" });
    store.grantParentDone(parent.id, workspaceId);
    store.createIssueComment(parent.id, { body: "PG SCM summary", authorType: "agent", authorId: agent });
    const externalId = `77${workspaceCounter}`;
    store.advanceScmEntitySnapshot({
      connectionId: connection.id, repositoryId: repoId, entityType: "change_request",
      externalId, revisionAt: new Date().toISOString(), revision: `v-${externalId}`,
      contentHash: `pg-${externalId}`,
      payload: {
        number: Number(externalId), title: `${parent.key} pg atomic`, state: "merged",
        source_branch: `agent/${parent.key}`, url: "https://github.com/acme/pg-mul457/pull/77",
      },
    });
    const recordMerge = (logicalKey: string) => store.recordScmCanonicalEvent({
      workspaceId, connectionId: connection.id, repositoryId: repoId,
      type: "change.merged", subjectType: "change_request", subjectId: externalId,
      logicalKey, fidelity: "inferred",
      payload: { number: Number(externalId), branch: "main", mergeSha: "pgsha" },
      evidence: { source: "poll", dedupeKey: `poll:${logicalKey}`, providerEventId: null },
    });

    const original = StoreContext.prototype.appendIssueActivity;
    let injected = false;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      issueId: string,
      input: { type: string },
      ...rest: unknown[]
    ) {
      original.call(this, issueId, input as never, ...rest as [never]);
      if (input.type === "parent_done_grant_used") {
        injected = true;
        throw new Error("pg scm grant-used injection");
      }
    } as typeof StoreContext.prototype.appendIssueActivity;
    try {
      recordMerge(`change.merged:${externalId}:pg-atomic`);
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
    }
    expect(injected).toBe(true);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    const types = store.listIssueActivity(parent.id).map((entry) => entry.type);
    expect(types).not.toContain("parent_done_grant_used");
    expect(types).not.toContain("scm_merge_completed");
    const pending = db.query(
      "SELECT status, last_error FROM multiremi_scm_effects WHERE issue_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(parent.id) as { status?: string; last_error?: string | null } | null;
    expect(pending?.status).toBe("pending");
    expect(String(pending?.last_error ?? "")).toContain("pg scm grant-used injection");

    recordMerge(`change.merged:${externalId}:pg-atomic`);
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "parent_done_grant_used")).toHaveLength(1);
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "scm_merge_completed")).toHaveLength(1);
    const settled = db.query(
      "SELECT status FROM multiremi_scm_effects WHERE issue_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(parent.id) as { status?: string } | null;
    expect(settled?.status).toBe("applied");
  });

  it("keeps a forged comment from satisfying A1 for the authorized agent (Postgres)", async () => {
    const workspaceId = "local";
    const agent = store.createAgent({
      name: `PG forgery owner ${workspaceCounter += 1}`,
      provider: "claude",
      workspaceId,
    }).id;
    const other = store.createAgent({ name: "PG other agent", provider: "claude", workspaceId });
    const parent = store.createIssue({
      title: "PG forgery parent", workspaceId, status: "in_progress",
      assigneeType: "agent", assigneeId: agent,
    });
    store.updateIssue(store.createIssue({
      title: "PG forgery child", workspaceId, parentIssueId: parent.id, status: "in_progress",
    }).id, { status: "done" });
    store.grantParentDone(parent.id, workspaceId);
    const app = createMultiremiApp({ store });
    const ownerTask = store.createTask({ agentId: agent, issueId: parent.id, prompt: "PG owner round" });
    const ownerToken = (await store.createTaskAccessToken(ownerTask, workspaceId)).token;
    const otherTask = store.createTask({ agentId: other.id, issueId: parent.id, prompt: "PG other round" });
    const otherToken = (await store.createTaskAccessToken(otherTask, workspaceId)).token;
    const memberToken = (await store.createAccessToken({
      name: "PG member", type: "pat", workspaceId, userId: "local",
    })).token;

    const forgedByAgent = await app.request(issueMessagesPath(store, parent.id), {
      method: "POST",
      headers: { Authorization: `Bearer ${otherToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestMessageBody(store, {
        body: "PG forged summary", author_type: "agent", author_id: agent,
        authorType: "agent", authorId: agent,
      }, { type: "role", ref: "issue_owner" })),
    });
    expect(forgedByAgent.status).toBe(200);
    const agentComment = await forgedByAgent.json();
    expect(store.getIssueComment(agentComment.id)?.authorId).toBe(other.id);

    const done = () => app.request(`/api/issues/${parent.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect((await done()).status).toBe(409);
    // A member PAT forging the same identity stores a member comment instead.
    const forgedByMember = await app.request(issueMessagesPath(store, parent.id), {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestMessageBody(store, {
        body: "PG member forged summary", author_type: "agent", author_id: agent,
        authorType: "agent", authorId: agent,
      }, { type: "role", ref: "issue_owner" })),
    });
    expect(forgedByMember.status).toBe(200);
    const memberComment = await forgedByMember.json();
    expect(store.getIssueComment(memberComment.id)).toMatchObject({ authorType: "member" });
    expect((await done()).status).toBe(409);
    // The authorized agent's own comment satisfies (b).
    await app.request(issueMessagesPath(store, parent.id), {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestMessageBody(store, { body: "PG owner summary" }, { type: "role", ref: "issue_owner" })),
    });
    expect((await done()).status).toBe(200);
  });

  it("keeps the WHOLE task lifecycle at depth 1, counter armed before createTask (Postgres)", () => {
    const { workspaceId, agent, runtime } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG lifecycle parent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const child = store.createIssue({
      title: "PG lifecycle child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });

    // QA round 3: the counter must be armed BEFORE createTask. The preparation
    // phase (create -> claim -> start -> complete) is where the nested
    // `syncIssueStatusFromTaskWithinTransaction` lived, and measuring only the
    // terminal call hid it.
    counter.reset();
    const task = store.createTask({ agentId: agent, issueId: child.id, prompt: "lifecycle" });
    expect(counter.max, "createTask").toBe(1);
    // The child parked at todo, as createTask's own derivation requires.
    expect(store.getIssue(child.id)?.status).toBe("todo");

    let claimed = store.claimTask(runtime);
    while (claimed && claimed.id !== task.id) claimed = store.claimTask(runtime);
    expect(claimed?.id).toBe(task.id);
    counter.reset();
    store.startTask(task.id);
    expect(counter.max, "startTask").toBe(1);
    expect(store.getIssue(child.id)?.status).toBe("in_progress");

    counter.reset();
    store.completeTask(task.id, { output: "lifecycle done" });
    expect(counter.max, "completeTask").toBe(1);
  });

  it("keeps a comment-triggered automatic dispatch at depth 1 (Postgres)", () => {
    const { workspaceId, agent, runtime } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG dispatch parent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const child = store.createIssue({
      title: "PG dispatch child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    // A member comment that mentions the owner dispatches a round through the
    // same task-creation entry point createTask uses.
    const member = store.createWorkspaceMember({ name: "PG dispatch member", role: "member", workspaceId });
    void member;

    counter.reset();
    store.createIssueComment(child.id, {
      authorType: "member",
      authorId: "local",
      body: `[@${agent}](mention://agent/${agent}) please continue`,
    });
    expect(counter.max).toBe(1);
  });

  it("keeps completeTask, failTask and cancelTask at depth 1 on Postgres", () => {
    const { workspaceId, agent, runtime } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG terminal parent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const claimAndStart = (taskId: string) => {
      let claimed = store.claimTask(runtime);
      while (claimed && claimed.id !== taskId) claimed = store.claimTask(runtime);
      if (!claimed) throw new Error(`could not claim ${taskId}`);
      return store.startTask(taskId);
    };

    const completingChild = store.createIssue({
      title: "PG completing child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const completing = store.createTask({ agentId: agent, issueId: completingChild.id, prompt: "finish" });
    claimAndStart(completing.id);
    counter.reset();
    store.completeTask(completing.id, { output: "finished" });
    expect(counter.max, "completeTask").toBe(1);

    const failingChild = store.createIssue({
      title: "PG failing child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const failing = store.createTask({ agentId: agent, issueId: failingChild.id, prompt: "explode" });
    claimAndStart(failing.id);
    counter.reset();
    store.failTask(failing.id, { error: "boom" });
    expect(counter.max, "failTask").toBe(1);
    expect(store.getIssue(failingChild.id)?.status).toBe("blocked");

    const cancelling = store.createTask({ agentId: agent, issueId: parent.id, prompt: "cancel me" });
    counter.reset();
    store.cancelTask(cancelling.id);
    expect(counter.max, "cancelTask").toBe(1);
  });

  it("commits the child ending and rolls nothing back when the hook throws (Postgres)", () => {
    const { workspaceId, agent, runtime } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG hook parent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const child = store.createIssue({
      title: "PG hook child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });

    // Break the notification hook after the terminal transaction has committed.
    // The task-terminal path reaches it through the store facade (`ctx.issues()`),
    // which is the seam this override sits on.
    const original = store.notifyChildStatusChange.bind(store);
    let calls = 0;
    store.notifyChildStatusChange = ((..._args: Parameters<typeof original>) => {
      calls += 1;
      throw new Error("pg notification exploded");
    }) as typeof original;

    const task = store.createTask({ agentId: agent, issueId: child.id, runtimeId: runtime, prompt: "finish" });
    try {
      let claimed = store.claimTask(runtime);
      while (claimed && claimed.id !== task.id) claimed = store.claimTask(runtime);
      if (!claimed) throw new Error(`could not claim ${task.id}`);
      store.startTask(task.id);
      store.failTask(task.id, { error: "boom" });
    } finally {
      store.notifyChildStatusChange = original as typeof store.notifyChildStatusChange;
    }
    expect(calls).toBeGreaterThan(0);

    // Re-read through a second connection: the commit is durable, not just
    // visible in this process's cache.
    const other = new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB));
    const otherStore = new MultiremiStore(other);
    try {
      // The terminal transaction committed the task, the child's transition,
      // and the parent's pending round plus inbox comment before this hook ran.
      // A later notification failure cannot undo any of those durable writes.
      expect(otherStore.getTask(task.id)?.status).toBe("failed");
      expect(otherStore.getIssue(child.id)?.status).toBe("blocked");
      expect(otherStore.listTasksForIssue(parent.id)).toHaveLength(1);
      expect(otherStore.listIssueComments(parent.id).filter((comment) => comment.authorType === "system"))
        .toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it("walks child -> parent -> grandparent at depth 1 on Postgres", () => {
    const { workspaceId, agent } = freshWorkspace();
    const grandparent = store.createIssue({
      title: "PG grandparent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const parent = store.createIssue({
      title: "PG parent",
      workspaceId,
      status: "in_progress",
      parentIssueId: grandparent.id,
      assigneeType: "agent",
      assigneeId: agent,
    });
    const child = store.createIssue({
      title: "PG child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    store.createIssue({ title: "PG sibling gp", workspaceId, parentIssueId: grandparent.id, status: "in_progress" });
    store.createIssue({ title: "PG sibling p", workspaceId, parentIssueId: parent.id, status: "in_progress" });
    store.updateIssue(parent.id, { status: "in_review", force: true });
    store.updateIssue(grandparent.id, { status: "in_review", force: true });

    const events: Array<{ type: string; action: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      events.push({ type: event.type, action: entry?.action ?? "", inTransaction: db.inTransaction });
    });
    counter.reset();
    try {
      store.updateIssue(child.id, { status: "done" });
    } finally {
      unsubscribe();
    }
    expect(counter.max, "PG chain depth").toBe(1);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    expect(store.getIssue(grandparent.id)?.status).toBe("in_progress");
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "parent_status_derived"))
      .toHaveLength(1);
    expect(store.listIssueActivity(grandparent.id).filter((e) => e.type === "parent_status_derived"))
      .toHaveLength(1);
    expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
  });

  for (const parentStatus of ["done", "cancelled"] as const) {
    it(`delivers the ${parentStatus}-parent activity after COMMIT on Postgres`, () => {
      const { workspaceId } = freshWorkspace();
      const parent = store.createIssue({
        title: `PG closed parent ${parentStatus}`,
        workspaceId,
        status: "in_progress",
      });
      const child = store.createIssue({
        title: `PG late child ${parentStatus}`,
        workspaceId,
        parentIssueId: parent.id,
        status: "in_progress",
      });
      store.updateIssue(parent.id, { status: parentStatus, force: true });

      const events: Array<{ action: string; inTransaction: boolean }> = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
        if (event.type === "activity:created") {
          events.push({ action: entry?.action ?? "", inTransaction: db.inTransaction });
        }
      });
      try {
        store.updateIssue(child.id, { status: "done" });
      } finally {
        unsubscribe();
      }
      expect(store.listIssueActivity(parent.id).filter((e) => e.type === "child_status_after_parent_closed"))
        .toHaveLength(1);
      const closed = events.filter((event) => event.action === "child_status_after_parent_closed");
      expect(closed).toHaveLength(1);
      expect(closed[0]?.inTransaction).toBe(false);
      expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
    });
  }

  it("publishes no cancel activity when the organizer transaction rolls back (Postgres)", () => {
    const { workspaceId, agent } = freshWorkspace();
    const supervisorAgent = store.createAgent({
      name: "PG organizer",
      provider: "claude",
      runtimeId: undefined,
      workspaceId,
      role: "supervisor",
    });
    const workerAgent = store.createAgent({ name: "PG worker", provider: "claude", workspaceId });
    const patrol = store.createIssue({ title: "PG patrol", workspaceId });
    const targetIssue = store.createIssue({ title: "PG target", workspaceId, status: "in_progress" });
    const supervisorTask = store.createTask({ agentId: supervisorAgent.id, issueId: patrol.id, prompt: "patrol" });
    const targetTask = store.createTask({ agentId: workerAgent.id, issueId: targetIssue.id, prompt: "work" });
    store.updateWorkspace(workspaceId, { settings: { organizer: { mode: "act" } } });

    const events: Array<{ type: string; action: string }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (["comment:created", "activity:created", "issue:updated"].includes(event.type)) {
        events.push({ type: event.type, action: entry?.action ?? "" });
      }
    });
    const issues = (store as unknown as {
      issues: { notifyOrganizerAction: (...args: unknown[]) => void };
    }).issues;
    const originalNotify = issues.notifyOrganizerAction.bind(issues);
    issues.notifyOrganizerAction = (...args: unknown[]) => {
      originalNotify(...args);
      throw new Error("PG organizer rollback injection");
    };
    let threw = false;
    try {
      store.performOrganizerAction({
        supervisorTaskId: supervisorTask.id,
        supervisorAgentId: supervisorAgent.id,
        targetTaskId: targetTask.id,
        action: "cancel",
        reason: "PG rollback probe",
      });
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe("PG organizer rollback injection");
    } finally {
      issues.notifyOrganizerAction = originalNotify;
      unsubscribe();
    }
    expect(threw).toBe(true);
    expect(store.getTask(targetTask.id)?.status).toBe("queued");
    expect(events).toHaveLength(0);
  });

  it("publishes the self-transactional system-comment activity after its outer COMMIT (Postgres)", () => {
    const { workspaceId } = freshWorkspace();
    const issue = store.createIssue({ title: "PG wrapper issue", workspaceId, status: "in_progress" });
    const events: Array<{ action: string; inTransaction: boolean; lastControl: string | undefined }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") {
        events.push({
          action: entry?.action ?? "",
          inTransaction: db.inTransaction,
          lastControl: counter.controls.at(-1)?.sql,
        });
      }
    });
    // MUL-402 12:20 ruling (a): the main wrapper owns its COMMIT, not a savepoint.
    counter.reset();
    try {
      store.createTaskFailureSystemComment(issue.id, null, "tsk_pg_wrapper", "PG wrapper body");
    } finally {
      unsubscribe();
    }
    expect(counter.max).toBe(1);
    counter.assertTransactionControl("createTaskFailureSystemComment COMMIT");
    expect(counter.controls.filter((control) => control.sql === "BEGIN")).toHaveLength(1);
    expect(counter.controls.filter((control) => control.sql === "COMMIT")).toHaveLength(1);
    expect(events).toEqual([{ action: "comment_created", inTransaction: false, lastControl: "COMMIT" }]);

    const rollbackEvents: string[] = [];
    const unsubscribeRollback = store.onWorkspaceEvent((event) => { rollbackEvents.push(event.type); });
    const original = StoreContext.prototype.appendIssueActivity;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      ...args: Parameters<StoreContext["appendIssueActivity"]>
    ) {
      const result = original.apply(this, args);
      if (args[1].type === "comment_created") throw new Error("PG wrapper rollback injection");
      return result;
    };
    counter.reset();
    try {
      expect(() => store.createTaskFailureSystemComment(issue.id, null, "tsk_pg_wrapper_2", "PG rollback body"))
        .toThrow("PG wrapper rollback injection");
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribeRollback();
    }
    counter.assertTransactionControl("createTaskFailureSystemComment ROLLBACK");
    expect(counter.controls.filter((control) => control.sql === "BEGIN")).toHaveLength(1);
    expect(counter.controls.filter((control) => control.sql === "COMMIT")).toHaveLength(0);
    expect(counter.controls.filter((control) => control.sql === "ROLLBACK")).toHaveLength(1);
    expect(rollbackEvents).toHaveLength(0);
    expect(store.listIssueComments(issue.id).filter((comment) => comment.body === "PG rollback body")).toHaveLength(0);
  });

  it("records actual PG transaction control for the remaining SQLite-suite entry points", () => {
    let observed = 0;
    const check = (label: string, action: () => void) => {
      counter.reset();
      action();
      counter.assertTransactionControl(label);
      expect(counter.max, label).toBeLessThanOrEqual(1);
      observed += counter.controls.length;
    };

    for (const status of ["blocked", "cancelled"] as const) {
      for (const busy of [false, true]) {
        const { workspaceId, agent } = freshWorkspace();
        const parent = store.createIssue({
          title: `PG ${status} parent ${busy}`, workspaceId, status: "in_progress",
          assigneeType: "agent", assigneeId: agent,
        });
        if (busy) {
          const task = store.createTask({ agentId: agent, issueId: parent.id, prompt: "current round" });
          runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [task.id]);
        }
        const child = store.createIssue({ title: "PG terminal child", workspaceId, parentIssueId: parent.id, status: "in_progress" });
        check(`updateIssue ${status}, busy=${busy}`, () => { store.updateIssue(child.id, { status }); });
      }
    }

    const { workspaceId, agent, runtime } = freshWorkspace();
    const parent = store.createIssue({ title: "PG remaining parent", workspaceId, status: "in_review" });
    let child!: ReturnType<MultiremiStore["createIssue"]>;
    check("createIssue re-derivation", () => {
      child = store.createIssue({ title: "PG new child", workspaceId, parentIssueId: parent.id, status: "in_progress" });
    });
    const second = store.createIssue({ title: "PG second parent", workspaceId, status: "in_review" });
    check("updateIssue re-parent", () => { store.updateIssue(child.id, { parentIssueId: second.id }); });

    const task = store.createTask({ agentId: agent, issueId: child.id, prompt: "PG ask" });
    let claimed = store.claimTask(runtime);
    while (claimed && claimed.id !== task.id) claimed = store.claimTask(runtime);
    if (!claimed) throw new Error("PG human request task was not claimed");
    store.startTask(task.id);
    let request!: ReturnType<MultiremiStore["createTaskHumanRequest"]>;
    check("createTaskHumanRequest", () => {
      request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { question: "PG choice?" } });
    });
    check("respondTaskHumanRequest", () => { store.respondTaskHumanRequest(request.id, { response: { answer: "yes" } }); });
    request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: { question: "PG expiry?" } });
    check("expireTaskHumanRequest", () => { store.expireTaskHumanRequest(request.id, "timeout"); });
    store.cancelTask(task.id);

    const comment = store.createIssueComment(child.id, { authorType: "member", authorId: "local", body: "PG trigger" });
    store.createTask({ agentId: agent, issueId: child.id, runtimeId: runtime, triggerCommentId: comment.id, prompt: "PG triggered" });
    check("cancelTasksByTriggerComments", () => { store.cancelTasksByTriggerComments(workspaceId, [comment.id]); });
    const orphan = store.createTask({ agentId: agent, issueId: child.id, runtimeId: runtime, prompt: "PG orphan" });
    claimed = store.claimTask(runtime);
    while (claimed && claimed.id !== orphan.id) claimed = store.claimTask(runtime);
    if (!claimed) throw new Error("PG orphan task was not claimed");
    check("recoverOrphans", () => { store.recoverOrphans(runtime); });

    const supervisor = store.createAgent({ name: "PG controls organizer", provider: "claude", workspaceId, role: "supervisor" });
    const worker = store.createAgent({ name: "PG controls worker", provider: "claude", workspaceId });
    const patrol = store.createIssue({ title: "PG controls patrol", workspaceId });
    const supervisorTask = store.createTask({ agentId: supervisor.id, issueId: patrol.id, prompt: "PG patrol" });
    store.updateWorkspace(workspaceId, { settings: { organizer: { mode: "act" } } });
    for (const action of ["cancel", "redispatch"] as const) {
      const target = store.createTask({ agentId: worker.id, issueId: child.id, prompt: `PG ${action}` });
      check(`performOrganizerAction ${action}`, () => {
        store.performOrganizerAction({
          supervisorTaskId: supervisorTask.id, supervisorAgentId: supervisor.id,
          targetTaskId: target.id, action, reason: "PG controls probe",
        });
      });
    }

    const originalKey = process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    try {
      const repositoryId = `repo_pg_controls_${workspaceCounter}`;
      store.updateWorkspace(workspaceId, {
        repos: [{ id: repositoryId, name: "widgets", url: "git@github.com:acme/widgets.git", source: "github", default_branch: "main" }],
        settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
      });
      const connection = store.createScmConnection({
        workspaceId, name: "PG controls SCM", provider: "github", mode: "hybrid",
        accessToken: "ghp_depth_token", webhookSecret: "depth-webhook-secret", repositoryIds: [repositoryId],
      });
      for (const hasOpenChildren of [true, false]) {
        const mergedIssue = store.createIssue({ title: "PG SCM controls", workspaceId, status: "in_progress" });
        const scmChild = store.createIssue({ title: "PG SCM child", workspaceId, parentIssueId: mergedIssue.id, status: "in_progress" });
        if (!hasOpenChildren) store.updateIssue(scmChild.id, { status: "done" });
        const externalId = hasOpenChildren ? "42" : "43";
        store.advanceScmEntitySnapshot({
          connectionId: connection.id, repositoryId, entityType: "change_request", externalId,
          revisionAt: "2026-08-21T10:00:00.000Z", revision: `v-${externalId}`, contentHash: `change-${externalId}`,
          payload: { number: Number(externalId), title: `${mergedIssue.key}: deliver`, state: "merged", source_branch: "agent/depth", url: `https://github.com/acme/widgets/pull/${externalId}` },
        });
        check(`recordScmCanonicalEvent held=${hasOpenChildren}`, () => {
          store.recordScmCanonicalEvent({
            workspaceId, connectionId: connection.id, repositoryId, type: "change.merged",
            subjectType: "change_request", subjectId: externalId, logicalKey: `change.merged:${externalId}:controls`, fidelity: "inferred",
            payload: { id: `provider-change-${externalId}`, number: Number(externalId), branch: "main", mergeSha: "abc" },
            evidence: { source: "poll", dedupeKey: `poll:${externalId}`, providerEventId: null },
          });
        });
      }
    } finally {
      if (originalKey === undefined) delete process.env.MULTIREMI_SCM_ENCRYPTION_KEY;
      else process.env.MULTIREMI_SCM_ENCRYPTION_KEY = originalKey;
    }
    expect(observed, "actual PG transaction control statements were recorded").toBeGreaterThan(0);
  });

  it("coalesces two children ending concurrently into one queued round (Postgres)", async () => {
    const { workspaceId, agent } = freshWorkspace();
    const parent = store.createIssue({
      title: "PG coalesce parent",
      workspaceId,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent,
    });
    const running = store.createTask({ agentId: agent, issueId: parent.id, prompt: "current round" });
    runTurnExecutionMutation(db as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [running.id]);
    const first = store.createIssue({
      title: "PG coalesce child A",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
    });
    const second = store.createIssue({
      title: "PG coalesce child B",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
    });

    // The worker is a second Postgres connection in its own thread, so the two
    // reports really do contend for the workspace lock.
    const worker = new Worker(new URL("./fixtures/postgres-child-ending-worker.ts", import.meta.url).href);
    const ready = waitForWorkerPhase(worker, "ready");
    worker.postMessage({ type: "init", databaseUrl: pgDatabaseUrl(TEST_DB) });
    await ready;
    const finished = waitForWorkerPhase(worker, "completed", 60_000);
    worker.postMessage({ type: "end", childIssueId: second.id, status: "done" });

    // The test process ends the other child at the same time.
    store.updateIssue(first.id, { status: "blocked" });
    await finished;
    worker.terminate();

    const queued = store.listTasksForIssue(parent.id).filter((task) => task.status === "queued");
    expect(queued).toHaveLength(1);
    const comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(2);
    expect(comments.map(comment => comment.body).join("\n")).toContain("is blocked");
    expect(comments.map(comment => comment.body).join("\n")).toContain("is done");
    expect(comments.every(comment => store.getConversationLogEntryById(comment.id)!.metadata.envelope)).toBe(true);
  }, 90_000);
});
