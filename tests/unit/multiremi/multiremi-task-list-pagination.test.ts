import { turnApiPath, mutateExecutionFixture } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

/**
 * MUL-357: `GET /api/multiremi/tasks` paginates with `limit` / `offset`.
 *
 * The page is a window over the caller's AUTHORIZED result set, so every change
 * here risks turning a performance fix into a visibility change. These tests pin
 * the cross product: pagination never widens what a caller can see, and it never
 * lets an invisible task consume page budget.
 */
afterEach(resetMultiremiTestEnv);

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

/**
 * `taskCount` tasks on the local workspace, every Nth on another workspace.
 * The other workspace's tasks are invisible to `usr_reader`, who is a plain
 * member of `local` only.
 */
async function fixture(taskCount = 10, foreignEvery = 5) {
  const store = createStore();
  store.ensureLocalWorkspace();
  store.createWorkspace({ id: "ws_other", name: "Other", slug: "other", issuePrefix: "OTH" });
  const agent = store.createAgent({ name: "Paged agent", provider: "codex", workspaceId: "local", visibility: "workspace" });
  const otherAgent = store.createAgent({ name: "Other agent", provider: "codex", workspaceId: "ws_other", visibility: "workspace" });
  store.createWorkspaceMember({ workspaceId: "local", userId: "usr_reader", name: "Reader", role: "member" });
  const reader = await store.createAccessToken({
    name: "Reader",
    type: "pat",
    userId: "usr_reader",
    workspaceId: "local",
  });
  const app = createMultiremiApp({ store, authToken: "root-secret" });

  const entries: Array<{ id: string; foreign: boolean }> = [];
  for (let index = 0; index < taskCount; index += 1) {
    const foreign = index % foreignEvery === 0;
    const task = store.createTask({
      agentId: foreign ? otherAgent.id : agent.id,
      prompt: `Task ${index}`,
      workspaceId: foreign ? "ws_other" : "local",
    });
    entries.push({ id: task.id, foreign });
  }
  return {
    store,
    app,
    agent,
    otherAgent,
    entries,
    visible: entries.filter((entry) => !entry.foreign).map((entry) => entry.id),
    hidden: entries.filter((entry) => entry.foreign).map((entry) => entry.id),
    reader: headers(reader.token),
    root: headers("root-secret"),
  };
}

async function page(
  app: ReturnType<typeof createMultiremiApp>,
  query: string,
  token: Record<string, string>,
) {
  const response = await app.request(`/api/turns${query}`, { headers: token });
  expect(response.status, query).toBe(200);
  return await response.json() as {
    turns: Array<Record<string, unknown> & { id: string }>;
    next_cursor: string | null;
    limit: number;
    offset: number;
  };
}

describe("Task list pagination", () => {
  it("limits the authorized set rather than the scanned rows", async () => {
    const { app, visible, hidden, reader } = await fixture(10, 5);
    expect(visible).toHaveLength(8);
    expect(hidden).toHaveLength(2);

    const first = await page(app, "?limit=5", reader);
    expect(first.turns).toHaveLength(5);
    for (const task of first.turns) {
      expect(visible).toContain(task.id);
      expect(hidden).not.toContain(task.id);
    }
    expect((first.next_cursor !== null)).toBe(true);
    expect(first.next_cursor).toBeString();

    const second = await page(app, `?limit=5&cursor=${encodeURIComponent(first.next_cursor!)}`, reader);
    expect(second.turns).toHaveLength(3);
    expect((second.next_cursor !== null)).toBe(false);
    expect(second.next_cursor).toBeNull();
    for (const task of second.turns) expect(hidden).not.toContain(task.id);

    const returned = [...first.turns, ...second.turns].map((task) => task.id);
    expect(new Set(returned).size).toBe(returned.length);
    expect([...returned].sort()).toEqual([...visible].sort());
  });

  it("pages without skipping or repeating when every task shares one timestamp", async () => {
    // The cursor is the full `(created_at, id)` sort key; a created_at-only
    // cursor would drop or duplicate rows in this fixture.
    // The root token is the no-identity admin path, so every task is visible here.
    const { store, app, entries, root } = await fixture(10, 100);
    const all = entries.map((entry) => entry.id);
    mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET created_at = '2026-09-21T00:00:00.000Z'");
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let request = 0; request < 6; request += 1) {
      const body = await page(app, `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, root);
      collected.push(...body.turns.map((task) => task.id));
      if (!(body.next_cursor !== null)) break;
      cursor = body.next_cursor;
    }
    expect(collected).toHaveLength(10);
    expect(new Set(collected).size).toBe(10);
    expect([...collected].sort()).toEqual([...all].sort());
  });

  it("caps limit and falls back to the default for absent or invalid values", async () => {
    const { app, root } = await fixture(12, 100);
    expect((await page(app, "?limit=9999", root)).limit).toBe(500);
    expect((await page(app, "", root)).limit).toBe(100);
    for (const query of ["?limit=0", "?limit=-3", "?limit=abc", "?limit="]) {
      expect((await page(app, query, root)).limit, query).toBe(100);
    }
    // A fractional limit is floored by the shared optional-int parser.
    expect((await page(app, "?limit=2.9", root)).turns).toHaveLength(2);
  });

  it("returns an empty page and no next offset past the end of the authorized set", async () => {
    const { app, reader, visible } = await fixture(10, 5);
    const body = await page(app, "?limit=5&offset=100", reader);
    expect(body.turns).toEqual([]);
    expect((body.next_cursor !== null)).toBe(false);
    expect(body.next_cursor).toBeNull();
    expect(visible.length).toBeGreaterThan(0);
  });

  it("keeps an all-invisible result set empty instead of padding from elsewhere", async () => {
    // Every task belongs to another workspace, so the reader's authorized set is
    // empty however far the route scans.
    const { app, reader, hidden } = await fixture(20, 1);
    expect(hidden).toHaveLength(20);
    const body = await page(app, "?limit=5", reader);
    expect(body.turns).toEqual([]);
    expect((body.next_cursor !== null)).toBe(false);
    expect(body.next_cursor).toBeNull();
  });

  it("returns exactly the rule-allowed tasks when paging through the whole list", async () => {
    // Mixed fixture covering several visibility rules at once, then paged with
    // limit=2. Paging must produce the same set the rules allow -- not one task
    // more (a leak) and not one fewer (an invisible task eating page budget).
    //
    // The expected per-identity sets below were dumped from this same fixture on
    // the parent commit (tests/manual/vis-equivalence-evidence.ts) and are
    // byte-identical with the pagination change: the page moves, the rule does
    // not. Ordinary tasks stay workspace-visible on this route; Chat tasks stay
    // creator-only.
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspace({ id: "ws_other", name: "Other", slug: "other", issuePrefix: "OTH" });
    const shared = store.createAgent({ name: "Shared", provider: "codex", workspaceId: "local", visibility: "workspace" });
    const mine = store.createAgent({ name: "Mine", provider: "codex", workspaceId: "local", visibility: "private", ownerId: "usr_alice" });
    const theirs = store.createAgent({ name: "Theirs", provider: "codex", workspaceId: "local", visibility: "private", ownerId: "usr_bob" });
    const foreign = store.createAgent({ name: "Foreign", provider: "codex", workspaceId: "ws_other", visibility: "workspace" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "usr_alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "usr_bob", name: "Bob", role: "admin" });
    const alice = await store.createAccessToken({ name: "Alice", type: "pat", userId: "usr_alice", workspaceId: "local" });
    const bob = await store.createAccessToken({ name: "Bob", type: "pat", userId: "usr_bob", workspaceId: "local" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    const sharedOrdinary = store.createTask({ agentId: shared.id, prompt: "shared work" }).id;
    const alicePrivateOrdinary = store.createTask({ agentId: mine.id, prompt: "alice private agent" }).id;
    const bobPrivateOrdinary = store.createTask({ agentId: theirs.id, prompt: "bob private agent" }).id;
    const foreignOrdinary = store.createTask({ agentId: foreign.id, prompt: "foreign", workspaceId: "ws_other" }).id;

    const chat = (agentId: string, creatorId: string, content: string) => {
      const session = store.createChatSession({ agentId, creatorId, workspaceId: store.getAgent(agentId)!.workspaceId });
      return store.sendChatMessage(session.id, { content }).task.id;
    };
    const sharedAliceChat = chat(shared.id, "usr_alice", "alice on shared agent");
    const sharedBobChat = chat(shared.id, "usr_bob", "bob on shared agent");
    const alicePrivateBobChat = chat(mine.id, "usr_bob", "bob on alice's private agent");

    const expectedForAlice = new Set([sharedOrdinary, alicePrivateOrdinary, bobPrivateOrdinary, sharedAliceChat]);
    const expectedForBob = new Set([
      sharedOrdinary,
      alicePrivateOrdinary,
      bobPrivateOrdinary,
      sharedBobChat,
      alicePrivateBobChat,
    ]);
    expect(expectedForAlice.has(foreignOrdinary)).toBe(false);
    expect(expectedForBob.has(sharedAliceChat)).toBe(false);

    for (const [identity, token, expected] of [
      ["alice", alice.token, expectedForAlice],
      ["bob", bob.token, expectedForBob],
    ] as const) {
      const collected: string[] = [];
      let cursor: string | null = null;
      let rounds = 0;
      for (;;) {
        const response = await app.request("/api/turns"+`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
          headers: headers(token),
        });
        expect(response.status, identity).toBe(200);
        const body = await response.json() as {
          turns: Array<{ id: string }>;
          next_cursor: string | null;
              };
        collected.push(...body.turns.map((task) => task.id));
        rounds += 1;
        if (!(body.next_cursor !== null)) break;
        expect(body.next_cursor).toBeString();
        cursor = body.next_cursor;
        expect(rounds, identity).toBeLessThan(20);
      }
      expect(rounds, identity).toBeGreaterThan(1);
      expect(new Set(collected), identity).toEqual(expected);
      expect(collected.length, identity).toBe(expected.size);
    }
  });

  it("does not leak or drop a task when an invisible one sits on a chunk boundary", async () => {
    // MUL-357's scan reads 200-row chunks. Placing the invisible tasks exactly at
    // the boundary (and straddling it) is the case where an off-by-one in the
    // chunk walk would either leak a foreign task into the page or drop a
    // visible task that follows it.
    const store = createStore();
    store.ensureLocalWorkspace();
    store.createWorkspace({ id: "ws_other", name: "Other", slug: "other", issuePrefix: "OTH" });
    const agent = store.createAgent({ name: "Local", provider: "codex", workspaceId: "local", visibility: "workspace" });
    const foreign = store.createAgent({ name: "Foreign", provider: "codex", workspaceId: "ws_other", visibility: "workspace" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "usr_reader", name: "Reader", role: "member" });
    const reader = await store.createAccessToken({
      name: "Reader", type: "pat", userId: "usr_reader", workspaceId: "local",
    });
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    // 1-indexed scan positions; the chunk size is 200 and this fixture needs
    // more than one chunk, so `limit` is raised below to the server maximum.
    // The rows straddling each seam (200/201 and 400/401) are deliberately
    // VISIBLE, with an invisible row adjacent on each side: a walk that drops a
    // row at a seam -- whether the last row of the previous chunk or the first
    // row of the next -- then loses a task the page must contain, instead of
    // quietly skipping one that was invisible anyway.
    const boundaryPositions = new Set([199, 202, 399, 402]);
    const expected: string[] = [];
    const hidden: string[] = [];
    for (let position = 1; position <= 402; position += 1) {
      const invisible = boundaryPositions.has(position);
      const task = store.createTask({
        agentId: invisible ? foreign.id : agent.id,
        prompt: `position ${position}`,
        workspaceId: invisible ? "ws_other" : "local",
      });
      // Strictly decreasing created_at, so insertion index === scan position.
      mutateExecutionFixture(db!, "UPDATE multiremi_turn_execution_records SET created_at = ?, updated_at = ? WHERE id = ?", [
        new Date(Date.UTC(2026, 8, 21) - position * 60_000).toISOString(),
        new Date(Date.UTC(2026, 8, 21) - position * 60_000).toISOString(),
        task.id,
      ]);
      if (invisible) hidden.push(task.id);
      else expected.push(task.id);
    }

    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      // 500 is the server cap: the whole (398-row) visible set fits one page,
      // so the walk still has to cross all three chunks to fill it.
      const response = await app.request(`/api/turns?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, {
        headers: headers(reader.token),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        turns: Array<{ id: string }>;
        next_cursor: string | null;
          };
      collected.push(...body.turns.map((task) => task.id));
      if (!(body.next_cursor !== null)) break;
      expect(body.next_cursor).toBeString();
      cursor = body.next_cursor;
    }

    expect(new Set([...collected].filter((id) => hidden.includes(id)))).toEqual(new Set());
    expect([...collected].sort()).toEqual([...expected].sort());
    expect(collected.length).toBe(expected.length);
    // Pin the seams themselves: chunk 1 ends at 200, chunk 2 runs 201..400 and
    // chunk 3 starts at 401 -- all visible rows, with an invisible neighbour.
    expect(hidden.length).toBe(4);
    expect(expected).toHaveLength(398);
    // `expected` is the visible rows in scan order: the task at scan position P
    // sits at index P-1 minus however many invisible rows preceded it.
    expect(collected[0]).toBe(expected[0]);
    expect(collected).toContain(expected[198]); // scan 200: last of chunk 1
    expect(collected).toContain(expected[199]); // scan 201: first of chunk 2
    expect(collected).toContain(expected[396]); // scan 400: last of chunk 2
    expect(collected).toContain(expected[397]); // scan 401: first of chunk 3
  });

  it("keeps the page's ids and hydrated rows one-to-one and in order", async () => {
    // The two-phase fetch must not reorder, duplicate or drop rows: the page
    // order is `created_at DESC, id DESC` and hydration reads by id, which does
    // not preserve that order on its own.
    const { app, store, root } = await fixture(12, 100);
    const reference = store.listTasks().map((task) => task.id);
    const collected: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 8; page += 1) {
      const response = await app.request("/api/turns"+`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers: root });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        turns: Array<{ id: string; createdAt: string }>;
        next_cursor: string | null;
          };
      collected.push(...body.turns.map((task) => task.id));
      // Within one page the rows come back in the same order the scan produced.
      const createdAts = body.turns.map((task) => task.createdAt);
      expect([...createdAts].sort().reverse()).toEqual(createdAts);
      if (!(body.next_cursor !== null)) break;
      cursor = body.next_cursor;
    }
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).toEqual(reference);
  });

  it("omits heavy fields from list entries while the detail route keeps them", async () => {
    const { store, app, entries, root } = await fixture(3, 100);
    const list = await page(app, "?limit=3", root);
    expect(list.turns[0]).toBeDefined();
    const entryKeys = Object.keys(list.turns[0]!);
    for (const field of [
      "result",
      "prompt",
      "pluginSnapshot",
      "plugin_snapshot",
      "executionFingerprint",
      "execution_fingerprint",
      "usage",
    ]) {
      expect(entryKeys, field).not.toContain(field);
    }
    // Identity and status fields the CLI table renders must survive the trim.
    for (const field of ["id", "agentId", "status", "workspaceId", "createdAt", "waitReason"]) {
      expect(entryKeys, field).toContain(field);
    }

    const detailResponse = await app.request(turnApiPath(store, entries[0]!.id), { headers: root });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as { task: Record<string, unknown> };
    for (const field of ["prompt", "result", "usage", "pluginSnapshot", "executionFingerprint"]) {
      expect(Object.keys(detail.task), field).toContain(field);
    }
  });
});
