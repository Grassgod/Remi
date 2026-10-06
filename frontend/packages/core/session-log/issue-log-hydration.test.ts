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

  it.each(["id", "seq", "revision", "reset"])("does not reuse a stale or mismatched %s", async kind => {
    const replica = seed(windowOf([row(10)]));
    const seq = kind === "seq" ? 12 : 10;
    const id = kind === "id" ? "different-id" : "r10";
    const revision = kind === "revision" ? 2 : 1;
    const version = kind === "reset" ? 5 : 4;
    if (kind === "reset") replica.ack("s", { stream: "log", id: "s", first_seq: 0, head_seq: 10, log_version: 5, gap: null });
    const current = row(seq, { id, revision });
    reads.get.mockResolvedValue(windowOf([current], { log_version: version }));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await replica.hydratedFrames("s", [frame(seq, { id, revision })]);
    expect(reads.get).toHaveBeenCalledExactlyOnceWith("s", { anchor: seq - 1, after: 1 });
    expect(delivered.mock.calls[0]?.[1][0]?.payload).toEqual(current);
  });

  it("rejects another session without reading or forwarding its rows", async () => {
    const replica = seed(windowOf([row(10)]));
    const delivered = vi.spyOn(replica, "frames");
    await expect(replica.hydratedFrames("other", [frame(10)])).rejects.toThrow("another session");
    await expect(replica.hydratedFrames("s", [frame(10, { session_id: "other" })])).rejects.toThrow("another session");
    expect(reads.get).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
  });

  it("rejects a missing hydration row, then lets the next batch recover", async () => {
    const replica = new IssueLogReplica("s");
    reads.get.mockResolvedValueOnce(windowOf([])).mockResolvedValueOnce(windowOf([row(10)]));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    await expect(replica.hydratedFrames("s", [frame(10)])).rejects.toThrow("unavailable");
    expect(delivered).not.toHaveBeenCalled();
    await replica.hydratedFrames("s", [frame(10)]);
    expect(delivered).toHaveBeenCalledOnce();
  });

  it.each(["disconnect", "reset"])("discards an in-flight hydration result after %s", async action => {
    const replica = seed(windowOf([row(10)]));
    let resolve!: (window: SessionLogWindow) => void;
    reads.get.mockReturnValue(new Promise<SessionLogWindow>(done => { resolve = done; }));
    const delivered = vi.spyOn(replica, "frames").mockImplementation(() => {});
    const pending = replica.hydratedFrames("s", [frame(11)]);
    await vi.waitFor(() => expect(reads.get).toHaveBeenCalled());
    if (action === "disconnect") replica.disconnect();
    else replica.ack("s", { stream: "log", id: "s", first_seq: 0, head_seq: 11, log_version: 5, gap: null });
    resolve(windowOf([row(11)])); await pending;
    expect(delivered).not.toHaveBeenCalled();
  });
});
