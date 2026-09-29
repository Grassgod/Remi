import { describe, expect, it } from "vitest";
import {
  ROW_HEIGHT_WIDTH_BUCKET_PX,
  renderVariant,
  rowHeightKey,
  widthBucket,
} from "./port.js";
import { MemorySessionReplica, memoryReplicaWith } from "./memory.js";
import type { SessionLogEntry } from "./port.js";

function entry(seq: number, overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
  return {
    session_id: "ises_1",
    seq,
    id: `cmt_${seq}`,
    revision: 1,
    kind: "message",
    body_html: `<p>body ${seq}</p>`,
    render_version: "md-abc",
    body_md: `body ${seq}`,
    ...overrides,
  };
}

describe("row height cache key (plan 3/6 §3)", () => {
  it("buckets widths down to 8px", () => {
    expect(ROW_HEIGHT_WIDTH_BUCKET_PX).toBe(8);
    expect(widthBucket(0)).toBe(0);
    expect(widthBucket(7.9)).toBe(0);
    expect(widthBucket(8)).toBe(8);
    expect(widthBucket(895.4)).toBe(888);
    expect(widthBucket(896)).toBe(896);
  });

  it("treats a missing or unusable width as bucket 0 instead of producing NaN", () => {
    expect(widthBucket(Number.NaN)).toBe(0);
    expect(widthBucket(Number.POSITIVE_INFINITY)).toBe(0);
    expect(widthBucket(-100)).toBe(0);
  });

  it("keys on revision:render_version, so edits and re-renders miss on purpose", () => {
    expect(renderVariant(3, "md-abc")).toBe("3:md-abc");
    // The degrade path has no render_version; it must still be a distinct variant
    // from a rendered row of the same revision.
    expect(renderVariant(3, null)).toBe("3:");
    expect(rowHeightKey({ revision: 3, renderVersion: "md-abc", widthPx: 800 })).toBe("3:md-abc@800");
    expect(rowHeightKey({ revision: 3, renderVersion: null, widthPx: 800 })).toBe("3:@800");
    expect(rowHeightKey({ revision: 4, renderVersion: "md-abc", widthPx: 800 })).not.toBe(
      rowHeightKey({ revision: 3, renderVersion: "md-abc", widthPx: 800 }),
    );
  });

  it("separates neighbouring width buckets", () => {
    const a = rowHeightKey({ revision: 1, renderVersion: "v", widthPx: 799 });
    const b = rowHeightKey({ revision: 1, renderVersion: "v", widthPx: 800 });
    expect(a).toBe("1:v@792");
    expect(b).toBe("1:v@800");
    expect(a).not.toBe(b);
  });
});

describe("MemorySessionReplica", () => {
  it("keeps the snapshot identity stable between changes, for useSyncExternalStore", () => {
    const replica = memoryReplicaWith("ises_1", { entries: [entry(1), entry(2)] });
    const first = replica.getSnapshot("ises_1");
    expect(replica.getSnapshot("ises_1")).toBe(first);

    replica.append("ises_1", [entry(3)]);
    const second = replica.getSnapshot("ises_1");
    expect(second).not.toBe(first);
    expect(replica.getSnapshot("ises_1")).toBe(second);
  });

  it("sorts the window by seq and derives head from the newest entry", () => {
    const replica = new MemorySessionReplica({
      ises_1: { entries: [entry(5), entry(2), entry(9)] },
    });
    const snapshot = replica.getSnapshot("ises_1");
    expect(snapshot.entries.map((item) => item.seq)).toEqual([2, 5, 9]);
    expect(snapshot.head).toBe(9);
    expect(snapshot.ready).toBe(true);
    expect(snapshot.fresh).toBe(true);
  });

  it("starts a session that was never seeded as not-ready and not-fresh", () => {
    const replica = new MemorySessionReplica();
    expect(replica.getSnapshot("ises_new")).toEqual({
      sessionId: "ises_new",
      entries: [],
      head: null,
      fresh: false,
      ready: false,
    });
  });

  it("notifies only the subscribed session, and stops after unsubscribe", () => {
    const replica = memoryReplicaWith("ises_1", { entries: [entry(1)] });
    const seen: string[] = [];
    const off = replica.subscribe("ises_1", () => seen.push("ises_1"));
    replica.subscribe("ises_2", () => seen.push("ises_2"));

    replica.append("ises_1", [entry(2)]);
    expect(seen).toEqual(["ises_1"]);

    // A second, unchanged append still notifies: the port reports "the window
    // may have changed", and de-duplicating is the reader's job.
    off();
    replica.append("ises_1", [entry(3)]);
    expect(seen).toEqual(["ises_1"]);
  });

  it("merges an appended row over the one it replaces instead of duplicating the seq", () => {
    const replica = memoryReplicaWith("ises_1", { entries: [entry(1), entry(2)] });
    replica.append("ises_1", [entry(2, { revision: 4, body_md: "edited" })]);
    const snapshot = replica.getSnapshot("ises_1");
    expect(snapshot.entries.map((item) => item.seq)).toEqual([1, 2]);
    expect(snapshot.entries[1]!.revision).toBe(4);
    expect(snapshot.entries[1]!.body_md).toBe("edited");
  });

  it("keeps freshness separate from the window, and does not notify on a no-op flip", () => {
    const replica = memoryReplicaWith("ises_1", { entries: [entry(1)], fresh: true });
    let notifications = 0;
    replica.subscribe("ises_1", () => {
      notifications += 1;
    });

    replica.setFreshness("ises_1", true);
    expect(notifications).toBe(0);

    replica.setFreshness("ises_1", false);
    expect(notifications).toBe(1);
    expect(replica.getSnapshot("ises_1").fresh).toBe(false);
    // The window is untouched: freshness is a separate fact from the rows.
    expect(replica.getSnapshot("ises_1").entries).toHaveLength(1);
  });

  it("round-trips the height cache per (seq, variant, width bucket)", () => {
    const replica = memoryReplicaWith("ises_1");
    const key = rowHeightKey({ revision: 1, renderVersion: "md-abc", widthPx: 800 });
    expect(replica.readRowHeight("ises_1", 7, key)).toBeNull();

    replica.writeRowHeight("ises_1", 7, key, 132.5);
    expect(replica.readRowHeight("ises_1", 7, key)).toBe(132.5);

    // Another row, another variant and another width bucket are all misses.
    expect(replica.readRowHeight("ises_1", 8, key)).toBeNull();
    expect(replica.readRowHeight("ises_1", 7, rowHeightKey({ revision: 2, renderVersion: "md-abc", widthPx: 800 }))).toBeNull();
    expect(replica.readRowHeight("ises_1", 7, rowHeightKey({ revision: 1, renderVersion: "md-abc", widthPx: 792 }))).toBeNull();
  });

  it("seeds heights through the same key shape it reads", () => {
    const replica = new MemorySessionReplica({
      ises_1: {
        rowHeights: [
          { sessionId: "ises_1", seq: 4, revision: 2, renderVersion: "md-x", widthPx: 801, height: 90 },
        ],
      },
    });
    const key = rowHeightKey({ revision: 2, renderVersion: "md-x", widthPx: 800 });
    expect(key).toBe("2:md-x@800");
    expect(replica.readRowHeight("ises_1", 4, key)).toBe(90);
  });
});
