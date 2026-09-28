// MUL-474 (MUL-383 S8e): the daemon's task-level polls must stay cheap.
//
// A running task hits `GET :id/status` and `GET :id/steer` every 2.5 s, and
// posts its transcript to `POST :id/messages`. On 209 those two polls were the
// top two daemon routes by SQL: the identity guard read the whole
// `multiremi_tasks` row (`prompt` included), the guard's Runtime read pulled
// three derived queries, the Feishu exception ran before the owner comparison,
// and the handler read the whole row again.
//
// Three properties are pinned here, on the same statement-recording method as
// `multiremi-heartbeat-poll-merge.test.ts`:
//
//   1. each route's statement count is bounded, so a future change cannot put
//      the payload reads back;
//   2. no statement on these routes is `SELECT * FROM multiremi_tasks`, and no
//      statement names the `prompt` column;
//   3. a read -> write -> re-read inside one request still observes the write,
//      so the request-scoped cache cannot serve a stale Task row.
//
// The route the task-message fan-out uses is covered by (1) and (2); (3) uses
// `POST :id/complete`, which reads through the cache, writes, and then re-reads
// to build its response body.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  DAEMON_TASK_POLL_APP_ID,
  seedDaemonTaskPollFixture,
  seedDaemonTaskPollResultCases,
  type DaemonTaskPollFixture,
} from "../../fixtures/multiremi/daemon-task-poll-fixture.js";
import { notifyBrowserTaskMessages } from "@multiremi/api/realtime.js";
import {
  driveTaskMessageFanout,
  fanoutFixtureStore,
  installDeterministicFanoutClock,
} from "../../fixtures/multiremi/task-message-fanout-fixture.js";
import fanoutGolden from "../../fixtures/multiremi/task-message-fanout-golden.json";
import golden from "../../fixtures/multiremi/daemon-task-poll-golden.json";

const AUTH_TOKEN = "mul474-count-token";

let databases: Database[] = [];
let previousEncryptionKey: string | undefined;

beforeEach(() => {
  // The Feishu config row holds an encrypted app secret, so the fixture needs a key.
  previousEncryptionKey = process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString("base64");
});

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
  if (previousEncryptionKey === undefined) delete process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY;
  else process.env.MULTIREMI_FEISHU_BOT_ENCRYPTION_KEY = previousEncryptionKey;
});

interface Probe {
  statements: string[];
  reset(): void;
}

function countingDatabase(raw: Database, probe: Probe): SqlDatabase {
  const record = (sql: string): void => { probe.statements.push(sql.replace(/\s+/g, " ").trim()); };
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => new Proxy(statement, {
    get(target, property) {
      const value = target[property as keyof SqlStatement];
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          record(sql);
          return (value as (...args: unknown[]) => unknown).apply(target, params);
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    dialect: "sqlite" as const,
    query: (sql) => wrap(raw.query(sql) as unknown as SqlStatement, sql),
    prepare: (sql) => wrap(raw.prepare(sql) as unknown as SqlStatement, sql),
    run(sql, ...params) {
      record(sql);
      const bindings = (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as SQLQueryBindings[];
      return raw.run(sql, bindings);
    },
    exec: (sql) => { raw.exec(sql); },
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
}

interface Scaffold {
  store: MultiremiStore;
  app: ReturnType<typeof createMultiremiApp>;
  probe: Probe;
  fixture: DaemonTaskPollFixture;
  headers: Record<string, string>;
}

/** A running Task whose prompt is large enough that any payload read is visible. */
async function scaffold(): Promise<Scaffold> {
  const db = openSqliteDatabase(":memory:");
  databases.push(db);
  const probe: Probe = {
    statements: [],
    reset() { this.statements = []; },
  };
  const store = new MultiremiStore(countingDatabase(db, probe));
  store.ensureLocalWorkspace();
  const fixture = await seedDaemonTaskPollFixture(store, {
    run: (sql, params) => { db.run(sql, params as SQLQueryBindings[]); },
  });
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  return {
    store,
    app,
    probe,
    fixture,
    headers: { Authorization: `Bearer ${fixture.daemonToken}`, "content-type": "application/json" },
  };
}

async function countRoute(
  scaffolded: Scaffold,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<string[]> {
  scaffolded.probe.reset();
  const response = await scaffolded.app.request(path, {
    method,
    headers: scaffolded.headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.status).toBe(200);
  return [...scaffolded.probe.statements];
}

/**
 * Statement ceilings for the owner daemon's happy path.
 *
 * Tight on purpose: each is the measured count at the time of writing, so any of
 * the three regressions this file exists for pushes a route over its ceiling.
 *   - `getRuntimeLite` -> `getRuntime` adds the three derived Runtime reads;
 *   - moving the Feishu exception back ahead of the owner comparison adds its
 *     four-table JOIN to `status`;
 *   - putting the task payload back is caught by the column assertions below
 *     rather than by the count, because the projection is what changes.
 */
const MAX_STATEMENTS = { status: 6, steer: 5, messages: 9 } as const;

/** Statements that must never appear on a task-level poll. */
const FORBIDDEN_SQL = [
  /\bSELECT\s+\*\s+FROM\s+multiremi_tasks\b/i,
  /\bmultiremi_tasks\.prompt\b/i,
  /\bSELECT\b[\s\S]*\bprompt\b[\s\S]*\bFROM\s+multiremi_tasks\b/i,
];

function expectNoTaskPayloadReads(sql: string[]): void {
  for (const statement of sql) {
    for (const pattern of FORBIDDEN_SQL) {
      expect(`${statement}`, `statement matched ${pattern}: ${statement}`).not.toMatch(pattern);
    }
  }
}

describe("MUL-474 daemon task-level polls", () => {
  it("bounds GET status and never reads the task payload", async () => {
    const scaffolded = await scaffold();
    const sql = await countRoute(scaffolded, "GET", `/api/daemon/tasks/${scaffolded.fixture.taskId}/status`);
    expect(sql.length).toBeLessThanOrEqual(MAX_STATEMENTS.status);
    expectNoTaskPayloadReads(sql);
  });

  it("bounds GET steer and never reads the task payload", async () => {
    const scaffolded = await scaffold();
    const sql = await countRoute(scaffolded, "GET", `/api/daemon/tasks/${scaffolded.fixture.taskId}/steer`);
    expect(sql.length).toBeLessThanOrEqual(MAX_STATEMENTS.steer);
    expectNoTaskPayloadReads(sql);
  });

  it("bounds POST messages for one message and never reads the task payload", async () => {
    const scaffolded = await scaffold();
    const sql = await countRoute(scaffolded, "POST", `/api/daemon/tasks/${scaffolded.fixture.taskId}/messages`, {
      messages: [{ type: "text", content: "one message" }],
    });
    expect(sql.length).toBeLessThanOrEqual(MAX_STATEMENTS.messages);
    expectNoTaskPayloadReads(sql);
  });

  it("serves the guard read, then a write, then the handler re-read from the database", async () => {
    const scaffolded = await scaffold();
    // The guard reads identity, the handler reads the row, `completeTask` writes
    // and then re-reads the row to build its response.
    scaffolded.probe.reset();
    const response = await scaffolded.app.request(`/api/daemon/tasks/${scaffolded.fixture.taskId}/complete`, {
      method: "POST",
      headers: scaffolded.headers,
      body: JSON.stringify({ output: "MUL-474 completed" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { status?: string; result?: { output?: string } };
    // The response is built from the post-write row: a stale cached row would
    // report `running` and no result.
    expect(body.status).toBe("completed");
    expect(body.result?.output).toBe("MUL-474 completed");

    const sql = [...scaffolded.probe.statements];
    const writeIndex = sql.findIndex((statement) => /^UPDATE\s+multiremi_tasks\s+SET\s+status/i.test(statement));
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    // A read after the write must have reached the database — that is the
    // request-cache invalidation doing its job, not a stale cache hit.
    expect(sql.slice(writeIndex + 1).some((statement) => /^SELECT \* FROM multiremi_tasks WHERE id = \?$/i.test(statement)))
      .toBe(true);
  });
});

/**
 * The `status` body is a contract: the Feishu host renders
 * `getFeishuBotTaskSnapshot` from it. This compares against a capture taken on the
 * pre-change commit, field for field and byte for byte, so a projection that
 * silently drops or renames a column cannot pass.
 */
describe("MUL-474 daemon GET task status golden", () => {
  it("returns the same body the pre-change implementation returned", async () => {
    const db = openSqliteDatabase(":memory:");
    databases.push(db);
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const fixture = await seedDaemonTaskPollFixture(store, {
      run: (sql, params) => { db.run(sql, params as SQLQueryBindings[]); },
    });
    db.run(
      "UPDATE multiremi_tasks SET started_at = ? WHERE id = ?",
      [golden.fixture.startedAt, fixture.taskId],
    );
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });

    const response = await app.request(`/api/daemon/tasks/${fixture.taskId}/status`, {
      headers: { Authorization: `Bearer ${fixture.daemonToken}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();

    // Field-by-field first, so a failure names the drifted key...
    expect(body).toEqual(golden.statusBody);
    // ...and again on the serialized bytes, which is the form the daemon and the
    // Feishu host actually consume.
    expect(JSON.stringify(body)).toBe(JSON.stringify(golden.statusBody));
  });

  // The running case above has `result: null`. These cover the stored shapes a
  // projection's `result` / `session_id` / `work_dir` fallbacks have to survive.
  it("matches the pre-change body for every stored result shape", async () => {
    const db = openSqliteDatabase(":memory:");
    databases.push(db);
    const store = new MultiremiStore(db);
    store.ensureLocalWorkspace();
    const fixture = await seedDaemonTaskPollFixture(store, {
      run: (sql, params) => { db.run(sql, params as SQLQueryBindings[]); },
    });
    await seedDaemonTaskPollResultCases(store, (sql, params) => {
      db.run(sql, params as SQLQueryBindings[]);
    });
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });

    expect(golden.resultBodies).toHaveLength(4);
    for (const expected of golden.resultBodies) {
      const response = await app.request(`/api/daemon/tasks/${expected.taskId}/status`, {
        headers: { Authorization: `Bearer ${fixture.daemonToken}` },
      });
      expect(response.status, expected.label).toBe(200);
      const body = await response.json();
      expect(body, expected.label).toEqual(expected.body);
      expect(JSON.stringify(body), expected.label).toBe(JSON.stringify(expected.body));
    }
  });
});

/**
 * The claim route reads the Task, awaits knowledge hydration — which is not a
 * store write — and then re-reads the Task to decide whether it is still
 * dispatched on this Runtime. That re-read is the only thing standing between a
 * cancel that lands during hydration and a Task being handed out anyway, so it
 * must not be answered from the request cache.
 */
describe("MUL-474 daemon claim re-checks a Task cancelled during hydration", () => {
  it("returns no task when the cancel lands while hydration is in flight", async () => {
    const db = openSqliteDatabase(":memory:");
    databases.push(db);
    const probe: Probe = { statements: [], reset() { this.statements = []; } };
    const store = new MultiremiStore(countingDatabase(db, probe));
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ id: "agt_mul474_claim", name: "claim agent", provider: "codex", workspaceId: "local" });
    store.registerRuntime({
      id: "rt_mul474_claim",
      name: "claim runtime",
      provider: "codex",
      workspaceId: "local",
      daemonId: "daemon-mul474-claim",
      ownerId: "local",
    });
    const task = store.createTask({ id: "tsk_mul474_claim", agentId: agent.id, workspaceId: "local", prompt: "claim" });
    const token = await store.createAccessToken({
      name: "claim daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: "daemon-mul474-claim",
    });

    // Hold the claim inside hydration, cancel the Task, then release. Both polls
    // must come back empty: the claim is not allowed to hand out a cancelled Task.
    //
    // The wait is a condition gate, not a sleep: `entered` resolves when hydration
    // is actually in flight, so the cancel provably lands inside the window the
    // re-check exists to close. A fixed sleep would pass on a fast machine even if
    // the ordering it needs never happened.
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let hydrationCalls = 0;
    const projectKnowledge = {
      hydrateTaskKnowledge: async (input: unknown) => {
        hydrationCalls += 1;
        signalEntered();
        await released;
        return input;
      },
    };
    const app = createMultiremiApp({
      store,
      authToken: AUTH_TOKEN,
      projectKnowledge: projectKnowledge as never,
    });
    const headers = { Authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const requests = [0, 1].map(() =>
      app.request("/api/daemon/runtimes/rt_mul474_claim/tasks/claim", { method: "POST", headers }));
    await entered;
    // The single-flight guard means only the first poll hydrates, and it is now
    // parked inside hydration with its pre-cancel read already done.
    expect(hydrationCalls).toBe(1);
    store.cancelTask(task.id);
    release();
    for (const response of await Promise.all(requests)) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ task: null });
    }
    expect(store.getTask(task.id)?.status).toBe("cancelled");
  });
});

/**
 * The guard's branches are reordered, not removed: the owner is allowlisted by
 * identity before the Feishu exceptions are probed. These cases drive the real
 * app over the same Task with four credentials and assert the answers did not
 * move — an owner that stopped being allowed, or a non-owner that gained access,
 * fails here.
 */
describe("MUL-474 daemon task authority matrix", () => {
  /** The scaffold builds the app with this master token, so it is the one to use. */
  const masterHeaders = { Authorization: `Bearer ${AUTH_TOKEN}` };

  async function authorityScaffold(): Promise<{ scaffolded: Scaffold }> {
    return { scaffolded: await scaffold() };
  }

  it("allows the owning daemon, refuses every other daemon, and keeps the master token working", async () => {
    const { scaffolded } = await authorityScaffold();
    const { store, app, fixture } = scaffolded;
    const taskPath = `/api/daemon/tasks/${fixture.taskId}`;
    const owner = { Authorization: `Bearer ${fixture.daemonToken}`, "content-type": "application/json" };
    const foreign = { Authorization: `Bearer ${fixture.foreignDaemonToken}`, "content-type": "application/json" };

    expect((await app.request(`${taskPath}/status`, { headers: owner })).status).toBe(200);
    expect((await app.request(`${taskPath}/steer`, { headers: owner })).status).toBe(200);

    // A non-owner daemon keeps the exact refusal it had before the reorder. This
    // Task has no Feishu transport binding, so neither exception applies.
    for (const [method, path, body] of [
      ["GET", `${taskPath}/status`, undefined],
      ["GET", `${taskPath}/steer`, undefined],
      ["GET", `${taskPath}/messages`, undefined],
      ["POST", `${taskPath}/messages`, JSON.stringify({ messages: [{ type: "text", content: "x" }] })],
      ["POST", `${taskPath}/complete`, JSON.stringify({ output: "x" })],
      ["POST", `${taskPath}/fail`, JSON.stringify({ error: "x" })],
    ] as const) {
      const response = await app.request(path, {
        method,
        headers: foreign,
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({
        error: "forbidden for daemon identity",
        code: "daemon_identity_forbidden",
      });
    }
    // Nothing the foreign daemon attempted was applied.
    expect(store.getTask(fixture.taskId)?.status).toBe("running");
    expect(store.listTaskMessages(fixture.taskId).map((message) => message.content)).toEqual(["fixture message"]);

    // The deployment master token is not a daemon credential, so it never
    // entered the reordered branch and still reads the snapshot.
    expect((await app.request(`${taskPath}/status`, { headers: masterHeaders })).status).toBe(200);
  });

  it("refuses a non-owner on the steer/consume write path too", async () => {
    const { scaffolded } = await authorityScaffold();
    const { app, fixture } = scaffolded;
    const response = await app.request(`/api/daemon/tasks/${fixture.taskId}/steer/consume`, {
      method: "POST",
      headers: { Authorization: `Bearer ${fixture.foreignDaemonToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(response.status).toBe(403);
  });

  it("keeps the Feishu host exception working for a Chat task on another daemon", async () => {
    const scaffolded = await scaffold();
    const { store, app, fixture } = scaffolded;
    // The Task the foreign daemon must be able to read is a Chat transport Task
    // it hosts: `submitFeishuBotMessage` creates the Session, binding, delivery and
    // Task the exception probe joins on. Its executing daemon is a third Runtime.
    const executorDaemonId = "daemon-mul474-executor";
    store.registerRuntime({
      id: "rt_mul474_executor",
      name: "MUL-474 executor",
      provider: "codex",
      workspaceId: "local",
      daemonId: executorDaemonId,
      ownerId: "local",
    });
    const executor = await store.createAccessToken({
      name: "MUL-474 executor daemon",
      type: "daemon",
      workspaceId: "local",
      daemonId: executorDaemonId,
    });
    // The hosting Runtime owns the bot for the duration of this case.
    store.upsertFeishuBotConfig("local", {
      agentId: fixture.agentId,
      runtimeId: fixture.foreignRuntimeId,
      appId: DAEMON_TASK_POLL_APP_ID,
      appSecretOp: "keep",
      enabled: true,
      domain: "feishu",
    });
    const configRevision = store.getFeishuBotConfig("local")?.revision ?? 1;
    const submitted = store.submitFeishuBotMessage("local", fixture.foreignRuntimeId, {
      revision: configRevision,
      externalSessionKey: "oc_mul474_host",
      externalMessageId: "om_mul474_host",
      chatId: "oc_mul474_host",
      chatType: "p2p",
      text: "host task",
    });
    const taskPath = `/api/daemon/tasks/${submitted.taskId}`;
    const host = { Authorization: `Bearer ${fixture.foreignDaemonToken}` };
    // The executor claims the Task, which is what makes its daemon the owner.
    expect(store.claimTask("rt_mul474_executor")?.id).toBe(submitted.taskId);
    store.startTask(submitted.taskId);

    // Exception holds: the hosting daemon may read the snapshot ...
    expect((await app.request(`${taskPath}/status`, { headers: host })).status).toBe(200);
    // ... but not mutate the run it does not execute.
    expect((await app.request(`${taskPath}/complete`, {
      method: "POST",
      headers: { ...host, "content-type": "application/json" },
      body: JSON.stringify({ output: "not mine" }),
    })).status).toBe(403);
    // The executing daemon reads and writes it normally.
    const executing = { Authorization: `Bearer ${executor.token}` };
    expect((await app.request(`${taskPath}/status`, { headers: executing })).status).toBe(200);
    expect((await app.request(`${taskPath}/complete`, {
      method: "POST",
      headers: { ...executing, "content-type": "application/json" },
      body: JSON.stringify({ output: "Mine" }),
    })).status).toBe(200);
    // Once the connector is reassigned away, the exception no longer holds.
    store.heartbeatRuntime("rt_mul474_executor", { supportsFeishuBotConfig: true });
    store.upsertFeishuBotConfig("local", {
      agentId: fixture.agentId,
      runtimeId: "rt_mul474_executor",
      appId: DAEMON_TASK_POLL_APP_ID,
      appSecretOp: "keep",
      enabled: true,
      domain: "feishu",
    });
    expect((await app.request(`${taskPath}/status`, { headers: host })).status).toBe(403);
  });
});

/**
 * The browser task-message frames are a contract as well: the fan-out now takes a
 * `TaskMessageFanoutSubject` instead of a whole Task, and the payload must not
 * have moved with it. The golden was captured on the pre-change commit with the
 * same fixture (both fan-out branches, a visible and a denied recipient), and the
 * comparison is on the emitted frame text — what a browser actually receives.
 */
describe("MUL-474 browser task-message fan-out wire payload", () => {
  it("emits the same frames the pre-change implementation emitted, byte for byte", () => {
    const restoreClock = installDeterministicFanoutClock();
    const db = openSqliteDatabase(":memory:");
    databases.push(db);
    try {
      const store = fanoutFixtureStore(db);
      const frames = driveTaskMessageFanout(store, notifyBrowserTaskMessages);

      expect(frames.workspaceFrames).toEqual(fanoutGolden.workspaceFrames);
      expect(frames.chatFrames).toEqual(fanoutGolden.chatFrames);
      // A recipient without access to the Task receives nothing, before and after.
      expect(frames.deniedFrames).toEqual(fanoutGolden.deniedFrames);
      // Serialized comparison too: the daemon-facing consumers read the bytes.
      expect(JSON.stringify(frames)).toBe(JSON.stringify({
        workspaceFrames: fanoutGolden.workspaceFrames,
        chatFrames: fanoutGolden.chatFrames,
        deniedFrames: fanoutGolden.deniedFrames,
      }));
    } finally {
      restoreClock();
    }
  });
});
