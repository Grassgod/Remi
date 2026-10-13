import { createResponsibleTestIssue, testWorkspaceMember } from './helpers.js';
// MUL-385: guards for the Issue detail first-screen routes.
//
// The three routes the detail page fires on open are `GET /api/issues/:id`,
// `/sessions` and `/timeline?issue_session_id=@default&limit=40`. This file
// pins two properties that a future refactor could quietly break:
//
//   1. the response shape does not drift — each route's body is compared
//      against a pinned golden (including S4's pending decision count)
//      (`tests/fixtures/multiremi/issue-detail-first-screen-golden.json`), and
//      a `bun run scripts/snapshot-api-routes.ts --check` run covers the same
//      ground for the whole route table;
//   2. the query count is bounded — `/sessions` must not grow with session
//      count, and `/api/issues/:id` must not re-load tasks/children/dependencies.
import { afterEach, describe, expect, it } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  installDeterministicIds,
  normalizeIssueDetailResponse,
  seedIssueDetailFirstScreenFixture,
} from "../../fixtures/multiremi/issue-detail-first-screen-fixture.js";
import golden from "../../fixtures/multiremi/issue-detail-first-screen-golden.json";

let databases: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];

afterEach(async () => {
  for (const database of databases) await database.dispose();
  databases = [];
});

const AUTH_TOKEN = "mul385-first-screen-token";
const AUTH_HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

/** Bind the fixture's pinned `joined_at` writes without tripping the binder types. */
function runPinned(db: SqlDatabase, sql: string, params: unknown[]): void {
  db.run(sql, params as SQLQueryBindings[]);
}

interface Probe {
  statements: number;
  bySql: Map<string, number>;
  reset(): void;
}

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
  return new Proxy(raw, {get(target, property) {
    const source = property in wrapped ? wrapped : target;
    const value = Reflect.get(source, property);
    return typeof value === "function" ? value.bind(source) : value;
  }});
}

async function createCountedStore(): Promise<{ store: MultiremiStore; db: SqlDatabase; probe: Probe }> {
  const database = await openHotspotDatabase();
  databases.push(database);
  const db = database.db;
  const probe: Probe = {
    statements: 0,
    bySql: new Map(),
    reset() {
      this.statements = 0;
      this.bySql = new Map();
    },
  };
  return { store: new MultiremiStore(countingDatabase(db, probe)), db, probe };
}

async function createStore(): Promise<{ store: MultiremiStore; db: SqlDatabase }> {
  const database = await openHotspotDatabase();
  databases.push(database);
  const db = database.db;
  return { store: new MultiremiStore(db), db };
}

describe("MUL-385 issue detail first-screen response shape", () => {
  it("matches the pinned golden, legacy timeline shape and participant hydration for all three routes", async () => {
    // The golden was captured with the same PRNG + clock pin, so ids and page
    // cursors line up and only a genuine shape change can fail this comparison.
    const restoreIds = installDeterministicIds();
    try {
      const { store, db } = await createStore();
      const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
      const fixture = seedIssueDetailFirstScreenFixture(store, {
        run: (sql, params) => { runPinned(db, sql, params); },
      });

      // Check untouched seed reads before any API route can hydrate or repair state.
      const storedSessions = store.listIssueSessions(fixture.issueId);
      const batched = store.listSessionParticipantsForSessions(storedSessions.map((session) => session.id));
      for (const session of storedSessions) {
        const expected = store.listSessionParticipants(session.id);
        expect(batched.get(session.id)).toEqual(expected);
        expect(expected.length).toBe(fixture.participantCountBySession[session.id]!);
      }

      // An empty input must not issue a statement and must not invent sessions.
      expect(store.listSessionParticipantsForSessions([]).size).toBe(0);

      const issueDetail = await (await app.request(`/api/issues/${fixture.issueId}`, { headers: AUTH_HEADERS })).json();
      const sessions = await (await app.request(`/api/issues/${fixture.issueId}/sessions`, { headers: AUTH_HEADERS })).json();
      const timeline = await (await app.request(
        `/api/issues/${fixture.issueId}/timeline?issue_session_id=%40default&limit=40`,
        { headers: AUTH_HEADERS },
      )).json();

      // Timestamps are scrubbed on both sides: the golden carries `<timestamp>`
      // placeholders, so field presence and value types are still compared while
      // the wall clock is not.
      expect(normalizeIssueDetailResponse(issueDetail)).toEqual(golden.issueDetail);
      expect(normalizeIssueDetailResponse(sessions)).toEqual(golden.sessions);
      expect(normalizeIssueDetailResponse(timeline)).toEqual(golden.timeline);

      const body = await (await app.request(
        `/api/issues/${fixture.issueId}/timeline`,
        { headers: AUTH_HEADERS },
      )).json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

    } finally {
      restoreIds();
    }
  });
});

describe("MUL-385 issue detail first-screen query counts", () => {
  it("includes unmet keys with one dependency read only while a child is in backlog", async () => {
    const { store, probe } = await createCountedStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const parent = createResponsibleTestIssue(store, { title: "Parent", status: "backlog" });
    const prerequisite = createResponsibleTestIssue(store, { title: "Prerequisite", status: "in_progress" });
    const child = createResponsibleTestIssue(store, { title: "Waiting child", parentIssueId: parent.id,
      status: "backlog", blockedBy: [prerequisite.id] });

    probe.reset();
    const waiting = await app.request(`/api/issues/${child.id}`, { headers: AUTH_HEADERS });
    expect(waiting.status).toBe(200);
    expect((await waiting.json()).blocked_by).toEqual([prerequisite.key]);
    expect(probe.statements).toBe(6);
    expect([...probe.bySql.entries()].filter(([sql]) => sql.includes("multiremi_issue_dependencies"))
      .reduce((sum, [, count]) => sum + count, 0)).toBe(1);

    store.updateIssue(child.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });
    probe.reset();
    const started = await app.request(`/api/issues/${child.id}`, { headers: AUTH_HEADERS });
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ status: "todo", blocked_by: [] });
    expect(probe.statements).toBe(5);
    expect([...probe.bySql.keys()].some(sql => sql.includes("multiremi_issue_dependencies"))).toBe(false);
  });

  it("counts only this Issue's own human-stage Qs, and nothing pending stays one aggregate statement", async () => {
    const { store, probe } = await createCountedStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const owner = store.createAgent({ name: "Count root owner", provider: "codex" });
    const worker = store.createAgent({ name: "Count child owner", provider: "codex" });
    const root = store.createIssue({ title: "Count root", assigneeType: "agent", assigneeId: owner.id });
    const child = store.createIssue({ title: "Count child", parentIssueId: root.id, assigneeType: "agent", assigneeId: worker.id });
    const member = testWorkspaceMember(store, root.workspaceId);
    const aggregate = (sql: string) => sql.includes("message_kind = 'decision'") && sql.includes("resolved_at IS NULL");
    const count = async (issueId: string) => {
      probe.reset();
      const response = await app.request(`/api/issues/${issueId}`, { headers: AUTH_HEADERS });
      expect(response.status).toBe(200);
      const pending = (await response.json() as { pending_decision_count: number }).pending_decision_count;
      expect([...probe.bySql.entries()].filter(([sql]) => aggregate(sql)).reduce((sum, [, n]) => sum + n, 0)).toBe(1);
      expect([...probe.bySql.keys()].some((sql) => sql.includes("SELECT * FROM multiremi_tasks"))).toBe(false);
      return pending;
    };
    // D10: with nothing pending the first-screen budget is unchanged — four reads plus one aggregate.
    expect(await count(root.id)).toBe(0);
    expect(probe.statements).toBe(5);

    // The child owner's native question climbs to the parent owner first: an Agent stage counts nowhere.
    const runtime = store.registerRuntime({ name: "Count native host", provider: "codex", daemonId: "count-native" });
    const task = store.createTask({ issueId: child.id, agentId: worker.id, prompt: "Ask the parent" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const created = store.getDaemonTurnBridge().rpc("turn.decision", { turn_id: turn.id, attempt_id: task.id,
      wait_id: "count-native-wait", dedupe_key: "count-native-question", body_md: "Which release window?", options: [],
      metadata: { kind: "question", questions: [{ question: "Which release window?" }] } },
      { runtimeId: runtime.id, daemonId: "count-native", workspaceId: "local" });
    expect(created.ok).toBe(true);
    const questionId = String(created.message_id);
    expect(store.getQuestion(questionId)).toMatchObject({ stage: "parent_owner", current_handler: { type: "agent", id: owner.id }, source_issue_id: child.id });
    expect(await count(child.id)).toBe(0);
    expect(await count(root.id)).toBe(0);

    // With no root owner left the climb stops there and the Q waits at the human stage;
    // it counts on its own Issue only, never on the parent it climbed through.
    store.updateIssue(root.id, { assigneeType: null, assigneeId: null, actorType: "member", actorId: member.id });
    expect(store.getQuestion(questionId)).toMatchObject({ stage: "human", current_handler: null, route_reason: `${root.id}:execution_owner_missing` });
    expect(await count(child.id)).toBe(1);
    expect(await count(root.id)).toBe(0);

    // Historical records that only members ever answered stay at the human stage and count on the root:
    // an escalated business decision with no provider wait, and a legacy Human Request.
    const session = store.getOrCreateDefaultIssueSession(root.id);
    const decision = store.appendConversationLog({ sessionId: session.id, kind: "message", authorType: "member", authorId: member.id,
      messageKind: "decision", bodyMd: "Choose the release window", metadata: { decision_record: {
        issue_id: root.id, source_issue_id: root.id, status: "escalated", kind: "question" } } });
    expect(store.getQuestion(decision.id)?.wait_status).toBe("none");
    const legacyTask = store.createTask({ agentId: owner.id, issueId: root.id, prompt: "Pending question" });
    store.createTaskHumanRequest({ taskId: legacyTask.id, kind: "question", payload: { message: "Pick a date" } });
    expect(await count(root.id)).toBe(2);

    // An answered Q drops out of the count.
    store.answerMessageDecision(questionId, { sender: { type: "member", id: member.id },
      expected_route_revision: store.getQuestion(questionId)!.route_revision, body_md: "Next Tuesday",
      response: { answers: { "Which release window?": "Next Tuesday" } } });
    expect(await count(child.id)).toBe(0);
    expect(await count(root.id)).toBe(2);
  });

  it("keeps /sessions query count constant as session count grows", async () => {
    const counts: number[] = [];
    for (const sessions of [1, 10]) {
      const { store, db, probe } = await createCountedStore();
      const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
      const fixture = seedIssueDetailFirstScreenFixture(store, {
        rootComments: 4,
        replies: 2,
        sideSessions: sessions - 1,
        tasks: 2,
        decoratedComments: 0,
      });

      probe.reset();
      const response = await app.request(`/api/issues/${fixture.issueId}/sessions`, { headers: AUTH_HEADERS });
      expect(response.status).toBe(200);
      const body = await response.json() as unknown[];
      expect(body).toHaveLength(sessions);
      counts.push(probe.statements);
    }

    // Issue lookup + session list + one batched participant scan + the label
    // join the session rows are hydrated with. The per-session form used to add
    // two statements per session (`listSessionParticipants` re-read the session
    // before scanning participants), so 1 vs 10 sessions went 9 → 27.
    expect(counts[0]).toBe(4);
    expect(counts[1]).toBe(counts[0]);
  });
});

/**
 * MUL-386: the golden scrubber rewrites the wall clock inside a timeline page
 * cursor (`base64url([createdAt, id])`), but only for that exact shape. The id
 * has to stay in the comparison, and a payload of any other shape has to survive
 * untouched — otherwise the guard would silently accept a real shape change.
 */
describe("MUL-386 cursor normalization", () => {
  const encodeCursor = (payload: unknown): string =>
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const decodeCursor = (cursor: string): unknown =>
    JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  const normalizeCursorField = (cursor: string): string => {
    const out = normalizeIssueDetailResponse({ next_cursor: cursor }) as { next_cursor: string };
    return out.next_cursor;
  };

  it("scrubs the timestamp and keeps the id verbatim", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_8yh955wqxxjs"]);
    expect(decodeCursor(normalizeCursorField(cursor))).toEqual(["<timestamp>", "cmt_8yh955wqxxjs"]);
  });

  it("scrubs prev_cursor the same way", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.187Z", "cmt_8yh955wqxxjs"]);
    const out = normalizeIssueDetailResponse({ prev_cursor: cursor }) as { prev_cursor: string };
    expect(decodeCursor(out.prev_cursor)).toEqual(["<timestamp>", "cmt_8yh955wqxxjs"]);
  });

  it("keeps the id participating in the comparison", () => {
    const first = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_first"]));
    const second = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_second"]));
    expect(first).not.toBe(second);
  });

  it("absorbs a millisecond shift and is idempotent", () => {
    const earlier = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.187Z", "cmt_x"]));
    const later = normalizeCursorField(encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_x"]));
    expect(later).toBe(earlier);
    expect(normalizeCursorField(later)).toBe(later);
  });

  it("leaves a single-element payload untouched", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z"]);
    expect(normalizeCursorField(cursor)).toBe(cursor);
  });

  it("leaves a payload whose id is not a string untouched", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z", 123]);
    expect(normalizeCursorField(cursor)).toBe(cursor);
  });

  it("keeps an id that merely looks like a timestamp", () => {
    const cursor = encodeCursor(["2026-09-20T12:00:00.188Z", "cmt_2026-09-20T12:00:00.188Z"]);
    expect(decodeCursor(normalizeCursorField(cursor))).toEqual([
      "<timestamp>",
      "cmt_2026-09-20T12:00:00.188Z",
    ]);
  });

  it("leaves payloads of other arities or shapes untouched", () => {
    for (const payload of [
      ["2026-09-20T12:00:00.188Z", "cmt_x", "extra"],
      [123, "2026-09-20T12:00:00.188Z"],
      ["see 2026-09-20T12:00:00.188Z", "cmt_x"],
      { createdAt: "2026-09-20T12:00:00.188Z", id: "cmt_x" },
      "2026-09-20T12:00:00.188Z",
      null,
    ]) {
      const cursor = encodeCursor(payload);
      expect(normalizeCursorField(cursor)).toBe(cursor);
    }
  });

  it("leaves an undecodable cursor untouched", () => {
    for (const cursor of ["not-json", "!!!", "YWJj"]) {
      expect(normalizeCursorField(cursor)).toBe(cursor);
    }
  });

  it("still replaces plain timestamps outside cursors", () => {
    const out = normalizeIssueDetailResponse({
      created_at: "2026-09-20T12:00:00.188Z",
      id: "cmt_8yh955wqxxjs",
      next_cursor: null,
    }) as Record<string, unknown>;
    expect(out).toEqual({ created_at: "<timestamp>", id: "cmt_8yh955wqxxjs", next_cursor: null });
  });
});
