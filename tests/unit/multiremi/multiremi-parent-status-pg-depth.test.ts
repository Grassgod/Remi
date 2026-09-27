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
