import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { HubFrame } from "@multiremi/contracts/live-hub";
import { ReplicaEngine } from "./engine";
import type { SessionLogEntry } from "./port";
import { META_SCHEMA_VERSION, REPLICA_SCHEMA_VERSION } from "./schema";
import { MemoryReplicaStorage, type ReplicaStorage } from "./storage";

const sid = "watermark-session";
const row = (revision = 1, sessionId = sid): SessionLogEntry => ({
  session_id: sessionId, seq: 1, id: `${sessionId}:1`, revision, kind: "message",
  body_md: `revision ${revision}`, body_html: null, render_version: null,
});
const entry = (revision = 1): HubFrame => ({ seq: 1, kind: "entry", payload: row(revision) });
const remove = (kind: "tombstone" | "hidden", revision = 5): HubFrame => kind === "tombstone"
  ? { seq: 1, kind: "patch", payload: { target_seq: 1, revision, deleted_at: "2026-09-28" } }
  : { seq: 1, kind: "entry", payload: { ...row(revision), visibility: "hidden" } };
const open = (engine: ReplicaEngine, userId = "u", workspaceId = "w") =>
  engine.openSession({ sessionId: sid, userId, workspaceId });
const ack = (logVersion = 1) => ({ stream: "log" as const, id: sid, log_version: logVersion, head_seq: 1, first_seq: 1, gap: null });

async function storageFor(kind: "memory" | "sqlite", filename = ":memory:"): Promise<ReplicaStorage> {
  if (kind === "memory") return new MemoryReplicaStorage();
  const { DatabaseSync } = await import("node:sqlite");
  const { nodeSqlDatabase } = await import("./sql-node");
  const { SqlReplicaStorage } = await import("./sql-store");
  return new SqlReplicaStorage(nodeSqlDatabase(new DatabaseSync(filename) as never));
}

describe.each(["memory", "sqlite"] as const)("%s revision watermarks", kind => {
  test.each(["tombstone", "hidden"] as const)("%s rejects old/equal entries and HTTP rows after engine reopen", async removal => {
    const storage = await storageFor(kind);
    try {
      const first = new ReplicaEngine(storage);
      open(first); first.ack(sid, ack()); first.frames(sid, [entry(), remove(removal)]);
      const reopened = new ReplicaEngine(storage);
      open(reopened);
      for (const revision of [0, 1, 5]) {
        reopened.frames(sid, [entry(revision)]);
        reopened.writeWindow(sid, [row(revision)], { from: 1, to: 1 });
        expect(reopened.readWindow(sid, 1, 1)).toEqual([]);
        expect(storage.readRevisionWatermarks(sid).get(1)).toBe(5);
      }
      // A genuinely newer full row can supersede the removal.
      reopened.writeWindow(sid, [row(6)], { from: 1, to: 1 });
      expect(reopened.readWindow(sid, 1, 1)).toEqual([row(6)]);
      reopened.frames(sid, [remove(removal), entry(5)]);
      expect(reopened.readWindow(sid, 1, 1)).toEqual([row(6)]);
    } finally { storage.close(); }
  });

  test("tombstone without a display row still persists its revision", async () => {
    const storage = await storageFor(kind);
    try {
      const engine = new ReplicaEngine(storage);
      open(engine); engine.frames(sid, [remove("tombstone")]);
      engine.frames(sid, [entry()]);
      expect(engine.readWindow(sid, 1, 1)).toEqual([]);
      expect(storage.readRevisionWatermarks(sid).get(1)).toBe(5);
      expect(engine.covers(sid, 1)).toBe(true);
    } finally { storage.close(); }
  });

  test("higher removals advance watermarks while old removals cannot roll them back", async () => {
    const storage = await storageFor(kind);
    try {
      const engine = new ReplicaEngine(storage);
      open(engine); engine.frames(sid, [entry(), remove("hidden"), remove("tombstone", 8)]);
      engine.frames(sid, [remove("hidden", 6), entry(7)]);
      engine.writeWindow(sid, [row(8)], { from: 1, to: 1 });
      expect(engine.readWindow(sid, 1, 1)).toEqual([]);
      expect(storage.readRevisionWatermarks(sid).get(1)).toBe(8);
      engine.frames(sid, [entry(9)]);
      expect(engine.readWindow(sid, 1, 1)).toEqual([row(9)]);
    } finally { storage.close(); }
  });

  test("one HTTP batch cannot roll back an accepted newer full row", async () => {
    const storage = await storageFor(kind);
    try {
      const engine = new ReplicaEngine(storage);
      open(engine); engine.frames(sid, [remove("hidden")]);
      engine.writeWindow(sid, [row(7), row(6), row(1)], { from: 1, to: 1 });
      expect(engine.readWindow(sid, 1, 1)).toEqual([row(7)]);
      expect(storage.readRevisionWatermarks(sid).get(1)).toBe(7);
    } finally { storage.close(); }
  });

  test.each(["version", "session", "user", "workspace", "logout", "schema"])("%s reset clears the corresponding watermarks", async reset => {
    const storage = await storageFor(kind);
    try {
      const engine = new ReplicaEngine(storage);
      open(engine); engine.ack(sid, ack()); engine.frames(sid, [entry(), remove("tombstone")]);
      engine.frames("other-session", [{ seq: 1, kind: "entry", payload: row(10, "other-session") }]);
      if (reset === "version") engine.ack(sid, ack(2));
      else if (reset === "session") engine.resetSession(sid);
      else if (reset === "user") open(engine, "new-user");
      else if (reset === "workspace") open(engine, "u", "new-workspace");
      else if (reset === "logout") engine.clear("logout");
      else {
        storage.writeMeta(META_SCHEMA_VERSION, String(REPLICA_SCHEMA_VERSION - 1));
        expect(open(engine).cleared).toEqual({ reason: "schema_upgrade" });
      }
      expect(storage.readRevisionWatermarks(sid).size).toBe(0);
      expect(storage.readRevisionWatermarks("other-session").size).toBe(reset === "version" || reset === "session" ? 1 : 0);
      engine.frames(sid, [entry()]);
      expect(engine.readWindow(sid, 1, 1)).toEqual([row()]);
    } finally { storage.close(); }
  });
});

test.each(["tombstone", "hidden"] as const)("SQLite close/reopen persists %s watermarks, not just engine memory", async removal => {
  const directory = mkdtempSync(join(tmpdir(), "replica-watermark-"));
  const filename = join(directory, "replica.sqlite3");
  let storage = await storageFor("sqlite", filename);
  try {
    const first = new ReplicaEngine(storage);
    open(first); first.frames(sid, [entry(), remove(removal)]);
    first.close();
    storage = await storageFor("sqlite", filename);
    const reopened = new ReplicaEngine(storage);
    open(reopened);
    reopened.frames(sid, [entry(5)]);
    reopened.writeWindow(sid, [row(1)], { from: 1, to: 1 });
    expect(reopened.readWindow(sid, 1, 1)).toEqual([]);
    expect(storage.readRevisionWatermarks(sid).get(1)).toBe(5);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite rolls back deletion if persisting its watermark fails", async () => {
  const storage = await storageFor("sqlite");
  try {
    const engine = new ReplicaEngine(storage);
    open(engine); engine.frames(sid, [entry()]);
    const write = storage.writeRevisionWatermarks;
    storage.writeRevisionWatermarks = () => { throw new Error("synthetic watermark failure"); };
    expect(() => engine.frames(sid, [remove("tombstone")])).toThrow("synthetic watermark failure");
    storage.writeRevisionWatermarks = write;
    expect(storage.readWindow(sid, 1, 1)).toEqual([row()]);
    expect(storage.readRevisionWatermarks(sid).get(1)).toBe(1);
    engine.frames(sid, [remove("tombstone")]);
    expect(storage.readWindow(sid, 1, 1)).toEqual([]);
    expect(storage.readRevisionWatermarks(sid).get(1)).toBe(5);
  } finally { storage.close(); }
});
