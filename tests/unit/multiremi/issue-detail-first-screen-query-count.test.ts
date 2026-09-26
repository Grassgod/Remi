// MUL-385: guards for the Issue detail first-screen routes.
//
// The three routes the detail page fires on open are `GET /api/issues/:id`,
// `/sessions` and `/timeline?issue_session_id=@default&limit=40`. This file
// pins two properties that a future refactor could quietly break:
//
//   1. the response shape does not drift — each route's body is compared
//      against a golden captured from the pre-optimization implementation
//      (`tests/fixtures/multiremi/issue-detail-first-screen-golden.json`), and
//      a `bun run scripts/snapshot-api-routes.ts --check` run covers the same
//      ground for the whole route table;
//   2. the query count is bounded — `/sessions` must not grow with session
//      count, and `/api/issues/:id` must not re-load tasks/children/dependencies.
import { afterEach, describe, expect, it } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  installDeterministicIds,
  normalizeIssueDetailResponse,
  seedIssueDetailFirstScreenFixture,
} from "../../fixtures/multiremi/issue-detail-first-screen-fixture.js";
import golden from "../../fixtures/multiremi/issue-detail-first-screen-golden.json";

let databases: Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

const AUTH_TOKEN = "mul385-first-screen-token";
const AUTH_HEADERS = { Authorization: `Bearer ${AUTH_TOKEN}` };

/** Bind the fixture's pinned `joined_at` writes without tripping the binder types. */
function runPinned(db: Database, sql: string, params: unknown[]): void {
  db.run(sql, params as SQLQueryBindings[]);
}

interface Probe {
  statements: number;
  bySql: Map<string, number>;
  reset(): void;
}

function countingDatabase(raw: Database, probe: Probe): SqlDatabase {
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
  return {
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
}

function createCountedStore(): { store: MultiremiStore; db: Database; probe: Probe } {
  const db = new Database(":memory:");
  databases.push(db);
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

function createStore(): { store: MultiremiStore; db: Database } {
  const db = new Database(":memory:");
  databases.push(db);
  return { store: new MultiremiStore(db), db };
}

describe("MUL-385 issue detail first-screen response shape", () => {
  it("matches the pre-optimization golden for all three routes", async () => {
    // The golden was captured with the same PRNG + clock pin, so ids and page
    // cursors line up and only a genuine shape change can fail this comparison.
    const restoreIds = installDeterministicIds();
    try {
    const { store, db } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const fixture = seedIssueDetailFirstScreenFixture(store, {
      run: (sql, params) => { runPinned(db, sql, params); },
    });

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
    } finally {
      restoreIds();
    }
  });

  it("keeps the timeline's legacy naked-array shape when no page parameter is sent", async () => {
    const { store, db } = createStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const fixture = seedIssueDetailFirstScreenFixture(store, {
      run: (sql, params) => { runPinned(db, sql, params); },
    });

    const body = await (await app.request(
      `/api/issues/${fixture.issueId}/timeline`,
      { headers: AUTH_HEADERS },
    )).json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("MUL-385 issue detail first-screen query counts", () => {
  it("keeps /api/issues/:id at exactly four statements", async () => {
    const { store, db, probe } = createCountedStore();
    const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
    const fixture = seedIssueDetailFirstScreenFixture(store, {
      run: (sql, params) => { runPinned(db, sql, params); },
    });

    probe.reset();
    const response = await app.request(`/api/issues/${fixture.issueId}`, { headers: AUTH_HEADERS });
    expect(response.status).toBe(200);

    // `SELECT *` for the issue, the label join, its reactions and its
    // attachments. Tasks, children, child progress and dependencies belong to
    // `/api/multiremi/issues/:id`, which must keep loading them.
    expect(probe.statements).toBe(4);
    expect([...probe.bySql.keys()].some((sql) => sql.includes("multiremi_tasks"))).toBe(false);
    expect([...probe.bySql.keys()].some((sql) => sql.includes("parent_issue_id"))).toBe(false);
    expect([...probe.bySql.keys()].some((sql) => sql.includes("multiremi_issue_dependencies"))).toBe(false);
  });

  it("keeps /sessions query count constant as session count grows", async () => {
    const counts: number[] = [];
    for (const sessions of [1, 10]) {
      const { store, db, probe } = createCountedStore();
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

  it("round-trips every session's participants through the batched lookup", async () => {
    const { store } = createCountedStore();
    const fixture = seedIssueDetailFirstScreenFixture(store);

    const sessions = store.listIssueSessions(fixture.issueId);
    const batched = store.listSessionParticipantsForSessions(sessions.map((session) => session.id));
    for (const session of sessions) {
      const expected = store.listSessionParticipants(session.id);
      expect(batched.get(session.id)).toEqual(expected);
      expect(expected.length).toBe(fixture.participantCountBySession[session.id]!);
    }

    // An empty input must not issue a statement and must not invent sessions.
    expect(store.listSessionParticipantsForSessions([]).size).toBe(0);
  });
});
