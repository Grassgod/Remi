import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

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
  const response = await app.request(`/api/multiremi/tasks${query}`, { headers: token });
  expect(response.status, query).toBe(200);
  return await response.json() as {
    tasks: Array<Record<string, unknown> & { id: string }>;
    has_more: boolean;
    next_offset: number | null;
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
    expect(first.tasks).toHaveLength(5);
    for (const task of first.tasks) {
      expect(visible).toContain(task.id);
      expect(hidden).not.toContain(task.id);
    }
    expect(first.has_more).toBe(true);
    expect(first.next_offset).toBe(5);

    const second = await page(app, "?limit=5&offset=5", reader);
    expect(second.tasks).toHaveLength(3);
    expect(second.has_more).toBe(false);
    expect(second.next_offset).toBeNull();
    for (const task of second.tasks) expect(hidden).not.toContain(task.id);

    const returned = [...first.tasks, ...second.tasks].map((task) => task.id);
    expect(new Set(returned).size).toBe(returned.length);
    expect([...returned].sort()).toEqual([...visible].sort());
  });

  it("pages without skipping or repeating when every task shares one timestamp", async () => {
    // The cursor is the full `(created_at, id)` sort key; a created_at-only
    // cursor would drop or duplicate rows in this fixture.
    // The root token is the no-identity admin path, so every task is visible here.
    const { app, entries, root } = await fixture(10, 100);
    const all = entries.map((entry) => entry.id);
    db!.run("UPDATE multiremi_tasks SET created_at = '2026-09-21T00:00:00.000Z'");
    const collected: string[] = [];
    let offset = 0;
    for (let request = 0; request < 6; request += 1) {
      const body = await page(app, `?limit=3&offset=${offset}`, root);
      collected.push(...body.tasks.map((task) => task.id));
      if (!body.has_more) break;
      offset = body.next_offset!;
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
    expect((await page(app, "?limit=2.9", root)).tasks).toHaveLength(2);
  });

  it("returns an empty page and no next offset past the end of the authorized set", async () => {
    const { app, reader, visible } = await fixture(10, 5);
    const body = await page(app, "?limit=5&offset=100", reader);
    expect(body.tasks).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_offset).toBeNull();
    expect(visible.length).toBeGreaterThan(0);
  });

  it("keeps an all-invisible result set empty instead of padding from elsewhere", async () => {
    // Every task belongs to another workspace, so the reader's authorized set is
    // empty however far the route scans.
    const { app, reader, hidden } = await fixture(20, 1);
    expect(hidden).toHaveLength(20);
    const body = await page(app, "?limit=5", reader);
    expect(body.tasks).toEqual([]);
    expect(body.has_more).toBe(false);
    expect(body.next_offset).toBeNull();
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
      let offset = 0;
      let rounds = 0;
      for (;;) {
        const response = await app.request(`/api/multiremi/tasks?limit=2&offset=${offset}`, {
          headers: headers(token),
        });
        expect(response.status, identity).toBe(200);
        const body = await response.json() as {
          tasks: Array<{ id: string }>;
          has_more: boolean;
          next_offset: number | null;
        };
        collected.push(...body.tasks.map((task) => task.id));
        rounds += 1;
        if (!body.has_more) break;
        expect(body.next_offset).toBe(offset + body.tasks.length);
        offset = body.next_offset!;
        expect(rounds, identity).toBeLessThan(20);
      }
      expect(rounds, identity).toBeGreaterThan(1);
      expect(new Set(collected), identity).toEqual(expected);
      expect(collected.length, identity).toBe(expected.size);
    }
  });

  it("omits heavy fields from list entries while the detail route keeps them", async () => {
    const { app, entries, root } = await fixture(3, 100);
    const list = await page(app, "?limit=3", root);
    const entryKeys = Object.keys(list.tasks[0]!);
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

    const detailResponse = await app.request(`/api/multiremi/tasks/${entries[0]!.id}`, { headers: root });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as { task: Record<string, unknown> };
    for (const field of ["prompt", "result", "usage", "pluginSnapshot", "executionFingerprint"]) {
      expect(Object.keys(detail.task), field).toContain(field);
    }
  });
});
