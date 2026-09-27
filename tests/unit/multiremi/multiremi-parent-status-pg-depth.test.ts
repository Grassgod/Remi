/**
 * MUL-400 S1 on real PostgreSQL: the same transaction-depth ceiling the SQLite
 * suite asserts, plus the two cases that only a second connection can produce —
 * the E2 hook's own atomicity and the "two children end while the owner is
 * busy" coalescing contract.
 *
 * The depth counter wraps the `PostgresSyncDatabase` the store was built with,
 * so it measures the real BEGIN/COMMIT nesting. Anything above 1 means an inner
 * COMMIT ended the outer transaction early (there are no savepoints).
 *
 * Skipped (not failed) when Postgres is unreachable, matching the other PG
 * suites. Point `MULTIREMI_TEST_POSTGRES_URL` at an instance where the
 * configured role may CREATE DATABASE.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { StoreContext } from "@multiremi/store/context.js";
import { MultiremiStore, daemonRuntimeId } from "@multiremi/store.js";

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

interface DepthCounter { max: number; reset(): void }

/** Wrap `transaction()` on the real handle; the store's proxy forwards to it. */
function transactionDepthCounter(database: PostgresSyncDatabase): DepthCounter {
  const original = database.transaction.bind(database);
  const counter: DepthCounter = { max: 0, reset() { counter.max = 0; } };
  let depth = 0;
  (database as unknown as { transaction: unknown }).transaction =
    (fn: (...args: never[]) => unknown) => {
      const run = original(fn as never) as (...args: unknown[]) => unknown;
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
      `UPDATE multiremi_session_agent_lanes SET provider_session_id = 'expired',
       provider = 'claude', runtime_id = ?, cursor_seq = 1,
       execution_fingerprint = 'expired' WHERE session_id = ? AND agent_id = ?`,
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
        const selected = reader.query("SELECT status FROM multiremi_tasks WHERE id = ?").get(task.id) as { status: string };
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
            ? reader.query("SELECT status FROM multiremi_tasks WHERE id = ?").get(taskId) as { status: string }
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
    db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [running.id]);
    const child = store.createIssue({
      title: "PG busy child",
      workspaceId,
      parentIssueId: parent.id,
      status: "in_progress",
    });

    counter.reset();
    store.updateIssue(child.id, { status: "done" });
    expect(counter.max).toBe(1);
    const queued = store.listTasksForIssue(parent.id).filter((task) => task.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.prompt).toContain("reported is done");
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
    expect(store.listTasksForIssue(parent.id).filter((task) => task.status === "queued")).toHaveLength(1);
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

    // Break the hook the way a DB or comment failure would. The task-terminal
    // path reaches it through the store facade (`ctx.issues()`), which is the
    // seam this override sits on.
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
      // ADR 0003: the task terminal state and the child's own transition were
      // committed before the hook ran, so the notification failure cannot undo
      // them — and it left no round behind either.
      expect(otherStore.getTask(task.id)?.status).toBe("failed");
      expect(otherStore.getIssue(child.id)?.status).toBe("blocked");
      expect(otherStore.listTasksForIssue(parent.id)).toHaveLength(0);
      expect(otherStore.listIssueComments(parent.id).filter((comment) => comment.authorType === "system"))
        .toHaveLength(0);
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
    db.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [running.id]);
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
    // Both reports are in the one round: the first one is the round's subject,
    // the second is appended as an additional report.
    expect(queued[0]?.prompt).toMatch(/reported is (blocked|done)/);
    expect(queued[0]?.prompt).toContain("## Additional Sub-Issue Report");
    const comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
    expect(comments).toHaveLength(2);
  }, 90_000);
});
