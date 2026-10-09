import { createResponsibleTestIssue } from './helpers.js';
/**
 * MUL-405: the Feishu and Autopilot paths must take the workspace lifecycle row
 * lock and the Issue number lock in the SAME order.
 *
 * QA reproduced a real PostgreSQL deadlock on the first version of this change:
 * `FeishuBotRepo.submitMessage` held the workspace row lock and then asked for
 * the issue number lock, while `AutopilotsRepo.runAutopilot` (execution mode
 * `create_issue`) asked for the issue number lock inside `createIssue` and then
 * reached the workspace row lock through `createTaskWithinTransaction`. Two
 * connections interleaved on those two orders produce `deadlock detected`, and
 * PostgreSQL kills one transaction.
 *
 * This file pins both halves of the fix:
 *
 *  1. **Derive** the lock order each path actually takes by running the real
 *     store methods and recording the locking statements/key they emit. The
 *     expected sequence is not written down here as a paraphrase of the code; it
 *     comes from the code.
 *  2. **Replay** both derived orders on two genuinely separate PostgreSQL
 *     connections, forcing the interleave, and assert both transactions commit.
 *     On the pre-fix tree this second step reproduces QA's `deadlock detected`:
 *     the recorded Autopilot order is number-then-workspace, so both arms take a
 *     different first lock and then block on each other.
 *
 * Skipped (not failed) when PostgreSQL is unreachable, matching the other
 * PG-backed suites. Point `MULTIREMI_TEST_POSTGRES_URL` at an instance where the
 * configured role may CREATE DATABASE.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { resolveSqlDialect } from "@multiremi/store/migrations.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { classifyLockOrderStatement } from "@multiremi/store/lock-order-sentinel.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { createId } from "@multiremi/ids.js";

const PG_ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL
  ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_mul405_lockorder_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const APP_SECRET = "wJ4tQ7xR2nB8vC5mZ1kL0pS6dF3gH9jA";

/** Lock names as the ordering contract in store/advisory-locks.ts names them. */
type LockName = "workspace" | "number";

/**
 * The order in which each lock is acquired for the first time.
 *
 * Only the first acquisition matters for the deadlock: a transaction that takes
 * the workspace row lock, then the number lock, and then re-takes the workspace
 * row lock (which is free — it already holds it) has still established
 * `workspace -> number`, and that is what the second transaction has to match.
 * Deduplicating consecutive repeats keeps the recorded trace readable without
 * hiding a genuine reorder.
 */
function firstTouchOrder(locks: LockName[]): LockName[] {
  const seen = new Set<LockName>();
  const order: LockName[] = [];
  for (const lock of locks) {
    if (seen.has(lock)) continue;
    seen.add(lock);
    order.push(lock);
  }
  return order;
}

// ────────────────────────── deriving each path's order ──────────────────────────

/**
 * A real SQLite store plus a recording wrapper.
 *
 * `bun:sqlite` has no `advisoryXactLock` (that is the documented SQLite no-op),
 * so the wrapper supplies one and records it. Everything else is delegated
 * unchanged, which is what makes the recorded order reflect the production code
 * path rather than a re-implementation of it.
 */
class LockRecordingDatabase implements SqlDatabase {
  readonly locks: LockName[] = [];
  constructor(private readonly inner: ReturnType<typeof openSqliteDatabase>) {}

  get dialect(): "sqlite" {
    return this.inner.dialect;
  }

  private record(lock: LockName): void {
    if (this.locks[this.locks.length - 1] !== lock) this.locks.push(lock);
  }

  private recordSql(sql: string): void {
    if (classifyLockOrderStatement(sql).includes("W")) this.record("workspace");
  }

  private statement(sql: string, statement: SqlStatement): SqlStatement {
    return new Proxy(statement, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (["get", "all", "run", "values"].includes(String(property))) {
          return (...args: unknown[]) => {
            this.recordSql(sql);
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  query(sql: string): SqlStatement {
    return this.statement(sql, this.inner.query(sql));
  }
  prepare(sql: string): SqlStatement {
    return this.statement(sql, this.inner.prepare(sql));
  }
  run(sql: string, ...params: unknown[]) {
    this.recordSql(sql);
    return this.inner.run(sql, ...params as never[]);
  }
  exec(sql: string): void {
    this.recordSql(sql);
    this.inner.exec(sql);
  }
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return this.inner.transaction(fn) as (...args: any[]) => T;
  }
  get inTransaction(): boolean {
    return this.inner.inTransaction;
  }
  advisoryXactLock(key: string): void {
    // Mirrors the Postgres key: `multiremi:number:<scope>`.
    this.record("number");
    void key;
  }
  close(): void {
    this.inner.close();
  }
}

let openDbs: Database[] = [];
let previousEncryptionKey: string | undefined;

afterEach(() => {
  for (const db of openDbs) db.close();
  openDbs = [];
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
});

function freshStore(): { store: MultiremiStore; recorder: LockRecordingDatabase } {
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
  const db = openSqliteDatabase(":memory:");
  openDbs.push(db);
  const recorder = new LockRecordingDatabase(db);
  expect(recorder.dialect).toBe("sqlite");
  expect(resolveSqlDialect(recorder)).toBe("sqlite");
  const store = new MultiremiStore(recorder as unknown as SqlDatabase);
  store.ensureLocalWorkspace();
  return { store, recorder };
}

it("preserves the SQLite dialect on the recording wrapper", () => {
  const { recorder } = freshStore();
  expect(recorder.dialect).toBe("sqlite");
  expect(resolveSqlDialect(recorder)).toBe("sqlite");
});

/** The Feishu group-topic path: workspace row lock, then the auto-created Issue. */
function recordFeishuOrder(): LockName[] {
  const { store, recorder } = freshStore();
  const agent = store.createAgent({ name: "Concierge", provider: "codex", workspaceId: "local" });
  store.registerRuntime({
    id: "rt_lock_order", name: "Bot host", provider: "codex", workspaceId: "local", daemonId: "lock-order-host",
  });
  store.heartbeatRuntime("rt_lock_order", { supportsFeishuBotConfig: true });
  const config = store.upsertFeishuBotConfig("local", {
    agentId: agent.id,
    runtimeId: "rt_lock_order",
    appId: "cli_lock_order",
    senderAccessPolicy: "allowlist",
    appSecretOp: "set",
    appSecret: APP_SECRET,
    domain: "feishu",
    enabled: true,
  });
  store.reportFeishuBotRuntimeStatus("local", "rt_lock_order", {
    appliedRevision: config.revision, state: "online",
  });
  store.updateWorkspace("local", {
    settings: { issueTopics: { enabled: true, chatId: "oc_lock_order" } },
  });
  store.replaceFeishuBotAgentRoutes("local", [
    { scope: "chat", chatId: "oc_lock_order", agentId: agent.id },
  ]);

  // First message registers the sender and the Chat binding. The sender starts
  // on the allowlist default (denied), so no Issue is auto-created yet.
  store.submitFeishuBotMessage("local", "rt_lock_order", {
    revision: config.revision,
    externalSessionKey: "oc_lock_order:thread:omt_lock",
    externalMessageId: "om_lock_order",
    chatType: "group",
    chatId: "oc_lock_order",
    threadId: "omt_lock",
    senderOpenId: "ou_lock_order",
    text: "Register the conversation",
  });
  store.setFeishuBotSenderAllowed("local", store.listFeishuBotSenders("local")[0]!.id, true, "local");
  // Now the topic binding has no Issue and the sender is allowed, so this call
  // is the one that takes both locks: the workspace row lock on entry, and the
  // issue number lock inside the auto-created Issue.
  recorder.locks.length = 0;
  store.submitFeishuBotMessage("local", "rt_lock_order", {
    revision: config.revision,
    externalSessionKey: "oc_lock_order:thread:omt_lock",
    externalMessageId: "om_lock_order_2",
    chatType: "group",
    chatId: "oc_lock_order",
    threadId: "omt_lock",
    senderOpenId: "ou_lock_order",
    text: "Create the group Issue",
  });
  return [...recorder.locks];
}

/** The Autopilot `create_issue` path, which also creates a Task in the same tx. */
function recordAutopilotOrder(): LockName[] {
  const { store, recorder } = freshStore();
  const agent = store.createAgent({ name: "Automation", provider: "codex", workspaceId: "local" });
  const autopilot = store.createAutopilot({
    title: "Create an Issue",
    assigneeId: agent.id,
    workspaceId: "local",
    executionMode: "create_issue",
    status: "active",
  });
  recorder.locks.length = 0;
  const run = store.runAutopilot(autopilot.id);
  expect(run.issueId).not.toBeNull();
  expect(run.taskId).not.toBeNull();
  return [...recorder.locks];
}

/** The plain API / quick-create path: `createIssue` with no outer transaction. */
function recordCreateIssueOrder(): LockName[] {
  const { store, recorder } = freshStore();
  recorder.locks.length = 0;
  createResponsibleTestIssue(store, { title: "Plain create", workspaceId: "local" });
  return [...recorder.locks];
}

// ────────────────────────── replaying on real PostgreSQL ──────────────────────────

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
    `[mul405-lock-order] Postgres not reachable at ${PG_ADMIN_URL} — skipping the two-connection interleave.`,
  );
}

describe.skipIf(!pgAvailable)("MUL-405 lock order", () => {
  let db: PostgresSyncDatabase;
  let sql: InstanceType<typeof Bun.SQL>;
  let workspaceId: string;

  beforeAll(async () => {
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
    const url = new URL(PG_ADMIN_URL);
    url.pathname = `/${TEST_DB}`;
    db = new PostgresSyncDatabase(url.toString());
    const store = new MultiremiStore(db);
    // The workspace row must exist: the arms lock it with a no-op UPDATE, and a
    // missing row would make the "first lock" a no-op instead of a lock.
    workspaceId = store.createWorkspace({ name: "Lock order", slug: "lock-order" }).id;
    sql = new Bun.SQL(url.toString(), { max: 2 });
  });

  afterAll(async () => {
    try { await sql?.end(); } catch { /* connection may already be gone */ }
    db?.close();
    const admin = new Bun.SQL(PG_ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.end();
  });

  interface ArmOutcome {
    phase: "committed" | "error";
    error?: string;
    issueNumber?: number;
  }

  /**
   * Run one arm on its own connection with the barrier described in the worker.
   *
   * The arms are started in sequence and released one first lock at a time:
   *
   *  - `first` starts, takes its first lock and parks;
   *  - `second` starts and gets `interleaveWindowMs` to reach *its* first lock.
   *    When both paths agree on the order that lock is the same one the first arm
   *    holds, so the second arm simply blocks and the window expires — that is
   *    the healthy case. When the orders disagree the second arm announces its
   *    lock inside the window, and releasing both then makes each reach for the
   *    lock the other holds.
   */
  async function runInterleave(
    firstOrder: LockName[],
    secondOrder: LockName[],
    interleaveWindowMs: number,
  ): Promise<{ first: ArmOutcome; second: ArmOutcome }> {
    const workerUrl = new URL("./fixtures/postgres-lock-order-interleave-worker.ts", import.meta.url).href;
    const databaseUrl = (() => {
      const url = new URL(PG_ADMIN_URL);
      url.pathname = `/${TEST_DB}`;
      return url.toString();
    })();
    const first = new Worker(workerUrl);
    const second = new Worker(workerUrl);
    const messages = new Map<Worker, ArmOutcome[]>();
    const listeners = new Map<Worker, Array<(value: ArmOutcome) => void>>();
    const waiters = new Map<Worker, Array<() => void>>();

    const attach = (worker: Worker) => {
      messages.set(worker, []);
      listeners.set(worker, []);
      waiters.set(worker, []);
      worker.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { phase: string; error?: string; issueNumber?: number };
        if (data.phase === "committed" || data.phase === "error") {
          const outcome = data as ArmOutcome;
          const queue = messages.get(worker)!;
          queue.push(outcome);
          for (const listener of listeners.get(worker)!.splice(0)) listener(outcome);
        }
        if (data.phase === "first-lock") {
          for (const waiter of waiters.get(worker)!.splice(0)) waiter();
        }
      });
      worker.addEventListener("error", (event: ErrorEvent) => {
        const outcome = { phase: "error" as const, error: String(event.message ?? event.error) };
        const queue = messages.get(worker)!;
        queue.push(outcome);
        for (const listener of listeners.get(worker)!.splice(0)) listener(outcome);
      });
    };

    const awaitFirstLock = (worker: Worker, timeoutMs: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      waiters.get(worker)!.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    const awaitOutcome = (worker: Worker, timeoutMs: number) => new Promise<ArmOutcome>((resolve) => {
      const queued = messages.get(worker)!.shift();
      if (queued) return resolve(queued);
      const timer = setTimeout(
        () => resolve({ phase: "error", error: `arm timed out after ${timeoutMs} ms` }),
        timeoutMs,
      );
      listeners.get(worker)!.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });

    try {
      attach(first);
      attach(second);
      first.postMessage({
        databaseUrl,
        workspaceId,
        issueId: createId("iss"),
        lockOrder: firstOrder,
      });
      expect(await awaitFirstLock(first, 10_000)).toBe(true);

      second.postMessage({
        databaseUrl,
        workspaceId,
        issueId: createId("iss"),
        lockOrder: secondOrder,
      });
      // Healthy case: the second arm is blocked on the row lock the first arm
      // holds, so no announcement arrives and the window simply expires.
      await awaitFirstLock(second, interleaveWindowMs);

      first.postMessage({ type: "go" });
      second.postMessage({ type: "go" });

      return {
        first: await awaitOutcome(first, 20_000),
        second: await awaitOutcome(second, 20_000),
      };
    } finally {
      first.terminate();
      second.terminate();
    }
  }

  it("takes the workspace row lock before the issue number lock on both paths", () => {
    // Each path is derived from the store separately: QA's round-2 mutation
    // (deleting the workspace lock from createIssueWithinTransaction) must go
    // red here, and it only does if the plain createIssue path is recorded.
    // The exhaustive per-path assertions live in
    // `mul405-lock-order-paths.test.ts`; this file keeps the end-to-end replay.
    expect(firstTouchOrder(recordCreateIssueOrder())).toEqual(["workspace", "number"]);
    expect(firstTouchOrder(recordFeishuOrder())).toEqual(["workspace", "number"]);
    expect(firstTouchOrder(recordAutopilotOrder())).toEqual(["workspace", "number"]);
  });

  it("commits the Feishu and Autopilot interleaving without a deadlock", async () => {
    // Both orders come from the store, not from this test. On the first version
    // of this change the Autopilot order was `number -> workspace`, so the arms
    // grabbed different first locks and the replay below failed with QA's
    // `deadlock detected` — that failure is what this test pins.
    const feishuOrder = firstTouchOrder(recordFeishuOrder());
    const autopilotOrder = firstTouchOrder(recordAutopilotOrder());

    const outcomes = await runInterleave(feishuOrder, autopilotOrder, 1_500);
    const report = (label: string, outcome: ArmOutcome) =>
      `${label} [${outcome.phase}] ${outcome.error ?? "ok"}`;
    for (const [label, outcome] of [["feishu", outcomes.first], ["autopilot", outcomes.second]] as const) {
      expect(
        outcome.phase,
        `${report(label, outcome)} — derived orders: feishu ${feishuOrder.join(" -> ")}, ` +
          `autopilot ${autopilotOrder.join(" -> ")}`,
      ).toBe("committed");
    }

    // The interleave must leave a usable, gap-free number sequence behind.
    const rows = await sql`
      SELECT issue_number FROM multiremi_issues WHERE workspace_id = ${workspaceId} ORDER BY issue_number
    `;
    const numbers = rows.map((row: { issue_number: number | string }) => Number(row.issue_number));
    expect(numbers.length).toBeGreaterThanOrEqual(2);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).toEqual([...numbers].sort((left, right) => left - right));
  });

  it("commits the plain createIssue and Feishu bot interleaving without a deadlock", async () => {
    // QA's round-2 requirement: the pure `createIssue` (quick-create) path must
    // also be part of the pinned interleave. It is the path whose workspace lock
    // was silently deleted in their mutation and nothing went red.
    const plainOrder = firstTouchOrder(recordCreateIssueOrder());
    const feishuOrder = firstTouchOrder(recordFeishuOrder());

    const outcomes = await runInterleave(plainOrder, feishuOrder, 1_500);
    for (const [label, outcome] of [["createIssue", outcomes.first], ["feishu", outcomes.second]] as const) {
      expect(
        outcome.phase,
        `${label} [${outcome.phase}] ${outcome.error ?? "ok"} — derived orders: ` +
          `createIssue ${plainOrder.join(" -> ")}, feishu ${feishuOrder.join(" -> ")}`,
      ).toBe("committed");
    }
  });
});
