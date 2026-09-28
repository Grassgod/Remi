/**
 * The storage half over a real SQLite engine (`node:sqlite`).
 *
 * The Worker runs the same statements through `sqlite-wasm` over `opfs-sahpool`;
 * this suite exists so the schema, the coverage table and the patch-in-place
 * path are exercised by a fast test rather than only by a browser, and so a
 * statement that only works on one driver fails here.
 */
import { describe, expect, test } from "vitest";
import { ReplicaEngine } from "./engine";
import { SqlReplicaStorage } from "./sql-store";
import { nodeSqlDatabase } from "./sql-node";
import { MemoryReplicaStorage } from "./storage";
import { META_SCHEMA_VERSION, META_USER_ID, REPLICA_SCHEMA_VERSION, SQL } from "./schema";
import { rowHeightKey } from "./port";
import type { HubFrame } from "@multiremi/contracts/live-hub";

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => unknown;
}

async function openSqlStorage(): Promise<{ storage: SqlReplicaStorage; db: { exec(sql: string): unknown; close(): unknown; prepare(sql: string): { all(...p: unknown[]): unknown[] } } }> {
  const { DatabaseSync } = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const db = new DatabaseSync(":memory:") as {
    exec(sql: string): unknown;
    close(): unknown;
    prepare(sql: string): { all(...p: unknown[]): unknown[] };
  };
  const wrapped = nodeSqlDatabase(db as never);
  return { storage: new SqlReplicaStorage(wrapped), db };
}

function entry(seq: number, overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess_1",
    seq,
    id: `cmt_${seq}`,
    revision: 1,
    kind: "comment",
    body_md: `body ${seq}`,
    body_html: `<p>body ${seq}</p>`,
    render_version: "v1",
    ...overrides,
  };
}

function entryFrame(seq: number, overrides: Record<string, unknown> = {}): HubFrame {
  return {
    seq,
    kind: "entry",
    payload: { visibility: "shown", ...entry(seq), ...overrides },
  };
}

describe("SQL replica storage", () => {
  test("creates the five plan tables", async () => {
    const { storage, db } = await openSqlStorage();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining(["entries", "heads", "meta", "ranges", "row_heights"]));
    storage.close();
  });

  test("round-trips entries, coverage and the head through SQL", async () => {
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    engine.frames("sess_1", [entryFrame(1), entryFrame(2), entryFrame(3)]);

    // A second engine must see the same state: that is the hot start.
    const reopened = new ReplicaEngine(storage);
    const opened = reopened.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    expect(opened.fromSeq).toBe(4);
    expect(opened.cleared).toBeNull();
    expect(reopened.readWindow("sess_1", 0, 10).map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(storage.readState("sess_1")).toMatchObject({ head: 3, logVersion: null });
    engine.close();
  });

  test("a patch updates in place instead of inserting a second row", async () => {
    const { storage, db } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    engine.frames("sess_1", [entryFrame(1), entryFrame(2)]);
    engine.frames("sess_1", [{ seq: 2, kind: "patch", payload: { session_id: "sess_1", target_seq: 2, revision: 5, fields: { body_md: "edited", body_html: "<p>edited</p>" } } }]);

    const rows = engine.readWindow("sess_1", 0, 10);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ seq: 2, revision: 5, body_md: "edited", body_html: "<p>edited</p>" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM entries WHERE session_id = 'sess_1'").all() as { n: number }[];
    expect(count[0]!.n).toBe(2);
    engine.close();
  });

  test("a sparse deep-link window survives a reopen with its hole intact", async () => {
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    engine.writeWindow("sess_1", [entry(880), entry(881)], { from: 880, to: 881 });
    engine.frames("sess_1", [entryFrame(1000), entryFrame(1001)]);

    const reopened = new ReplicaEngine(storage);
    reopened.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    expect(reopened.readWindow("sess_1", 0, 2000).map((row) => row.seq)).toEqual([880, 881, 1000, 1001]);
    expect(storage.readState("sess_1").ranges).toEqual([
      { from: 880, to: 881 },
      { from: 1000, to: 1001 },
    ]);
    // Step 1 resumes from the stored head, and the head is the newest *contiguous*
    // run — the deep-link window at 880 did not make the replica claim the head
    // of the session, so the subscription starts from 1 and the ack's gap path
    // fills what the window missed.
    expect(reopened.resumeFrom("sess_1")).toBe(1);
    engine.close();
  });

  test("clearing a session drops its rows, coverage, head and heights", async () => {
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    engine.frames("sess_1", [entryFrame(1)]);
    engine.writeRowHeight("sess_1", 1, "1:v1@1440", 42);
    engine.resetSession("sess_1");

    expect(engine.readWindow("sess_1", 0, 10)).toEqual([]);
    expect(storage.readState("sess_1")).toMatchObject({ head: null, ranges: [] });
    expect(storage.readRowHeight("sess_1", 1, "1:v1@1440")).toBeNull();
    engine.close();
  });

  test("a delayed read window cannot replace a newer streamed revision", async () => {
    const { storage } = await openSqlStorage();
    const replica = new ReplicaEngine(storage);
    replica.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    replica.frames("sess_1", [entryFrame(1, { revision: 5, body_md: "latest" })]);
    replica.writeWindow("sess_1", [entry(1)], { from: 1, to: 1 });
    expect(replica.readWindow("sess_1", 1, 1)[0]).toMatchObject({ revision: 5, body_md: "latest" });
    replica.close();
  });

  test("meta round-trips and a different user wipes the database", async () => {
    const { storage } = await openSqlStorage();
    const first = new ReplicaEngine(storage);
    first.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    first.frames("sess_1", [entryFrame(1), entryFrame(2)]);
    expect(storage.readMeta(META_USER_ID)).toBe("user_1");
    expect(storage.readMeta(META_SCHEMA_VERSION)).toBe(String(REPLICA_SCHEMA_VERSION));

    // Same database file, different user: nothing may survive.
    const second = new ReplicaEngine(storage);
    const opened = second.openSession({ sessionId: "sess_1", userId: "user_2", workspaceId: "ws_1" });
    expect(opened.cleared).toEqual({ reason: "user_mismatch" });
    expect(opened.fromSeq).toBe(1);
    expect(second.readWindow("sess_1", 0, 10)).toEqual([]);
    expect(storage.readMeta(META_USER_ID)).toBe("user_2");
    second.frames("sess_1", [entryFrame(1)]);
    expect(second.openSession({ sessionId: "sess_1", userId: "user_2", workspaceId: "ws_1" }).cleared).toBeNull();
    expect(second.readWindow("sess_1", 0, 10)).toHaveLength(1);
    second.close();
  });

  test("a schema-version bump wipes the database", async () => {
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    engine.frames("sess_1", [entryFrame(1)]);
    storage.writeMeta(META_SCHEMA_VERSION, "0");

    const opened = engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    expect(opened.cleared).toEqual({ reason: "schema_upgrade" });
    expect(engine.readWindow("sess_1", 0, 10)).toEqual([]);
    storage.close();
  });

  test("row heights round-trip per variant and width bucket", async () => {
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    const narrow = rowHeightKey({ revision: 1, renderVersion: "v1", widthPx: 500 });
    const wide = rowHeightKey({ revision: 1, renderVersion: "v1", widthPx: 1440 });
    engine.writeRowHeight("sess_1", 7, narrow, 120);
    engine.writeRowHeight("sess_1", 7, wide, 84);

    const reopened = new ReplicaEngine(storage);
    expect(reopened.readRowHeight("sess_1", 7, narrow)).toBe(120);
    expect(reopened.readRowHeight("sess_1", 7, wide)).toBe(84);
    expect(reopened.readRowHeight("sess_1", 7, rowHeightKey({ revision: 2, renderVersion: "v1", widthPx: 500 }))).toBeNull();
    engine.close();
  });

  test("an ack never adopts the server's head as the replica's own", async () => {
    // The regression this pins: the ack arrives before the frames it announces, so
    // storing `ack.head_seq` as the local head makes the very next freshness check
    // compare the server's number with itself and call a stale window fresh.
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    engine.ack("sess_1", { stream: "log", id: "sess_1", first_seq: 1, head_seq: 170, log_version: 7, gap: null });

    expect(storage.readState("sess_1").head).toBeNull();
    expect(engine.isFresh("sess_1")).toBe(false);

    engine.frames("sess_1", [entryFrame(1), entryFrame(2)]);
    expect(engine.isFresh("sess_1")).toBe(false);
    expect(storage.readState("sess_1").head).toBe(2);

    // Only when the replica actually reaches the announced head does it become fresh.
    engine.frames("sess_1", Array.from({ length: 168 }, (_, index) => entryFrame(index + 3)));
    expect(engine.isFresh("sess_1")).toBe(true);
    storage.close();
  });

  test("a live frame advances the server head freshness compares against", async () => {
    // The offline catch-up shape: the ack is older than the frames, so a
    // freshness check that only ever looked at the ack would call a caught-up
    // replica stale — the plan's "之后每收一帧都成立".
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    engine.ack("sess_1", { stream: "log", id: "sess_1", first_seq: 1, head_seq: 2, log_version: 7, gap: null });
    engine.frames("sess_1", [entryFrame(1), entryFrame(2)]);
    expect(engine.isFresh("sess_1")).toBe(true);

    // 50 rows arrive with no new ack, as a reconnect's replay does.
    engine.frames(
      "sess_1",
      Array.from({ length: 50 }, (_, index) => entryFrame(index + 3)),
    );
    expect(engine.isFresh("sess_1")).toBe(true);
    expect(storage.readState("sess_1").head).toBe(52);

    // And a frame that lands above a hole does not make it fresh.
    engine.frames("sess_1", [entryFrame(60)]);
    expect(engine.isFresh("sess_1")).toBe(false);
    engine.frames("sess_1", Array.from({ length: 7 }, (_, index) => entryFrame(index + 53)));
    expect(engine.isFresh("sess_1")).toBe(true);
    storage.close();
  });

  test("the height cache is keyed by variant and bucket, and misses on purpose", async () => {
    // C8's rule, pinned against the real table: an edited row (revision) and a
    // re-rendered pipeline (render_version) must not inherit the old height, and a
    // narrower container must not inherit a wider measurement's reservation.
    const { storage } = await openSqlStorage();
    const engine = new ReplicaEngine(storage);
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    const key = rowHeightKey({ revision: 1, renderVersion: "v1", widthPx: 1440 });
    engine.writeRowHeight("sess_1", 5, key, 88);

    expect(engine.readRowHeight("sess_1", 5, key)).toBe(88);
    expect(engine.readRowHeight("sess_1", 5, rowHeightKey({ revision: 2, renderVersion: "v1", widthPx: 1440 }))).toBeNull();
    expect(engine.readRowHeight("sess_1", 5, rowHeightKey({ revision: 1, renderVersion: "v2", widthPx: 1440 }))).toBeNull();
    expect(engine.readRowHeight("sess_1", 5, rowHeightKey({ revision: 1, renderVersion: "v1", widthPx: 720 }))).toBeNull();
    // A second engine on the same database reads what the first wrote: this is the
    // hot start for the height cache, not just for the window.
    expect(new ReplicaEngine(storage).readRowHeight("sess_1", 5, key)).toBe(88);
    engine.close();
  });

  test("only the Worker imports sqlite-wasm", async () => {
    // The page bundle must not carry the wasm build: a page-side
    // `import ... from "./worker"` (or from a module that reaches it) made the
    // fixture page's bundle 24 KB -> 495 KB, and in the app it would delay first
    // paint for a dependency only the leader's Worker needs.
    const { readFileSync, readdirSync } = await import("node:fs");
    // `import.meta.dir` is Bun-only; the test also runs under Vitest, where the
    // module URL is what is available.
    const dir = new URL(".", import.meta.url).pathname;
    const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
    for (const name of files) {
      const src = readFileSync(`${dir}/${name}`, "utf8");
      const importsWasm = /from\s*["']@sqlite\.org\/sqlite-wasm["']/.test(src);
      if (name === "worker.ts") {
        expect(importsWasm, "worker.ts must import sqlite-wasm").toBe(true);
        continue;
      }
      expect(importsWasm, `${name} must not import sqlite-wasm`).toBe(false);
      // And nothing below may reach it transitively through the Worker module.
      expect(
        /from\s*["']\.\/worker["']/.test(src),
        `${name} imports ./worker, which pulls the wasm build into the page bundle`,
      ).toBe(false);
    }
  });

  test("every statement the engine runs is in the shared SQL map", () => {
    // A statement spelled inline in one place and not in `schema.ts` is how the
    // Worker and the tests silently diverge; this pins the set.
    const statements = Object.values(SQL);
    expect(statements).toContain(SQL.insertEntry);
    expect(new Set(statements).size).toBe(statements.length);
  });
});

describe("memory storage parity", () => {
  test("the memory fallback runs the same protocol", () => {
    const engine = new ReplicaEngine(new MemoryReplicaStorage());
    engine.openSession({ sessionId: "sess_1", userId: "user_1", workspaceId: "ws_1" });
    const gap = engine.ack("sess_1", { stream: "log", id: "sess_1", first_seq: 1, head_seq: 2, log_version: 3, gap: null });
    expect(gap).toBeNull();
    expect(engine.frames("sess_1", [entryFrame(1), entryFrame(2)])).toBeNull();
    expect(engine.isFresh("sess_1")).toBe(true);
    expect(engine.readWindow("sess_1", 0, 10).map((row) => row.seq)).toEqual([1, 2]);
  });
});
