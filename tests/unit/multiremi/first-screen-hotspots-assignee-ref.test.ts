// MUL-473 (S9-2, PR1, QA rework): equivalence guards for `resolveAssigneeRef`.
//
// PR1 first added `usr_ -> member` to `inferAssigneeTypeFromRef`, which *locked*
// the untyped search to the member table. A legal Agent named `usr_alias` — QA's
// counterexample — had resolved as that Agent before, and started throwing
// `Member not found`. This file pins the behaviour to the pre-PR implementation
// instead of to a restatement of the new rules.
//
// Read the search order for what it is: Agent, Member, Squad is only the order in
// which the three kinds are *queried*. Every kind that matches contributes a
// candidate, and ambiguity is decided once, over the collected set — a reference
// that matches two kinds is refused, it is not awarded to whichever kind was
// queried first. In particular, a member `user_id` that is also an Agent name is
// `Ambiguous assignee reference`, not "the Agent wins".
//
//   1. `tests/fixtures/multiremi/capture-assignee-ref-golden.ts` was run on the
//      pre-PR implementation `593ff2ba` (the parent of this branch), with this
//      branch's copy of that script and `assignee-ref-fixture.ts` placed in that
//      checkout, and its output is checked in as `assignee-ref-golden.json`. In
//      a `593ff2ba` worktree that already has those two files:
//
//        bun run tests/fixtures/multiremi/capture-assignee-ref-golden.ts \
//          --baseline --out tests/fixtures/multiremi/assignee-ref-golden.json
//
//      That command reproduces the checked-in file byte for byte — `--baseline`
//      writes the `pre-MUL-473 implementation (593ff2ba)` source label the file
//      carries, so no post-processing is needed. Expected values below are read
//      from it, never hand-written.
//   2. The store-level answer (`{assigneeType, assigneeId}` or the exact error
//      message) and the HTTP-level answer (`GET /api/issues?assignee_id=…`'s
//      status, `total` and id list) are both compared, because the route's total
//      is what a regression here actually breaks.
//   3. The fixture pins id generation, because two of the collisions are with
//      generated member `user_id`s.
import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMultiremiApp } from "@multiremi/api.js";
import type { SqlDatabase, SqlStatement } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store.js";
import {
  assigneeRefCases,
  installAssigneeRefIds,
  seedAssigneeRefFixture,
  type AssigneeRefFixture,
} from "../../fixtures/multiremi/assignee-ref-fixture.js";
import golden from "../../fixtures/multiremi/assignee-ref-golden.json";

let databases: Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases = [];
});

const AUTH_TOKEN = "mul473-assignee-ref-token";

interface GoldenCase {
  label: string;
  ref: string;
  store: { assigneeType?: string; assigneeId?: string; error?: string };
  http: { status: number; total: number | null; issueIds: string[] | null };
}

const goldens = golden.cases as GoldenCase[];

interface Harness {
  store: MultiremiStore;
  fixture: AssigneeRefFixture;
  app: ReturnType<typeof createMultiremiApp>;
  headers: Record<string, string>;
  /** Statements executed by the most recent HTTP request. */
  statements: number;
  lastStatements: number;
}

/** Wrap the driver so the HTTP assertions can also report the query count. */
function countingDatabase(raw: Database, counter: { statements: number }): SqlDatabase {
  const record = (): void => {
    counter.statements += 1;
  };
  const wrap = (statement: SqlStatement, sql: string): SqlStatement => new Proxy(statement, {
    get(target, property) {
      const value = target[property as keyof SqlStatement];
      if (["get", "all", "run", "values"].includes(String(property))) {
        return (...params: unknown[]) => {
          record();
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
      record();
      return raw.run(sql, ...(params as never[]));
    },
    exec: (sql) => {
      record();
      raw.exec(sql);
    },
    transaction: (fn) => raw.transaction(fn),
    close: () => raw.close(),
  };
}

async function createHarness(): Promise<Harness> {
  const raw = new Database(":memory:");
  databases.push(raw);
  const counter = { statements: 0 };
  const store = new MultiremiStore(countingDatabase(raw, counter));
  const restoreIds = installAssigneeRefIds();
  let fixture: AssigneeRefFixture;
  try {
    fixture = seedAssigneeRefFixture(store);
  } finally {
    restoreIds();
  }
  const app = createMultiremiApp({ store, authToken: AUTH_TOKEN });
  const credential = await store.createAccessToken({
    name: "MUL-473 assignee ref test",
    type: "pat",
    userId: fixture.readerUserId,
    workspaceId: fixture.workspaceId,
    purpose: "session",
  });
  return {
    store,
    fixture,
    app,
    headers: {
      Authorization: `Bearer ${credential.token}`,
      "X-Workspace-ID": fixture.workspaceId,
    },
    statements: 0,
    lastStatements: 0,
  };
}

describe("MUL-473 assignee reference equivalence (golden from 593ff2ba)", () => {
  it("covers every shape QA listed, including the collisions", () => {
    // Fail loudly if the case table and the golden ever drift apart, so a new
    // case cannot be added without re-capturing the expected value from the old
    // implementation.
    const labels = goldens.map((entry) => entry.label);
    for (const required of [
      // QA's list of shapes.
      "agent row id",
      "member row id",
      "squad row id",
      "reader user id (also an agent name)",
      "other member user id",
      "agent name",
      "member name",
      "member email",
      "squad name",
      "usr_-shaped agent name",
      "usr_-shaped squad name",
      "usr_-shaped value that exists nowhere",
      "mem_-shaped agent name",
      "sqd_-shaped agent name",
      "mem_-shaped value that exists nowhere",
      "agt_-shaped value that exists nowhere",
      "sqd_-shaped value that exists nowhere",
      // Collisions.
      "collision: member user id + agent name + squad name",
      "collision: member user id + agent name",
      "collision: two agents share an alias",
      "member user id with no collision",
      "collision: two members share a user id, one named like it",
      // Archived rows and the derived case/prefix/punctuation variants.
      "archived agent row id",
      "archived member row id",
      "archived squad row id",
      "derived: usr_-shaped agent name, upper case",
      "derived: agent name, one char dropped",
      "usr_ prefix only",
    ]) {
      expect(labels).toContain(required);
    }
    // The derived block expands each seed seven ways, so the table must be
    // materially larger than the hand-written list.
    expect(goldens.length).toBeGreaterThan(100);
  });

  it("matches the pre-PR store-level result for every case", async () => {
    const harness = await createHarness();
    const cases = assigneeRefCases(harness.fixture);
    expect(cases.map((entry) => entry.label)).toEqual(goldens.map((entry) => entry.label));

    for (const [index, testCase] of cases.entries()) {
      const expected = goldens[index]!;
      expect(testCase.ref).toBe(expected.ref);
      let actual: GoldenCase["store"];
      try {
        const resolved = harness.store.resolveAssigneeRef(null, testCase.ref, harness.fixture.workspaceId);
        actual = resolved
          ? { assigneeType: resolved.assigneeType, assigneeId: resolved.assigneeId }
          : { error: "<null>" };
      } catch (error) {
        actual = { error: error instanceof Error ? error.message : String(error) };
      }
      expect({ label: testCase.label, ...actual }).toEqual({ label: testCase.label, ...expected.store });
    }
  });

  it("matches the pre-PR HTTP total and id list for every case", async () => {
    const harness = await createHarness();
    const cases = assigneeRefCases(harness.fixture);
    for (const [index, testCase] of cases.entries()) {
      const expected = goldens[index]!;
      const response = await harness.app.request(
        `/api/issues?assignee_id=${encodeURIComponent(testCase.ref)}&limit=50`,
        { headers: harness.headers },
      );
      expect(response.status).toBe(expected.http.status);
      // The golden records `null` for a non-200 body; narrowing here keeps the
      // comparison typed without an unchecked cast.
      const expectedTotal = expected.http.total;
      const expectedIds = expected.http.issueIds;
      expect(expectedTotal).not.toBeNull();
      expect(expectedIds).not.toBeNull();
      if (expectedTotal === null || expectedIds === null) throw new Error("golden case has no HTTP body");
      const body = await response.json() as { total: number; issues: Array<{ id: string }> };
      expect({ total: body.total, issueIds: body.issues.map((issue) => issue.id) })
        .toEqual({ total: expectedTotal, issueIds: expectedIds });
    }
  });

  it("keeps the QA counterexample: a usr_-shaped Agent name resolves as that Agent", async () => {
    const harness = await createHarness();
    const { fixture } = harness;
    expect(fixture.agents.usrShapedName.startsWith("usr_")).toBe(true);
    expect(harness.store.resolveAssigneeRef(null, fixture.agents.usrShapedName, fixture.workspaceId)).toEqual({
      assigneeType: "agent",
      assigneeId: fixture.agents.usrShapedNameAgentId,
    });
    // And the route the regression was observed on returns the Issue again.
    const response = await harness.app.request(
      `/api/issues?assignee_id=${encodeURIComponent(fixture.agents.usrShapedName)}&limit=50`,
      { headers: harness.headers },
    );
    const body = await response.json() as { total: number; issues: Array<{ id: string }> };
    expect(body.total).toBe(1);
    expect(body.issues.map((issue) => issue.id)).toEqual(["iss_assignee_usr_shaped_agent"]);
  });

  it("keeps a usr_-shaped value that names nobody as a plain miss", async () => {
    const harness = await createHarness();
    // The whole point: `usr_` must not lock the search to members, so an
    // unmatched one is "not found" rather than "Member not found".
    expect(() => harness.store.resolveAssigneeRef(null, "usr_assignee_nowhere", harness.fixture.workspaceId))
      .toThrow("Assignee not found: usr_assignee_nowhere");
    // Contrast: a `mem_`-shaped miss still reports the kind it was locked to.
    expect(() => harness.store.resolveAssigneeRef(null, "mem_assignee_nowhere", harness.fixture.workspaceId))
      .toThrow("Member not found: mem_assignee_nowhere");
  });

  it("keeps a member user id with no collision resolving to that member", async () => {
    const harness = await createHarness();
    const { fixture } = harness;
    expect(harness.store.resolveAssigneeRef(null, fixture.members.cleanMemberUserId, fixture.workspaceId)).toEqual({
      assigneeType: "member",
      assigneeId: fixture.members.cleanMemberId,
    });
  });

  it("still refuses a doubled member user id instead of falling through to the name alias", async () => {
    const harness = await createHarness();
    const { fixture } = harness;
    const { duplicateUserId } = fixture.members;
    // The member tier refuses the kind outright when two rows carry the same
    // `user_id`. It must NOT continue to the alias tiers, where the first row
    // would match by name and answer `member:…dupe_shared_a` instead.
    expect(() => harness.store.resolveAssigneeRef(null, duplicateUserId, fixture.workspaceId))
      .toThrow(`Assignee not found: ${duplicateUserId}`);
    // The route is where the difference is visible: a wrong answer turns this
    // filter from an empty page into one issue.
    const response = await harness.app.request(
      `/api/issues?assignee_id=${encodeURIComponent(duplicateUserId)}&limit=50`,
      { headers: harness.headers },
    );
    expect(response.status).toBe(200);
    const body = await response.json() as { total: number; issues: Array<{ id: string }> };
    expect(body.total).toBe(0);
    expect(body.issues.map((issue) => issue.id)).toEqual([]);
  });

  it("still refuses an ambiguous member/agent collision the way the old code did", async () => {
    const harness = await createHarness();
    const { fixture } = harness;
    // Agent, member and squad all match this string, so no branch may silently
    // win: the old implementation refused it and so must this one.
    expect(() => harness.store.resolveAssigneeRef(null, fixture.members.readerUserId, fixture.workspaceId))
      .toThrow(`Ambiguous assignee reference: ${fixture.members.readerUserId}`);
  });
});
