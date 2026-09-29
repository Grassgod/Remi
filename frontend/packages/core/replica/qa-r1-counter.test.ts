import { expect, test } from "vitest";
import type { HubFrame } from "@multiremi/contracts/live-hub";
import { ReplicaEngine } from "./engine";
import type { SessionLogEntry } from "./port";
import { MemoryReplicaStorage } from "./storage";

// G8 counterexamples from QA's fa7d6a21 re-review, without changing assertions.
const sid = "r1-session";
const row = (revision = 1): SessionLogEntry => ({
  session_id: sid, seq: 1, id: "r1-1", revision, body_md: `rev-${revision}`,
  kind: "message", body_html: null, render_version: null,
});
const entry = (revision = 1): HubFrame => ({ seq: 1, kind: "entry", payload: row(revision) });
const tombstone: HubFrame = {
  seq: 1, kind: "patch", payload: { target_seq: 1, revision: 5, deleted_at: "2026-09-28" },
};
function populate(replica: ReplicaEngine): void {
  replica.openSession({ sessionId: sid, userId: "u", workspaceId: "w" });
  replica.ack(sid, { stream: "log", id: sid, head_seq: 1, log_version: 1, first_seq: 1, gap: null });
  replica.frames(sid, [entry()]);
}

test.each(["entry", "http"])("G8 old %s cannot resurrect a tombstoned higher revision", mode => {
  const replica = new ReplicaEngine(new MemoryReplicaStorage());
  populate(replica);
  replica.frames(sid, [tombstone]);
  expect(replica.readWindow(sid, 1, 1)).toEqual([]);
  if (mode === "entry") replica.frames(sid, [entry()]);
  else replica.writeWindow(sid, [row()], { from: 1, to: 1 });
  expect(replica.readWindow(sid, 1, 1)).toEqual([]);
});

test("G8 hidden revision cannot be undone by older visible entry", () => {
  const replica = new ReplicaEngine(new MemoryReplicaStorage());
  populate(replica);
  replica.frames(sid, [{ seq: 1, kind: "entry", payload: { ...row(5), visibility: "hidden" } }]);
  expect(replica.readWindow(sid, 1, 1)).toEqual([]);
  replica.frames(sid, [entry()]);
  expect(replica.readWindow(sid, 1, 1)).toEqual([]);
});

test.each(["entry", "http"])("G8 real SQLite preserves removal watermark after engine reopen against stale %s", async mode => {
  const { DatabaseSync } = await import("node:sqlite");
  const { nodeSqlDatabase } = await import("./sql-node");
  const { SqlReplicaStorage } = await import("./sql-store");
  const storage = new SqlReplicaStorage(nodeSqlDatabase(new DatabaseSync(":memory:") as never));
  try {
    const first = new ReplicaEngine(storage);
    populate(first);
    first.frames(sid, [tombstone]);
    const reopened = new ReplicaEngine(storage);
    reopened.openSession({ sessionId: sid, userId: "u", workspaceId: "w" });
    if (mode === "entry") reopened.frames(sid, [entry()]);
    else reopened.writeWindow(sid, [row()], { from: 1, to: 1 });
    expect(reopened.readWindow(sid, 1, 1)).toEqual([]);
  } finally { storage.close(); }
});
