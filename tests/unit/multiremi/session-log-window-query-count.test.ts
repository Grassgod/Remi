// Guards for `GET /api/sessions/:sessionId/log`, the read every Chat switch and
// Issue session open issues.
//
// The window used to run three statements per turn card (turn+attempt, reply
// body, usage) and four to six per protected row for its visibility source
// (turn, attempt fallback, task row, usage, autopilot run), plus one message
// read per reply. On PostgreSQL every statement blocks the API thread on the
// synchronous bridge. This file pins three properties:
//
//   1. the response bytes do not drift — every probe is compared with
//      `session-log-window-golden.json`, captured from the per-row
//      implementation (`capture-session-log-window-golden.ts`), including the
//      authorization variants (other member's Chat, task credential, private
//      Agent turns hidden from a member);
//   2. the statement count is fixed and does not grow with the window;
//   3. the batched store reads equal the per-row reads they replace.
import { afterAll, describe, expect, it } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import { TURN_CARD_BATCH_SIZE, projectTurnCards } from "@multiremi/store/turn-attempts.js";
import { openHotspotDatabase, useMigratedHotspotDatabases } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { installDeterministicIds } from "../../fixtures/multiremi/issue-detail-first-screen-fixture.js";
import {
  readSessionLogWindowResponses,
  seedSessionLogWindowFixture,
} from "../../fixtures/multiremi/session-log-window-fixture.js";
import golden from "../../fixtures/multiremi/session-log-window-golden.json";

useMigratedHotspotDatabases();

let databases: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];

afterAll(async () => {
  for (const database of databases) await database.dispose();
  databases = [];
});

const AUTH_TOKEN = "session-log-window-master";
/** Seeding runs every production writer; over the PostgreSQL bridge it takes tens of seconds. */
const SEEDED_TEST_TIMEOUT = 180_000;

/** Seed once per describe block; the tests in a block only read, or mutate last. */
function once<T>(create: () => Promise<T>): () => Promise<T> {
  let created: Promise<T> | undefined;
  return () => (created ??= create());
}

interface Probe {
  statements: number;
  bySql: Map<string, number>;
  reset(): void;
}

/** Wrap the driver so every executed statement is counted. */
function countingDatabase(raw: SqlDatabase, probe: Probe): SqlDatabase {
  const record = (sql: string): void => {
    probe.statements += 1;
    const key = sql.replace(/\s+/g, " ").trim();
    probe.bySql.set(key, (probe.bySql.get(key) ?? 0) + 1);
  };
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
  const wrapped: SqlDatabase = {
    get inTransaction() { return raw.inTransaction; },
    query: (sql) => wrap(raw.query(sql) as unknown as SqlStatement, sql),
    prepare: (sql) => wrap(raw.prepare(sql) as unknown as SqlStatement, sql),
    run(sql, ...params) {
      record(sql);
      const bindings = (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as SQLQueryBindings[];
      return raw.run(sql, bindings);
    },
    exec: (sql) => {
      raw.exec(sql);
    },
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
  return new Proxy(raw, { get(target, property) {
    const source = property in wrapped ? wrapped : target;
    const value = Reflect.get(source, property);
    return typeof value === "function" ? value.bind(source) : value;
  } });
}

async function openStore(counted = false) {
  const database = await openHotspotDatabase();
  databases.push(database);
  const probe: Probe = {
    statements: 0,
    bySql: new Map(),
    reset() {
      this.statements = 0;
      this.bySql = new Map();
    },
  };
  const db = counted ? countingDatabase(database.db, probe) : database.db;
  const store = new MultiremiStore(db);
  return { store, db: database.db, probe, app: () => createMultiremiApp({ store, authToken: AUTH_TOKEN }) };
}

const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

/** Statements shaped like the per-row reads the window must not issue any more. */
const PER_ROW_READS = [
  "WHERE t.id=?",
  "SELECT body_md FROM multiremi_conversation_log WHERE id=?",
  "SELECT * FROM multiremi_turns WHERE id=?",
  "SELECT turn_id FROM multiremi_turn_attempts WHERE id=?",
  "SELECT * FROM multiremi_turn_execution_records WHERE id = ?",
  "SELECT * FROM multiremi_conversation_log WHERE id=? AND kind='message'",
];

describe("session log window response bytes", () => {
  it("matches the per-row golden for the Chat, Issue and authorization probes", async () => {
    const { store, db, app: createApp } = await openStore();
    // Pin ids and the clock after migration and before the app, exactly like the capture script.
    const restoreIds = installDeterministicIds();
    try {
      const app = createApp();
      const fixture = await seedSessionLogWindowFixture(store);
      const responses = await readSessionLogWindowResponses((path, init) => app.request(path, init), db, fixture);
      expect(responses.map(({ name, path, status }) => ({ name, path, status })))
        .toEqual(golden.probes.map(({ name, path, status }) => ({ name, path, status })));
      for (const [index, response] of responses.entries()) {
        const expected = golden.probes[index]!;
        // `c.json` is `JSON.stringify`, so this is a byte comparison with the capture.
        expect({ name: response.name, body: response.body })
          .toEqual({ name: expected.name, body: JSON.stringify(expected.body) });
        expect(Buffer.byteLength(response.body, "utf8")).toBe(expected.bytes);
      }

      // The authorization outcomes the golden pins, spelled out.
      const body = (name: string) => JSON.parse(responses.find(response => response.name === name)!.body);
      expect(body("chat-other-member")).toEqual({ error: "not your chat session" });
      expect(body("chat-not-creator")).toEqual({ error: "not your chat session" });
      const turnCards = (name: string) => body(name).entries.filter((entry: { kind: string }) => entry.kind === "turn");
      // A task credential sees no other turn's card, and sees its own once shown.
      expect(turnCards("chat-task-credential")).toEqual([]);
      expect(turnCards("chat-task-credential-own-card").map((entry: { task_id: string }) => entry.task_id))
        .toEqual([fixture.runningTaskId]);
      expect(turnCards("chat-window-own-card").length).toBe(2);
      // A plain member does not see the private Agent's Issue turns; the owner does.
      const assignees = (name: string) => new Set(turnCards(name)
        .map((entry: { metadata: { assignee_agent_id: string } }) => entry.metadata.assignee_agent_id));
      expect(assignees("issue-window").size).toBe(2);
      expect(assignees("issue-window-member").size).toBe(1);
    } finally {
      restoreIds();
    }
  }, SEEDED_TEST_TIMEOUT);
});

describe("session log window statement counts", () => {
  const counted = once(async () => {
    const opened = await openStore(true);
    const app = opened.app();
    const fixture = await seedSessionLogWindowFixture(opened.store);
    // A credential's first request records `last_used_at`; later ones in the
    // throttle window do not. Spend that write outside the measured reads.
    for (const token of Object.values(fixture.tokens)) await app.request("/api/me", auth(token));
    const read = async (path: string, token: string) => {
      opened.probe.reset();
      const response = await app.request(path, auth(token));
      expect(response.status).toBe(200);
      const body = await response.json() as { entries: unknown[] };
      // A guard may read one such row (the task credential's own task); a
      // window with ten turns would repeat it per row.
      const perRow = [...opened.probe.bySql.entries()]
        .filter(([sql, count]) => count > 1 && PER_ROW_READS.some(shape => sql.includes(shape)));
      return { statements: opened.probe.statements, entries: body.entries.length, perRow, bySql: [...opened.probe.bySql] };
    };
    return { fixture, read };
  });

  it("reads a 30-row Chat window in a fixed number of statements", async () => {
    const { fixture, read } = await counted();
    const chat = `/api/sessions/${fixture.chatId}/log`;
    const window = await read(`${chat}?before=30`, fixture.tokens.owner);
    expect(window.entries).toBe(30);
    // token, Issue-session probe, Chat, its Agent + skills (guard), head, rows,
    // previous, next, before-count, turns+attempts, reply bodies, usage,
    // visibility subjects, attachments. The Chat row seeds the visibility memo,
    // and a Chat task's decision does not read its Agent.
    expect(window.perRow).toEqual([]);
    expect({ statements: window.statements, bySql: window.bySql }).toMatchObject({ statements: 15 });
    // The window includes the retried turn, whose card points at a second attempt.
    expect(fixture.retriedTaskId).not.toBe("");

    // Three times the rows, same statements.
    const wide = await read(`${chat}?before=90`, fixture.tokens.owner);
    expect(wide.entries).toBe(90);
    expect(wide.statements).toBe(window.statements);

    // The head read the Chat page issues with the window.
    const head = await read(`${chat}?anchor=0&before=1`, fixture.tokens.owner);
    expect(head.entries).toBe(1);
    expect(head.statements).toBe(9);

    // A task credential pays its own token checks, not per-row reads.
    const credential = await read(`${chat}?before=30`, fixture.tokens.task);
    expect(credential.perRow).toEqual([]);
    expect(credential.statements).toBe(17);
  }, SEEDED_TEST_TIMEOUT);

  it("reads a 30-row Issue session window with activity in a fixed number of statements", async () => {
    const { fixture, read } = await counted();
    const issue = `/api/sessions/${fixture.issueSessionId}/log`;
    const window = await read(`${issue}?before=30&with_activity=1`, fixture.tokens.owner);
    expect(window.entries).toBe(30);
    // token, session, Issue + labels, head, rows, previous, next, before-count,
    // turns+attempts, usage, related messages, visibility subjects, two
    // Agents + skills (one per distinct Agent), activity, reactions, attachments.
    expect(window.perRow).toEqual([]);
    expect({ statements: window.statements, bySql: window.bySql }).toMatchObject({ statements: 20 });
    const wide = await read(`${issue}?before=45&with_activity=1`, fixture.tokens.owner);
    expect(wide.entries).toBe(45);
    expect(wide.statements).toBe(window.statements);
    // A member who cannot see the private Agent shares the batched reads. The
    // unchanged decision still reads the workspace role once per private
    // source it rejects (`canUserAccessAgentByUserId`), outside this batching.
    const member = await read(`${issue}?before=30&with_activity=1`, fixture.tokens.member);
    expect(member.perRow).toEqual([]);
  }, SEEDED_TEST_TIMEOUT);
});

describe("batched session log reads equal the per-row reads", () => {
  // Shared by the three cases; only the subject case mutates, at its very end.
  const seeded = once(async () => {
    const { store, db } = await openStore();
    return { store, db, fixture: await seedSessionLogWindowFixture(store) };
  });

  it("projects every turn card exactly like the single-row projection, in any batch size", async () => {
    const { store, db, fixture } = await seeded();
    for (const sessionId of [fixture.chatId, fixture.issueSessionId]) {
      const all = store.listConversationLogEntries(sessionId);
      expect(all.filter(entry => entry.kind === "turn").length).toBeGreaterThan(10);
      const single = all.map(entry => store.getConversationLogEntry(sessionId, entry.seq));
      expect(all).toEqual(single as typeof all);
      // Chunking: a batch smaller than the turn count gives the same cards.
      const raw = all.map(entry => entry.kind === "turn" ? { ...entry, metadata: {}, body_md: "", task_id: null } : entry);
      expect(projectTurnCards(db, raw, 3)).toEqual(all);
    }
    // The default batch size: both sessions together hold more turn cards than
    // one batch, so the default read splits and must still match row by row.
    const both = [...store.listConversationLogEntries(fixture.chatId), ...store.listConversationLogEntries(fixture.issueSessionId)];
    expect(both.filter(entry => entry.kind === "turn").length).toBeGreaterThan(TURN_CARD_BATCH_SIZE);
    const blanked = both.map(entry => entry.kind === "turn" ? { ...entry, metadata: {}, body_md: "", task_id: null } : entry);
    expect(projectTurnCards(db, blanked)).toEqual(both);
    expect(projectTurnCards(db, [])).toEqual([]);
    const pointer = store.listConversationLogEntries(fixture.chatId).find(entry => entry.kind === "turn")!;
    expect(() => projectTurnCards(db, [{ ...pointer, id: "trn_missing" }]))
      .toThrow("Missing turn for conversation pointer: trn_missing");
  }, SEEDED_TEST_TIMEOUT);

  it("resolves source subjects exactly like the per-id turn, attempt and task lookup", async () => {
    const { store, db, fixture } = await seeded();
    const turns = db.query("SELECT id FROM multiremi_turns").all() as Array<{ id: string }>;
    const attempts = db.query("SELECT id FROM multiremi_turn_attempts").all() as Array<{ id: string }>;
    const unknown = Array.from({ length: 450 }, (_, index) => `tsk_unknown_${index}`);
    const ids = [...turns.map(row => row.id), ...attempts.map(row => row.id), ...unknown];
    // The failed first attempt of the retried turn resolves to its replacement.
    const failedAttempt = attempts.map(row => row.id).find(id => id !== fixture.retriedTaskId
      && store.getTurnForAttempt(id)?.current_attempt_id === fixture.retriedTaskId)!;
    expect(failedAttempt).toBeDefined();
    const batched = store.getConversationSourceSubjects([...ids, ""]);
    expect(batched.has("")).toBe(false);
    expect(batched.size).toBe(new Set(ids).size);
    for (const id of ids) {
      const turn = store.getTurn(id) ?? store.getTurnForAttempt(id);
      const task = turn?.current_attempt_id ? store.getTask(turn.current_attempt_id) : null;
      expect({ id, subject: batched.get(id) }).toEqual({ id, subject: task ? {
        id: task.id, workspaceId: task.workspaceId, agentId: task.agentId, chatSessionId: task.chatSessionId,
        issueId: task.issueId, issueSessionId: task.issueSessionId,
      } : null });
    }
    expect(batched.get(failedAttempt)?.id).toBe(fixture.retriedTaskId);
    expect(unknown.every(id => batched.get(id) === null)).toBe(true);

    // A turn whose current attempt has no execution record is no task on both paths.
    const orphan = fixture.runningTurnId;
    db.run("UPDATE multiremi_turns SET current_attempt_id = ? WHERE id = ?", ["tsk_absent_attempt", orphan]);
    expect(store.getTask("tsk_absent_attempt")).toBeNull();
    expect(store.getTurn(orphan)?.current_attempt_id).toBe("tsk_absent_attempt");
    expect(store.getConversationSourceSubjects([orphan]).get(orphan)).toBeNull();
  }, SEEDED_TEST_TIMEOUT);

  it("reads messages exactly like getMessage, across batches", async () => {
    const { store, db, fixture } = await seeded();
    const ids = (db.query("SELECT id FROM multiremi_conversation_log WHERE session_id IN (?, ?)")
      .all(fixture.chatId, fixture.issueSessionId) as Array<{ id: string }>).map(row => row.id);
    const unknown = Array.from({ length: 420 }, (_, index) => `msg_unknown_${index}`);
    const batched = store.getMessages([...unknown, ...ids, ""]);
    const expected = new Map(ids.flatMap(id => {
      const message = store.getMessage(id);
      return message ? [[id, message] as const] : [];
    }));
    expect(expected.size).toBeGreaterThan(50);
    expect(batched).toEqual(expected);
  }, SEEDED_TEST_TIMEOUT);
});
