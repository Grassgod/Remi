import { createResponsibleTestIssue } from './helpers.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
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

function storeDatabase(store: Store) {
  return (store as unknown as {
    ctx: {
      db: {
        transaction<T>(body: () => T): () => T;
        query(sql: string): { get(...params: unknown[]): Record<string, unknown> | null };
      };
    };
  }).ctx.db;
}

function tableCount(store: Store, table: "multiremi_issues" | "multiremi_issue_activity"): number {
  const row = storeDatabase(store).query(`SELECT COUNT(*) AS total FROM ${table}`).get();
  return Number(row?.total ?? 0);
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
    const prerequisite = createResponsibleTestIssue(store, { title: `${label} force prerequisite`, status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
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
    const prerequisite = createResponsibleTestIssue(store, { title: `${label} auto prerequisite`, status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
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
    const prerequisite = createResponsibleTestIssue(store, { title: `${label} rollback prerequisite ${kind}`, status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
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

    const issue = createResponsibleTestIssue(store, { title: `${label} session issue`, status: "todo" });
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

function registerIssueCreationOwnerContract(label: string, currentStore: () => Store): void {
  const completeQueue = () => ({ workspace: [], enqueuedTasks: [], issueActivities: [] });
  const incompleteOwners = [
    {
      missing: "childStatusChanges",
      owner: () => ({ deferredEvents: completeQueue() }),
      error: "requires childStatusChanges",
    },
    {
      missing: "deferredEvents",
      owner: () => ({ childStatusChanges: [] }),
      error: "requires deferredEvents",
    },
    {
      missing: "deferredEvents.workspace",
      owner: () => ({
        childStatusChanges: [],
        deferredEvents: { enqueuedTasks: [], issueActivities: [] },
      }),
      error: "requires workspace",
    },
    {
      missing: "deferredEvents.enqueuedTasks",
      owner: () => ({
        childStatusChanges: [],
        deferredEvents: { workspace: [], issueActivities: [] },
      }),
      error: "requires enqueuedTasks",
    },
    {
      missing: "deferredEvents.issueActivities",
      owner: () => ({
        childStatusChanges: [],
        deferredEvents: { workspace: [], enqueuedTasks: [] },
      }),
      error: "requires issueActivities",
    },
  ];

  for (const entry of ["createIssue", "createIssueWithinTransaction"] as const) {
    for (const variant of incompleteOwners) {
      it(`${label}: ${entry} rejects an owner missing ${variant.missing} before writing`, () => {
        const store = currentStore();
        store.ensureLocalWorkspace();
        const owner = variant.owner() as {
          childStatusChanges?: unknown;
          deferredEvents?: unknown;
        };
        const before = {
          issues: tableCount(store, "multiremi_issues"),
          activities: tableCount(store, "multiremi_issue_activity"),
        };
        const events: string[] = [];
        const unsubscribe = store.onWorkspaceEvent((event) => events.push(event.type));

        try {
          expect(() => storeDatabase(store).transaction(() => {
            const input = { title: `${label} incomplete ${entry} ${variant.missing}` };
            if (entry === "createIssue") {
              (store.createIssue as unknown as (value: unknown, transaction: unknown) => unknown)(input, owner);
            } else {
              (store.createIssueWithinTransaction as unknown as (
                value: unknown,
                collector: unknown,
                queue: unknown,
              ) => unknown)(input, owner.childStatusChanges, owner.deferredEvents);
            }
          })()).toThrow(variant.error);
        } finally {
          unsubscribe();
        }

        expect({
          issues: tableCount(store, "multiremi_issues"),
          activities: tableCount(store, "multiremi_issue_activity"),
          events,
        }).toEqual({ ...before, events: [] });
      });
    }
  }
}

function registerForcedSkipHttpContract(label: string, currentStore: () => Store): void {
  const cases = [
    { kind: "archived agent", reason: "no_runnable_agent" },
    { kind: "squad without a runnable agent", reason: "no_runnable_agent" },
    { kind: "member", reason: "member_assignee" },
    { kind: "no assignee", reason: "no_assignee" },
  ] as const;

  for (const testCase of cases) {
    it(`${label}: force keeps todo and records one skip for ${testCase.kind}`, async () => {
      const store = currentStore();
      store.ensureLocalWorkspace();
      const prerequisite = createResponsibleTestIssue(store, {
        title: `${label} ${testCase.kind} prerequisite`,
        status: "in_progress",
      });
      let assigneeType: "agent" | "squad" | "member" | undefined;
      let assigneeId: string | undefined;
      let agentToArchive: string | null = null;

      if (testCase.kind === "archived agent") {
        const agent = createRunnableOwner(store, `${label} archived force`);
        assigneeType = "agent";
        assigneeId = agent.id;
        agentToArchive = agent.id;
      } else if (testCase.kind === "squad without a runnable agent") {
        const leader = createRunnableOwner(store, `${label} squad force`);
        const squad = store.createSquad({
          name: `${label} force squad`,
          workspaceId: "local",
          leaderId: leader.id,
        });
        assigneeType = "squad";
        assigneeId = squad.id;
        agentToArchive = leader.id;
      } else if (testCase.kind === "member") {
        const member = store.listWorkspaceMembers("local")[0]!;
        assigneeType = "member";
        assigneeId = member.id;
      }

      const dependent = createResponsibleTestIssue(store, {
        title: `${label} ${testCase.kind} dependent`,
        status: "backlog",
        blockedBy: [prerequisite.id],
        assigneeType,
        assigneeId,
      });
      if (agentToArchive) store.archiveAgent(agentToArchive);
      const app = createMultiremiApp({ store });

      const response = await app.request(`/api/issues/${dependent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "todo", force: true }),
      });
      const body = await response.json() as { status?: string };
      const skips = store.listIssueActivity(dependent.id)
        .filter((activity) => activity.type === "dispatch_skipped");

      expect(response.status).toBe(200);
      expect(body.status).toBe("todo");
      expect(store.getIssue(dependent.id)?.status).toBe("todo");
      expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
      expect(skips).toHaveLength(1);
      expect(skips[0]!.data).toMatchObject({ reason: testCase.reason });
    });
  }

  it(`${label}: rolls the status back when the in-transaction skip write fails`, () => {
    const store = currentStore();
    store.ensureLocalWorkspace();
    const member = store.listWorkspaceMembers("local")[0]!;
    const prerequisite = createResponsibleTestIssue(store, { title: `${label} skip rollback prerequisite`, status: "in_progress" });
    const dependent = createResponsibleTestIssue(store, {
      title: `${label} skip rollback dependent`,
      status: "backlog",
      blockedBy: [prerequisite.id],
      assigneeType: "member",
      assigneeId: member.id,
    });
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => events.push(event.type));
    const original = StoreContext.prototype.appendIssueActivity;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      issueId: string,
      input: Parameters<StoreContext["appendIssueActivity"]>[1],
      ...rest: unknown[]
    ) {
      const activity = (original as (...args: unknown[]) => ReturnType<StoreContext["appendIssueActivity"]>)
        .call(this, issueId, input, ...rest);
      if (issueId === dependent.id && input.type === "dispatch_skipped") {
        throw new Error("injected failure after dispatch_skipped");
      }
      return activity;
    } as StoreContext["appendIssueActivity"];

    try {
      expect(() => store.updateIssue(dependent.id, {
        status: "todo", force: true, actorType: "member", actorId: member.id,
      })).toThrow("injected failure after dispatch_skipped");
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribe();
    }

    expect(store.getIssue(dependent.id)?.status).toBe("backlog");
    expect(store.listIssueActivity(dependent.id).filter((activity) =>
      activity.type === "dispatch_skipped" || activity.type === "dependency_force_started"
    )).toEqual([]);
    expect(events).toEqual([]);
  });
}

describe("MUL-409 QA round 5 task wakeups on SQLite", () => {
  let database: Database;
  let store: Store;

  beforeEach(() => {
    database = openSqliteDatabase(":memory:");
    store = new MultiremiStore(database);
  });

  afterEach(() => database.close());

  registerTaskWakeupContract("SQLite", () => store);
  registerIssueCreationOwnerContract("SQLite", () => store);
  registerForcedSkipHttpContract("SQLite", () => store);
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
  registerIssueCreationOwnerContract("PostgreSQL", () => store);
  registerForcedSkipHttpContract("PostgreSQL", () => store);
});
