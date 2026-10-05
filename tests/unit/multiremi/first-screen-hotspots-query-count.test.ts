// MUL-473 (S9-2, PR1): guards for `GET /api/chat/pending-tasks` and the
// assignee filter resolver behind `GET /api/issues`.
//
// Both routes were slow because they ran one statement per row, not because of
// a slow statement. This file pins the two properties that a future refactor
// could quietly give back:
//
//   1. the response does not drift — each route's body is compared against a
//      golden captured from the pre-optimization implementation
//      (`tests/fixtures/multiremi/first-screen-hotspots-golden.json`), which
//      covers ordering, counts and field presence;
//   2. the statement count and the bridged bytes do not grow with the number of
//      rows in play — measured on the issue's scale bar (50 Chats, 20 Agents,
//      300 inbox rows).
import { afterEach, describe, expect, it } from "bun:test";
import type { SQLQueryBindings } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  installFirstScreenHotspotIds,
  normalizeFirstScreenHotspotResponse,
} from "../../fixtures/multiremi/first-screen-hotspots-normalize.js";
import {
  seedFirstScreenHotspotsFixture,
  type FirstScreenHotspotsFixture,
  type FirstScreenHotspotsFixtureOptions,
} from "../../fixtures/multiremi/first-screen-hotspots-fixture.js";
import golden from "../../fixtures/multiremi/first-screen-hotspots-golden.json";
import { openHotspotDatabase } from "../../fixtures/multiremi/first-screen-hotspots-database.js";

let databases: Array<Awaited<ReturnType<typeof openHotspotDatabase>>> = [];

afterEach(async () => {
  for (const database of databases) await database.dispose();
  databases = [];
});

const AUTH_TOKEN = "mul473-hotspot-token";

interface Probe {
  statements: number;
  bytes: number;
  rows: number;
  bySql: Map<string, number>;
  reset(): void;
}

/** Wrap the driver so every *executed* statement is counted, not just prepared. */
function countingDatabase(raw: SqlDatabase, probe: Probe): SqlDatabase {
  const record = (sql: string, rows: unknown[]): void => {
    probe.statements += 1;
    probe.rows += rows.length;
    if (rows.length) probe.bytes += JSON.stringify({ rows, count: rows.length }).length;
    const key = sql.replace(/\s+/g, " ").trim();
    probe.bySql.set(key, (probe.bySql.get(key) ?? 0) + 1);
  };
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => new Proxy(statement, {
    get(target, property) {
      const value = target[property as keyof SqlStatement];
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          const result = (value as (...args: unknown[]) => unknown).apply(target, params);
          const rows = property === "get"
            ? (result == null ? [] : [result])
            : property === "values" || property === "all"
              ? (result as unknown[])
              : [];
          record(sql, rows);
          return result;
        };
      }
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  const wrapped: SqlDatabase = {
    query: (sql) => wrap(raw.query(sql) as unknown as SqlStatement, sql),
    prepare: (sql) => wrap(raw.prepare(sql) as unknown as SqlStatement, sql),
    run(sql, ...params) {
      record(sql, []);
      const bindings = (params.length === 1 && Array.isArray(params[0]) ? params[0] : params) as SQLQueryBindings[];
      return raw.run(sql, bindings);
    },
    exec: (sql) => {
      record(sql, []);
      raw.exec(sql);
    },
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
  return new Proxy(raw, {
    get(target, property) {
      const source = property in wrapped ? wrapped : target;
      const value = Reflect.get(source, property);
      return typeof value === "function" ? value.bind(source) : value;
    },
  });
}

function createProbe(): Probe {
  return {
    statements: 0,
    bytes: 0,
    rows: 0,
    bySql: new Map(),
    reset() {
      this.statements = 0;
      this.bytes = 0;
      this.rows = 0;
      this.bySql = new Map();
    },
  };
}

interface Harness {
  store: MultiremiStore;
  db: SqlDatabase;
  probe: Probe;
  app: ReturnType<typeof createMultiremiApp>;
  fixture: FirstScreenHotspotsFixture;
  headers: Record<string, string>;
}

async function createHarness(options: FirstScreenHotspotsFixtureOptions = {}): Promise<Harness> {
  const database = await openHotspotDatabase();
  databases.push(database);
  const db = database.db;
  const probe = createProbe();
  const store = new MultiremiStore(countingDatabase(db, probe));
  const fixture = seedFirstScreenHotspotsFixture(store, {
    ...options,
    run: (sql, params) => { db.run(sql, params as SQLQueryBindings[]); },
  });
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  const credential = await store.createAccessToken({
    name: "MUL-473 hotspot test",
    type: "pat",
    userId: fixture.readerUserId,
    workspaceId: fixture.workspaceId,
    purpose: "session",
  });
  return {
    store,
    db,
    probe,
    app,
    fixture,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "X-Workspace-ID": fixture.workspaceId,
    },
  };
}

async function getJson(
  harness: Harness,
  path: string,
): Promise<{ body: unknown; statements: number; bytes: number }> {
  harness.probe.reset();
  const response = await harness.app.request(path, { headers: harness.headers });
  const text = await response.text();
  const statements = harness.probe.statements;
  const bytes = harness.probe.bytes;
  if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { body: JSON.parse(text) as unknown, statements, bytes };
}

describe("MUL-473 first-screen hotspot response shapes", () => {
  it("matches the pre-optimization golden for pending-tasks and the three assignee filters", async () => {
    // A capture in the same process (same pinned clock and PRNG) is what makes a
    // golden comparison meaningful: `installFirstScreenHotspotIds` is what the
    // capture script uses.
    const restoreIds = installFirstScreenHotspotIds();
    try {
      const harness = await createHarness();
      const pending = await getJson(harness, "/api/turns?status=pending");
      const byUserId = await getJson(harness, `/api/issues?assignee_id=${harness.fixture.readerUserId}&limit=50`);
      const byMemberRowId = await getJson(harness, `/api/issues?assignee_id=${harness.fixture.readerMemberId}&limit=50`);
      const byAgentName = await getJson(
        harness,
        `/api/issues?assignee_id=${encodeURIComponent("Hotspot agent 5")}&limit=50`,
      );
      const normalize = (body: unknown) => normalizeFirstScreenHotspotResponse(body, harness.fixture);
      expect(normalize(pending.body)).toEqual(golden.chatPendingTasks);
      expect(normalize(byUserId.body)).toEqual(golden.issuesMyAssignee);
      expect(normalize(byMemberRowId.body)).toEqual(golden.issuesByMemberRowId);
      expect(normalize(byAgentName.body)).toEqual(golden.issuesByAgentName);
    } finally {
      restoreIds();
    }
  }, 20000);

  it("keeps pending-tasks' ranking identical to the per-Session pendingTasks() order", async () => {
    const harness = await createHarness();
    const { fixture } = harness;
    const body = await getJson(harness, "/api/turns?status=pending");
    const tasks = body.body as { turns: Array<{ current_attempt_id: string; status: string; session_id: string }> };
    const bySession = new Map(tasks.turns.map((task) => [task.session_id, task]));
    const ranking = fixture.ranking;
    expect(ranking.runningBeatsQueuedWinnerTaskId).not.toBeNull();
    expect(ranking.prioritizedWinnerTaskId).not.toBeNull();

    // Ranking case 1: an older, in-flight task outranks three queued siblings
    // that were created after it.
    expect(bySession.get(ranking.runningBeatsQueuedSessionId!)).toMatchObject({
      current_attempt_id: ranking.runningBeatsQueuedWinnerTaskId!,
      status: "running",
    });
    // Ranking case 2: `priority` decides between two queued turns, not creation order.
    expect(bySession.get(ranking.prioritizedSessionId!)).toMatchObject({
      current_attempt_id: ranking.prioritizedWinnerTaskId!,
      status: "pending",
    });
    // Each Session contributes at most one task, and only the reader's Sessions do.
    expect(new Set(tasks.turns.map((task) => task.session_id)).size).toBe(tasks.turns.length);
    expect(tasks.turns.every((task) => fixture.sessionIds.includes(task.session_id))).toBe(true);
  }, 20000);
});

describe("MUL-473 first-screen hotspot query counts", () => {
  // CI runner jitter affects fixture setup; the contract is the statement count, not wall-clock time.
  it("keeps pending-tasks' statement count constant from 1 to 200 Chats", async () => {
    const measurements: Array<{ sessions: number; statements: number; bytes: number; tasks: number }> = [];
    for (const sessions of [1, 50, 200]) {
      const harness = await createHarness({ sessions, inboxRows: 0, issues: 0, privatePrimaryAgent: false });
      const body = await getJson(harness, "/api/turns?status=pending");
      const tasks = (body.body as { turns: unknown[] }).turns;
      // One task per Chat: the fixture gives every Session exactly one pending turn.
      expect(tasks.length).toBe(sessions);
      measurements.push({ sessions, statements: body.statements, bytes: body.bytes, tasks: tasks.length });
    }
    // 1 token read + 1 `last_used_at` write + 1 membership read + the ranked
    // CTE + 1 Agent batch + 1 task hydration: a constant that never sees N. The
    // implementation this replaces issued 4 statements per Chat (411 at N=50).
    for (const point of measurements) expect(point.statements).toBeLessThanOrEqual(8);
    expect(measurements[0]!.statements).toBe(measurements[2]!.statements);
    // What does grow is the reply itself — one task row per pending Chat — so the
    // bridged bytes must grow *linearly* with the returned tasks. The walk this
    // replaces paid the Session row, the task lookup and the Agent row for every
    // Chat whether or not it won, which is where the quadratic term came from.
    const [one, fifty, twoHundred] = measurements as [
      (typeof measurements)[number], (typeof measurements)[number], (typeof measurements)[number],
    ];
    expect(twoHundred.bytes).toBeLessThan(fifty.bytes * 4.2);
    // And the fixed prefix (token, membership, the CTE's own columns) amortizes,
    // so bytes-per-returned-task can only fall as N grows.
    const perTask = measurements.map((point) => point.bytes / point.tasks);
    expect(perTask[0]!).toBeGreaterThan(perTask[1]!);
    expect(perTask[1]!).toBeGreaterThanOrEqual(perTask[2]!);
    expect(twoHundred.bytes).toBeGreaterThan(one.bytes);
  }, 40000);

  it("reads no Chat message column for pending-tasks", async () => {
    const harness = await createHarness();
    await getJson(harness, "/api/turns?status=pending");
    const sql = [...harness.probe.bySql.keys()];
    const messageReads = sql.filter((statement) => /multiremi_chat_messages/i.test(statement));
    expect(messageReads).toEqual([]);
  }, 20000);

  it("loads no Skill body on the pending-tasks path", async () => {
    const harness = await createHarness({ skillBodyBytes: 64_000 });
    const baseline = await getJson(harness, "/api/turns?status=pending");
    // Each fixture Agent carries a 64 KB Skill file. A hydrated Agent load would
    // pull all 20 across the bridge; the lite projection keeps it to the row.
    expect(baseline.bytes).toBeLessThan(40_000);
    const skillSql = [...harness.probe.bySql.keys()].filter((statement) =>
      /multiremi_skill_files/i.test(statement));
    expect(skillSql).toEqual([]);
  }, 20000);

  it("keeps my-issues' statement count flat for id-shaped assignee filters", async () => {
    const byUserId: number[] = [];
    const byAgentId: number[] = [];
    const byMemberRowId: number[] = [];
    for (const issues of [1, 60, 300]) {
      const harness = await createHarness({ issues, sessions: 1, inboxRows: 0 });
      byUserId.push((await getJson(harness, `/api/issues?assignee_id=${harness.fixture.readerUserId}&limit=50`)).statements);
      byAgentId.push((await getJson(
        harness,
        `/api/issues?assignee_id=${harness.fixture.agentIds[1]}&limit=50`,
      )).statements);
      byMemberRowId.push((await getJson(
        harness,
        `/api/issues?assignee_id=${harness.fixture.readerMemberId}&limit=50`,
      )).statements);
    }
    // Budgets from the S9-2 plan (dbq ≤ 8 for my-issues).
    //
    // `agt_` and `mem_` name one kind outright, so they read one candidate list.
    // A `usr_` user id may not be prefix-locked without breaking QA's
    // counterexample, so it reads one list per kind (Agent, Member, Squad) —
    // 2 more statements, which is what the plan's ≤8 budget did not have room
    // for. The measured value is 9 and is pinned here rather than rounded away;
    // see the delivery comment for the per-statement breakdown. Concretely:
    // auth 3 + three candidate lists + page + labels + count = 9.
    for (const count of [...byAgentId, ...byMemberRowId]) expect(count).toBeLessThanOrEqual(7);
    for (const count of byUserId) expect(count).toBeLessThanOrEqual(9);
    // Row counts must not move the statement count: compare the two sizes whose
    // filter actually matches rows. (A 1-Issue workspace legitimately skips the
    // label hydrate, which is one statement fewer, not one statement more.)
    expect(byUserId[1]).toBe(byUserId[2]);
    expect(byAgentId[1]).toBe(byAgentId[2]);
    expect(byMemberRowId[1]).toBe(byMemberRowId[2]);
    // The bug this replaces: 72 statements on the 20-Agent fixture, 78 on the
    // QA workspace, because a `usr_` ref was probed against every Agent *with*
    // its Skill bodies. 9 is the cost of the exact historical search order.
    expect(Math.max(...byUserId)).toBeLessThanOrEqual(9);
  }, 30000);

  it("keeps the untyped fallback affordable for the shapes that reach it", async () => {
    // The three refs that cannot be prefix-locked, so all three kinds are read:
    // a user id, an Agent *named* like a user id, and a name that matches an
    // Agent. Each is constant in the Issue count (measured 1 / 60 / 300).
    for (const issues of [1, 60, 300]) {
      const harness = await createHarness({ issues, sessions: 1, inboxRows: 0 });
      const fixture = harness.fixture;
      const lookalike = harness.store.createAgent({
        id: "agt_lookalike_name", name: "usr_lookalike_agent_name", provider: "codex",
        workspaceId: fixture.workspaceId, ownerId: fixture.ownerUserId, visibility: "workspace",
      });
      // Keep exactly N issues and ensure every hit has a nonempty page, even at N=1.
      for (const [ref, budget, type, assigneeId] of [
        [fixture.readerUserId, 9, "member", fixture.readerMemberId],
        ["usr_lookalike_agent_name", 9, "agent", lookalike.id],
        ["Hotspot agent 7", 9, "agent", fixture.agentIds[7]!],
        ["usr_does_not_exist_at_all", 8, "agent", fixture.agentIds[7]!],
      ] as const) {
        harness.db.run("UPDATE multiremi_issues SET assignee_type = ?, assignee_id = ? WHERE id = ?",
          [type, assigneeId, fixture.issueIds[0]!]);
        const measured = await getJson(harness, `/api/issues?assignee_id=${encodeURIComponent(ref)}&limit=50`);
        expect(measured.statements).toBeLessThanOrEqual(budget);
        expect((measured.body as { total: number }).total > 0).toBe(budget === 9);
      }
    }
  }, 30000);

  it("does not hydrate Skills while resolving an assignee filter", async () => {
    const harness = await createHarness({ issues: 60, sessions: 1, inboxRows: 0, skillBodyBytes: 64_000 });
    await getJson(harness, `/api/issues?assignee_id=${harness.fixture.readerUserId}&limit=50`);
    expect([...harness.probe.bySql.keys()].filter((statement) =>
      /multiremi_skill_files/i.test(statement))).toEqual([]);
    expect([...harness.probe.bySql.keys()].filter((statement) =>
      /multiremi_skills/i.test(statement))).toEqual([]);
  }, 20000);

  it("still resolves name-shaped and ambiguous refs through the alias tiers", async () => {
    const harness = await createHarness({ issues: 60, sessions: 1, inboxRows: 0 });
    // A name only the Agent tier can answer.
    const byName = await getJson(harness, `/api/issues?assignee_id=${encodeURIComponent("Hotspot agent 5")}&limit=50`);
    expect((byName.body as { total: number }).total).toBeGreaterThan(0);
    // A name only the member tier can answer. The fixture already assigns some
    // Issues to the reader's member row; renaming the row makes the alias tiers
    // the only way to reach it.
    harness.db.run("UPDATE multiremi_workspace_members SET name = ? WHERE id = ?", [
      "Renamed hotspot reader",
      harness.fixture.readerMemberId,
    ]);
    const byMemberName = await getJson(
      harness,
      `/api/issues?assignee_id=${encodeURIComponent("Renamed hotspot reader")}&limit=50`,
    );
    expect((byMemberName.body as { total: number }).total).toBeGreaterThan(0);
    // An unknown ref still falls back to the literal value, as before.
    const unknown = await getJson(harness, "/api/issues?assignee_id=mem_missing_person&limit=50");
    expect((unknown.body as { total: number }).total).toBe(0);
  }, 20000);

  it("keeps the private-Agent rule: only its owner and workspace admins see its tasks", async () => {
    const harness = await createHarness({ sessions: 6, inboxRows: 0, issues: 0 });
    const { fixture } = harness;
    const privateAgent = harness.store.getAgentLite(fixture.primaryAgentId)!;
    expect(privateAgent.visibility).toBe("private");
    expect(privateAgent.ownerId).toBe(fixture.ownerUserId);

    // Two Chats on the owner's private Agent: one the reader created, one the
    // owner created. Creator scoping alone would let the first through, so the
    // Agent rule is exactly what the reader view is asserting.
    const readerSession = harness.store.createChatSession({
      id: "chat_hotspot_private_reader",
      agentId: fixture.primaryAgentId,
      creatorId: fixture.readerUserId,
      title: "Private agent chat, reader",
    });
    harness.store.sendChatMessage(readerSession.id, { body: "private agent turn" });
    const ownerSession = harness.store.createChatSession({
      id: "chat_hotspot_private_owner",
      agentId: fixture.primaryAgentId,
      creatorId: fixture.ownerUserId,
      title: "Private agent chat, owner",
    });
    harness.store.sendChatMessage(ownerSession.id, { body: "private agent turn" });

    const readerView = await getJson(harness, "/api/turns?status=pending");
    const readerSessions = (readerView.body as { turns: Array<{ session_id: string }> }).turns
      .map((task) => task.session_id);
    expect(readerSessions).not.toContain(readerSession.id);
    expect(readerSessions).not.toContain(ownerSession.id);

    // The owner owns the Agent, so their own Chat shows up.
    const ownerCredential = await harness.store.createAccessToken({
      name: "MUL-473 owner",
      type: "pat",
      userId: fixture.ownerUserId,
      workspaceId: fixture.workspaceId,
      purpose: "session",
    });
    const ownerView = await getJsonWithHeaders(harness, "/api/turns?status=pending", {
      Authorization: `Bearer ${ownerCredential.token}`,
      "X-Workspace-ID": fixture.workspaceId,
    });
    expect((ownerView.body as { turns: Array<{ session_id: string }> }).turns
      .map((task) => task.session_id)).toContain(ownerSession.id);
  }, 20000);
});

async function getJsonWithHeaders(
  harness: Harness,
  path: string,
  headers: Record<string, string>,
): Promise<{ body: unknown; statements: number }> {
  const response = await harness.app.request(path, { headers });
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return { body: JSON.parse(text) as unknown, statements: harness.probe.statements };
}
