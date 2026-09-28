import { describe, expect, test } from "vitest";
import type { HubFrame, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import { applyFrames, computeFresh, decideAck, emptyReplicaState, firstHole, subscribeFromSeq, type ReplicaState } from "./protocol";
import { addRange, contiguousTail, coversSeq, highestCoveredSeq, normalizeRanges } from "./ranges";
import type { SessionLogEntry } from "./port";

function entry(seq: number, overrides: Partial<SessionLogEntry> = {}): SessionLogEntry {
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
    payload: { session_id: "sess_1", seq, id: `cmt_${seq}`, revision: 1, kind: "comment", body_md: `body ${seq}`, body_html: `<p>body ${seq}</p>`, render_version: "v1", visibility: "shown", ...overrides },
  };
}

function patchFrame(targetSeq: number, fields: Record<string, unknown>, revision: number): HubFrame {
  return { seq: targetSeq, kind: "patch", payload: { session_id: "sess_1", target_seq: targetSeq, revision, fields } };
}

function hiddenFrame(seq: number): HubFrame {
  return { seq, kind: "entry", payload: { session_id: "sess_1", seq, id: `cmt_${seq}`, revision: 1, kind: "comment", visibility: "hidden" } };
}

function ack(overrides: Partial<HubStreamAckPayload> = {}): HubStreamAckPayload {
  return { stream: "log", id: "sess_1", first_seq: 1, head_seq: 3, log_version: 7, gap: null, ...overrides };
}

describe("sparse ranges", () => {
  test("merges touching and overlapping ranges, keeps real holes apart", () => {
    expect(normalizeRanges([{ from: 6, to: 9 }, { from: 1, to: 5 }])).toEqual([{ from: 1, to: 9 }]);
    expect(normalizeRanges([{ from: 1, to: 3 }, { from: 8, to: 9 }])).toEqual([
      { from: 1, to: 3 },
      { from: 8, to: 9 },
    ]);
    // A deep-link window plus a tail window: the middle is a legal hole.
    const sparse = addRange(addRange([], 880, 920), 1000, 1010);
    expect(sparse).toEqual([
      { from: 880, to: 920 },
      { from: 1000, to: 1010 },
    ]);
    expect(coversSeq(sparse, 900)).toBe(true);
    expect(coversSeq(sparse, 950)).toBe(false);
    expect(highestCoveredSeq(sparse)).toBe(1010);
    expect(highestCoveredSeq([])).toBeNull();
  });

  test("contiguousTail only answers for a run that ends at the head", () => {
    const sparse = [{ from: 1, to: 10 }, { from: 20, to: 30 }];
    expect(contiguousTail(sparse, 30)).toEqual({ from: 20, to: 30 });
    expect(contiguousTail(sparse, 25)).toBeNull();
  });
});

describe("step 1: open a session", () => {
  test("resumes from the stored head, not from 1", () => {
    expect(subscribeFromSeq(emptyReplicaState())).toBe(1);
    expect(subscribeFromSeq({ ranges: [{ from: 1, to: 40 }], head: 40, logVersion: 7, synced: true })).toBe(41);
  });

  test("offline catch-up asks only for the tail, so no full-log request is made", () => {
    // 50 rows arrived while offline; the local head is 100 and the server's is 150.
    const state: ReplicaState = { ranges: [{ from: 1, to: 100 }], head: 100, logVersion: 7, synced: true };
    expect(subscribeFromSeq(state)).toBe(101);
  });
});

describe("step 2: ack", () => {
  test("a new session records the version and reports no backfill", () => {
    const decision = decideAck(ack(), emptyReplicaState());
    expect(decision.reset).toBe(false);
    expect(decision.backfill).toBeNull();
    expect(decision.state).toMatchObject({ logVersion: 7, synced: true });
  });

  test("a gap is reported as the range to read", () => {
    const state: ReplicaState = { ranges: [], head: 10, logVersion: 7, synced: true };
    const decision = decideAck(ack({ first_seq: 40, gap: { from: 11, to: 39 } }), state);
    expect(decision.reset).toBe(false);
    expect(decision.backfill).toEqual({ from: 11, to: 39 });
  });

  test("a log_version change resets the session and backfills below first_seq", () => {
    const state: ReplicaState = { ranges: [{ from: 1, to: 10 }], head: 10, logVersion: 7, synced: true };
    const decision = decideAck(ack({ first_seq: 40, head_seq: 90, log_version: 8 }), state);
    expect(decision.reset).toBe(true);
    expect(decision.backfill).toEqual({ from: 1, to: 39 });
    expect(decision.state).toMatchObject({ ranges: [], head: null, logVersion: 8, synced: true });
  });

  test("a null log_version never counts as a change", () => {
    const state: ReplicaState = { ranges: [], head: 3, logVersion: 7, synced: true };
    expect(decideAck(ack({ log_version: null }), state).reset).toBe(false);
  });
});

describe("step 3: frames", () => {
  test("partial patches in a reordered batch still compose in revision order", () => {
    const result = applyFrames({
      frames: [patchFrame(1, { body_html: "<p>edited</p>" }, 3), patchFrame(1, { body_md: "edited" }, 2)],
      state: emptyReplicaState(), entries: new Map([[1, entry(1)]]),
    });
    expect(result.upserts[0]).toMatchObject({ revision: 3, body_md: "edited", body_html: "<p>edited</p>" });
  });

  test("partial patches compose on the latest revision in the batch", () => {
    const result = applyFrames({
      frames: [patchFrame(1, { body_md: "edited" }, 2), patchFrame(1, { body_html: "<p>edited</p>" }, 3)],
      state: emptyReplicaState(), entries: new Map([[1, entry(1)]]),
    });
    expect(result.upserts[0]).toMatchObject({ revision: 3, body_md: "edited", body_html: "<p>edited</p>" });
  });

  test.each(["entry", "patch"])("an old %s cannot replace newer content", (kind) => {
    const held = entry(1, { revision: 5, body_md: "latest" });
    const frame = kind === "entry" ? entryFrame(1) : patchFrame(1, { body_md: "old" }, 3);
    const result = applyFrames({ frames: [frame], state: emptyReplicaState(), entries: new Map([[1, held]]) });
    expect(result.upserts).toEqual([]);
    expect(result.deletes).toEqual([]);
  });

  test("entries extend coverage and advance the head", () => {
    const result = applyFrames({ frames: [entryFrame(1), entryFrame(2), entryFrame(3)], state: emptyReplicaState(), entries: new Map() });
    expect(result.upserts.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(result.state.head).toBe(3);
    expect(result.state.ranges).toEqual([{ from: 1, to: 3 }]);
    expect(result.missing).toBeNull();
  });

  test("a frame above the head reports a hole and leaves the head contiguous", () => {
    const state: ReplicaState = { ranges: [{ from: 1, to: 3 }], head: 3, logVersion: 7, synced: true };
    const result = applyFrames({ frames: [entryFrame(9)], state, entries: new Map() });
    expect(result.missing).toEqual({ from: 4, to: 8 });
    // The row is kept — throwing it away would lose data the socket just sent —
    // but the head stays at 3 so the resume cursor cannot skip the hole.
    expect(result.state.head).toBe(3);
    expect(coversSeq(result.state.ranges, 9)).toBe(true);
  });

  test("filling the hole advances the head past the previously-orphaned rows", () => {
    const state: ReplicaState = { ranges: [{ from: 1, to: 3 }, { from: 9, to: 9 }], head: 3, logVersion: 7, synced: true };
    const result = applyFrames({ frames: [entryFrame(4), entryFrame(5)], state, entries: new Map() });
    // 6..8 are still missing, so the head moves to 5 rather than jumping to 9.
    expect(result.state.head).toBe(5);
    expect(result.missing).toEqual({ from: 6, to: 8 });
  });

  test("a patch updates in place and keeps the row's seq", () => {
    const state: ReplicaState = { ranges: [{ from: 1, to: 1 }], head: 1, logVersion: 7, synced: true };
    const entries = new Map([[1, entry(1)]]);
    const result = applyFrames({ frames: [patchFrame(1, { body_md: "edited" }, 2)], state, entries });
    expect(result.upserts).toHaveLength(1);
    expect(result.upserts[0]).toMatchObject({ seq: 1, revision: 2, body_md: "edited" });
    expect(result.state.head).toBe(1);
  });

  test("a patch for a row the replica does not hold is left as a hole, not invented", () => {
    const result = applyFrames({ frames: [patchFrame(5, { body_md: "x" }, 2)], state: emptyReplicaState(), entries: new Map() });
    expect(result.upserts).toHaveLength(0);
    expect(result.state.head).toBeNull();
  });

  test("a patch without a revision still bumps the revision, invalidating the height cache", () => {
    const state: ReplicaState = { ranges: [{ from: 1, to: 1 }], head: 1, logVersion: 7, synced: true };
    const result = applyFrames({ frames: [{ seq: 1, kind: "patch", payload: { session_id: "sess_1", target_seq: 1, fields: { body_md: "e" } } }], state, entries: new Map([[1, entry(1, { revision: 4 })]]) });
    expect(result.upserts[0]!.revision).toBe(5);
  });

  test("a hidden marker is covered but never becomes a display row", () => {
    const state: ReplicaState = { ranges: [{ from: 1, to: 1 }], head: 1, logVersion: 7, synced: true };
    const result = applyFrames({ frames: [hiddenFrame(2)], state, entries: new Map([[1, entry(1)]]) });
    expect(result.upserts).toHaveLength(0);
    expect(result.deletes).toEqual([2]);
    expect(result.state.ranges).toEqual([{ from: 1, to: 2 }]);
    expect(result.state.head).toBe(2);
  });

  test("a tombstoning patch drops the row but keeps the seq settled", () => {
    const state: ReplicaState = { ranges: [{ from: 1, to: 3 }], head: 3, logVersion: 7, synced: true };
    const entries = new Map([[1, entry(1)], [2, entry(2)], [3, entry(3)]]);
    const result = applyFrames({ frames: [{ seq: 3, kind: "patch", payload: { session_id: "sess_1", target_seq: 3, revision: 2, deleted_at: "2026-01-01" } }], state, entries });
    expect(result.deletes).toEqual([3]);
    // The seq stays covered and the head stays at 3: the log is append-only, so
    // seq 3 can never be re-delivered and re-reading it would repeat forever.
    expect(result.state.ranges).toEqual([{ from: 1, to: 3 }]);
    expect(result.state.head).toBe(3);
    expect(result.missing).toBeNull();
  });

  test("firstHole walks coverage instead of assuming contiguity", () => {
    expect(firstHole([{ from: 1, to: 5 }, { from: 9, to: 9 }], 5)).toEqual({ from: 6, to: 8 });
    expect(firstHole([{ from: 1, to: 5 }, { from: 6, to: 9 }], 5)).toBeNull();
    expect(firstHole([{ from: 1, to: 5 }], 5)).toBeNull();
    // A sparse window below the head is not on the resume path.
    expect(firstHole([{ from: 900, to: 910 }, { from: 1000, to: 1010 }], 1010)).toBeNull();
  });
});

describe("step 6: freshness", () => {
  const state: ReplicaState = { ranges: [{ from: 1, to: 10 }], head: 10, logVersion: 7, synced: true };

  test("equal log_version and equal head is fresh", () => {
    expect(computeFresh({ state, ackHeadSeq: 10, ackLogVersion: 7 })).toBe(true);
  });

  test("a newer server head is not fresh, even when every held row is complete", () => {
    expect(computeFresh({ state, ackHeadSeq: 11, ackLogVersion: 7 })).toBe(false);
  });

  test("an in-place update that keeps the seq is caught by log_version", () => {
    expect(computeFresh({ state, ackHeadSeq: 10, ackLogVersion: 8 })).toBe(false);
  });

  test("no ack, no version or no stored head is never fresh", () => {
    expect(computeFresh({ state: { ...state, synced: false }, ackHeadSeq: 10, ackLogVersion: 7 })).toBe(false);
    expect(computeFresh({ state: { ...state, logVersion: null }, ackHeadSeq: 10, ackLogVersion: 7 })).toBe(false);
    expect(computeFresh({ state, ackHeadSeq: null, ackLogVersion: 7 })).toBe(false);
    expect(computeFresh({ state, ackHeadSeq: 10, ackLogVersion: null })).toBe(false);
  });

  test("an empty session is fresh once the ack says the head is 0", () => {
    const empty: ReplicaState = { ranges: [], head: null, logVersion: 7, synced: true };
    expect(computeFresh({ state: empty, ackHeadSeq: 0, ackLogVersion: 7 })).toBe(true);
    expect(computeFresh({ state: empty, ackHeadSeq: 1, ackLogVersion: 7 })).toBe(false);
  });
});
