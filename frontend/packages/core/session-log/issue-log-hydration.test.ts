import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, type SessionLogRow, type SessionLogWindow } from "../api/schemas/session-log";
import type { HubFrame } from "@multiremi/contracts/live-hub";
import { ReplicaEngine } from "../replica/engine";
import { MemoryReplicaStorage } from "../replica/storage";
const reads = vi.hoisted(() => ({ get: vi.fn(), locate: vi.fn() }));
vi.mock("../api", () => ({ api: { getSessionLog: reads.get, locateSessionLogEntry: reads.locate } }));
import { IssueLogReplica } from "./issue-log";

const row = (seq: number, overrides: Partial<SessionLogRow> = {}) => SessionLogEntrySchema.parse({
  session_id: "s", id: `r${seq}`, seq, kind: "message", revision: 1, body_md: `body ${seq}`, body_html: `<p>${seq}</p>`, render_version: "v1",
  author_type: "member", author_id: "u", metadata: { attachments: [{ id: "att", filename: "read metadata" }], reactions: [{ emoji: "+1" }] }, ...overrides,
});
const windowOf = (entries: SessionLogRow[], overrides: Partial<SessionLogWindow> = {}): SessionLogWindow => ({
  entries, head_seq: entries.at(-1)?.seq ?? 0, log_version: 4, has_more_before: true, has_more_after: false, ...overrides,
});
const frame = (seq: number, overrides = {}): HubFrame => ({ seq, kind: "entry", payload: { session_id: "s", id: `r${seq}`, seq, kind: "message", revision: 1, ...overrides } });
const seed = (window: SessionLogWindow) => new IssueLogReplica("s", { sessionId: "s", head: row(0, { kind: "head" }), window });
afterEach(() => vi.clearAllMocks());

describe("read window subscription and hydration", () => {
  it.each([0, 3, 5, 8])("uses max(local resume, loaded head) for actual engine open with local=%i", local => {
    const engine = new ReplicaEngine(new MemoryReplicaStorage());
    engine.openSession({ sessionId: "s", userId: "u", workspaceId: "w" });
    if (local) engine.writeWindow("s", Array.from({ length: local }, (_, n) => row(n + 1)), { from: 1, to: local });
    const opened = engine.openSession({ sessionId: "s", userId: "u", workspaceId: "w", windowHead: 5 });
    expect(opened.fromSeq).toBe(Math.max(local, 5) + 1);
    // A cursor hint never forges coverage or freshness.
    expect(opened.state.head).toBe(local || null);
    expect(engine.snapshot("s").fresh).toBe(false);
  });

  it.each(["SSR", "CSR", "locate"])("subscribes after the %s window with its global head, including sparse locate windows", async mode => {
    const window = windowOf([row(30), row(31)], { head_seq: 80, has_more_after: true });
    reads.get.mockImplementation(async (_id, p) => p.anchor === 0 ? windowOf([row(0, { kind: "head" })]) : window);
    reads.locate.mockResolvedValue({ id: "r30", seq: 30, head_seq: 80 });
    const replica = mode === "SSR" ? seed(window) : new IssueLogReplica("s");
    if (mode === "CSR") void replica.loadTail();
    if (mode === "locate") void replica.loadAround("r30");
    const subscribe = vi.fn();
    const cleanup = await replica.connect({ userId: "u", workspaceId: "w", subscribe, unsubscribe: vi.fn(), env: { hasOpfs: false } });
    try {
      expect(subscribe).toHaveBeenCalledExactlyOnceWith("s", 81);
      expect(replica.getSnapshot("s").entries.map(e => e.seq)).toEqual([0, 30, 31]);
      if (mode === "SSR") expect(reads.get).not.toHaveBeenCalled();
    } finally { cleanup(); replica.disconnect(); }
  });

  it("reuses complete SSR/current and known window rows by seq plus id, for message and turn", async () => {
    const message = row(10), turn = row(11, { kind: "turn" });
    const replica = seed(windowOf([message, turn]));
    replica.accept(windowOf([row(20)]));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("s", [frame(10), frame(11, { kind: "turn" }), frame(20)]);
    expect(reads.get).not.toHaveBeenCalled();
    expect(delivered.mock.calls[0]?.[1].map(f => f.payload)).toEqual([message, turn, row(20)]);
  });

  it("hydrates several misses in one bounded range and preserves other frames", async () => {
    const replica = seed(windowOf([row(11)]));
    reads.get.mockResolvedValue(windowOf([row(10), row(11), row(12, { kind: "turn" })]));
    const other: HubFrame = { seq: 13, kind: "entry", payload: { kind: "system" } };
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("s", [frame(10), frame(11), frame(12, { kind: "turn" }), other]);
    expect(reads.get).toHaveBeenCalledExactlyOnceWith("s", { anchor: 9, after: 3 });
    expect(delivered.mock.calls[0]?.[1].at(-1)).toBe(other);
    reads.get.mockClear();
    await replica.hydratedFrames("s", [frame(10)]);
    expect(reads.get).not.toHaveBeenCalled();
  });

  it("hydrates a new row from a read at a newer log_version, since every write bumps it", async () => {
    const replica = seed(windowOf([row(10)]));
    const reply = row(11, { author_type: "agent", body_md: "reply" });
    reads.get.mockResolvedValue(windowOf([reply], { log_version: 7 }));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("s", [frame(11)]);
    expect(reads.get).toHaveBeenCalledExactlyOnceWith("s", { anchor: 10, after: 1 });
    expect(delivered.mock.calls[0]?.[1][0]?.payload).toEqual(reply);
  });

  it.each(["id", "seq", "revision"])("does not reuse a stale or mismatched %s", async kind => {
    const replica = seed(windowOf([row(10)]));
    const seq = kind === "seq" ? 12 : 10;
    const id = kind === "id" ? "different-id" : "r10";
    const revision = kind === "revision" ? 2 : 1;
    const current = row(seq, { id, revision });
    reads.get.mockResolvedValue(windowOf([current]));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("s", [frame(seq, { id, revision })]);
    expect(reads.get).toHaveBeenCalledExactlyOnceWith("s", { anchor: seq - 1, after: 1 });
    expect(delivered.mock.calls[0]?.[1][0]?.payload).toEqual(current);
  });

  it("keeps reusing window rows after an ack with a new log_version", async () => {
    const replica = seed(windowOf([row(10)]));
    replica.ack("s", { stream: "log", id: "s", first_seq: 0, head_seq: 10, log_version: 9, gap: null });
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("s", [frame(10)]);
    expect(reads.get).not.toHaveBeenCalled();
    expect(delivered.mock.calls[0]?.[1][0]?.payload).toEqual(row(10));
  });

  it("hydrates another session's frames (the leader serves other tabs and logs) from the read route only", async () => {
    const replica = seed(windowOf([row(10)]));
    const other = row(10, { session_id: "other", id: "r10" });
    reads.get.mockResolvedValue(windowOf([other]));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("other", [frame(10, { session_id: "other" })]);
    // This page's window holds a row at the same seq and id; it is never reused.
    expect(reads.get).toHaveBeenCalledExactlyOnceWith("other", { anchor: 9, after: 1 });
    expect(delivered).toHaveBeenCalledExactlyOnceWith("other", [{ ...frame(10, { session_id: "other" }), payload: other }]);
    // Nor does the other session's read become a window this session hydrates from.
    reads.get.mockClear();
    reads.get.mockResolvedValue(windowOf([row(11)]));
    await replica.hydratedFrames("s", [frame(11)]);
    expect(reads.get).toHaveBeenCalledExactlyOnceWith("s", { anchor: 10, after: 1 });
  });

  it("rejects a payload that names another session than its stream", async () => {
    const replica = seed(windowOf([row(10)]));
    const delivered = vi.spyOn(replica, "frames");
    await expect(replica.hydratedFrames("s", [frame(10, { session_id: "other" })])).rejects.toThrow("another session");
    expect(reads.get).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
  });

  it("settles a deleted hydration row without its body, then hydrates the next batch", async () => {
    const replica = new IssueLogReplica("s");
    reads.get.mockResolvedValueOnce(windowOf([])).mockResolvedValueOnce(windowOf([row(10)]));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("s", [frame(10)]);
    expect(delivered).toHaveBeenCalledExactlyOnceWith("s", [{ ...frame(10), payload: {
      session_id: "s", seq: 10, revision: 1, visibility: "hidden",
    } }]);
    delivered.mockClear();
    await replica.hydratedFrames("s", [frame(10)]);
    expect(delivered).toHaveBeenCalledOnce();
    expect(delivered.mock.calls[0]?.[1][0]?.payload).toEqual(row(10));
  });

  it.each(["disconnect", "ack", "refresh"])("delivers an in-flight hydration result unless a disconnect intervened (%s)", async action => {
    const replica = seed(windowOf([row(10)]));
    let resolve!: (window: SessionLogWindow) => void;
    reads.get.mockReturnValueOnce(new Promise<SessionLogWindow>(done => { resolve = done; }));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    const pending = replica.hydratedFrames("s", [frame(11)]);
    await vi.waitFor(() => expect(reads.get).toHaveBeenCalled());
    if (action === "disconnect") replica.disconnect();
    // Neither a resumed stream nor a newer window read (every write bumps
    // `log_version`) makes the rows already read invalid.
    else if (action === "ack") replica.ack("s", { stream: "log", id: "s", first_seq: 0, head_seq: 11, log_version: 5, gap: null });
    else replica.accept(windowOf([row(10), row(11)], { log_version: 6 }));
    resolve(windowOf([row(11)], { log_version: 5 })); await pending;
    if (action === "disconnect") expect(delivered).not.toHaveBeenCalled();
    else expect(delivered.mock.calls[0]?.[1][0]?.payload).toEqual(row(11));
  });
});
