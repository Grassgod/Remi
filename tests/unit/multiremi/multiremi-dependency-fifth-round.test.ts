import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";

type Store = MultiremiStore;

function databaseUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function inTransaction(store: Store): boolean {
  return (store as unknown as { ctx: { db: { inTransaction: boolean } } }).ctx.db.inTransaction;
}

function createRunnableOwner(store: Store, label: string) {
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ name: `${label} runtime`, provider: "claude", maxConcurrency: 4 });
  return store.createAgent({ name: `${label} owner`, provider: "claude", runtimeId: runtime.id });
}

function registerTaskWakeupContract(label: string, currentStore: () => Store): void {
  it(`${label}: wakes a force-started task once, after COMMIT`, () => {
    const store = currentStore();
    const owner = createRunnableOwner(store, `${label} force`);
    const prerequisite = store.createIssue({ title: `${label} force prerequisite`, status: "in_progress" });
    const dependent = store.createIssue({
      title: `${label} force dependent`,
      status: "backlog",
      blockedBy: [prerequisite.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    const wakeups: Array<{ id: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onTaskEnqueued((task) => {
      wakeups.push({ id: task.id, inTransaction: inTransaction(store) });
    });

    try {
      store.updateIssue(dependent.id, {
        status: "todo", force: true, actorType: "member", actorId: "mem_local",
      });
    } finally {
      unsubscribe();
    }

    const tasks = store.listTasksForIssue(dependent.id);
    expect(tasks).toHaveLength(1);
    expect(wakeups).toEqual([{ id: tasks[0]!.id, inTransaction: false }]);
  });

  it(`${label}: wakes an automatically started task once, after COMMIT`, () => {
    const store = currentStore();
    const owner = createRunnableOwner(store, `${label} auto`);
    const prerequisite = store.createIssue({ title: `${label} auto prerequisite`, status: "in_progress" });
    const dependent = store.createIssue({
      title: `${label} auto dependent`,
      status: "backlog",
      blockedBy: [prerequisite.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    const wakeups: Array<{ id: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onTaskEnqueued((task) => {
      wakeups.push({ id: task.id, inTransaction: inTransaction(store) });
    });

    try {
      store.updateIssue(prerequisite.id, { status: "done" });
    } finally {
      unsubscribe();
    }

    const tasks = store.listTasksForIssue(dependent.id);
    expect(tasks).toHaveLength(1);
    expect(wakeups).toEqual([{ id: tasks[0]!.id, inTransaction: false }]);
  });

  it.each(["force", "auto"] as const)(`${label}: drops the %s wakeup when task creation rolls back`, (kind) => {
    const store = currentStore();
    const owner = createRunnableOwner(store, `${label} rollback ${kind}`);
    const prerequisite = store.createIssue({ title: `${label} rollback prerequisite ${kind}`, status: "in_progress" });
    const dependent = store.createIssue({
      title: `${label} rollback dependent ${kind}`,
      status: "backlog",
      blockedBy: [prerequisite.id],
      assigneeType: "agent",
      assigneeId: owner.id,
    });
    const wakeups: string[] = [];
    const unsubscribe = store.onTaskEnqueued((task) => wakeups.push(task.id));
    const original = StoreContext.prototype.appendIssueActivity;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      issueId: string,
      input: Parameters<StoreContext["appendIssueActivity"]>[1],
      ...rest: unknown[]
    ) {
      if (issueId === dependent.id && input.type === "issue_assigned") {
        throw new Error(`injected ${kind} rollback after task insert`);
      }
      return (original as (...args: unknown[]) => ReturnType<StoreContext["appendIssueActivity"]>)
        .call(this, issueId, input, ...rest);
    } as StoreContext["appendIssueActivity"];

    try {
      if (kind === "force") {
        expect(() => store.updateIssue(dependent.id, {
          status: "todo", force: true, actorType: "member", actorId: "mem_local",
        })).toThrow(`injected ${kind} rollback after task insert`);
      } else {
        store.updateIssue(prerequisite.id, { status: "done" });
      }
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribe();
    }

    expect(wakeups).toEqual([]);
    expect(store.listTasksForIssue(dependent.id)).toEqual([]);
    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
  });

  it(`${label}: keeps ordinary and session task wakeups at one each`, () => {
    const store = currentStore();
    const owner = createRunnableOwner(store, `${label} controls`);
    const ordinaryWakeups: string[] = [];
    const stopOrdinary = store.onTaskEnqueued((task) => ordinaryWakeups.push(task.id));
    const ordinary = store.createTask({ agentId: owner.id, prompt: `${label} ordinary` });
    stopOrdinary();
    expect(ordinaryWakeups).toEqual([ordinary.id]);

    const issue = store.createIssue({ title: `${label} session issue`, status: "todo" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const sessionWakeups: string[] = [];
    const stopSession = store.onTaskEnqueued((task) => sessionWakeups.push(task.id));
    const sessionTask = store.createSessionTask(session.id, {
      agentId: owner.id,
      prompt: `${label} session task`,
    });
    stopSession();
    expect(sessionWakeups).toEqual([sessionTask.id]);
  });
}

describe("MUL-409 QA round 5 task wakeups on SQLite", () => {
  let database: Database;
  let store: Store;

  beforeEach(() => {
    database = new Database(":memory:");
    store = new MultiremiStore(database);
  });

  afterEach(() => database.close());

  registerTaskWakeupContract("SQLite", () => store);
});

const postgresAdminUrl = process.env.MULTIREMI_TEST_POSTGRES_URL;
const postgresDatabaseName = `multiremi_mul409_f5_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!postgresAdminUrl)("MUL-409 QA round 5 task wakeups on PostgreSQL", () => {
  let admin: Bun.SQL;
  let database: PostgresSyncDatabase;
  let store: Store;

  beforeAll(async () => {
    admin = new Bun.SQL(postgresAdminUrl!, { max: 1 });
    await admin.unsafe(`CREATE DATABASE ${postgresDatabaseName}`);
    database = new PostgresSyncDatabase(databaseUrl(postgresAdminUrl!, postgresDatabaseName));
    store = new MultiremiStore(database);
  });

  afterAll(async () => {
    database?.close();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${postgresDatabaseName} WITH (FORCE)`);
    await admin?.end();
  });

  registerTaskWakeupContract("PostgreSQL", () => store);
});
