import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, SessionLogWindowSchema, type SessionLogWindow } from "../api/schemas/session-log";
import type { IssueActivityEntry } from "@multiremi/contracts";
import { ApiError } from "../api/http";
const mocks = vi.hoisted(() => ({ read: vi.fn(), locate: vi.fn() }));
vi.mock("../api", () => ({ api: { getSessionLog: mocks.read, locateSessionLogEntry: mocks.locate } }));
import { IssueLogReplica } from "./issue-log";

const row = (seq: number, kind = "message") => SessionLogEntrySchema.parse({ session_id: "s", id: `r${seq}`, seq, kind,
  revision: 1, body_md: `body ${seq}`, body_html: `<p>body ${seq}</p>`, render_version: "v", author_type: "member", author_id: "u",
  metadata: { attachments: [{ id: "att" }], reactions: [] } });
const windowOf = (entries = [row(80), row(81)]): SessionLogWindow => ({ entries, head_seq: 81, log_version: 4, has_more_before: true, has_more_after: false });
const audit = (id: string): IssueActivityEntry => ({ type: "activity", id, action: "issue_created", details: null, actor_type: "system", actor_id: null, created_at: "2026-10-04T00:00:00.000Z" });

describe("activity sidecar", () => {
  it("parses optional sidecar fields, rejects invalid activity data, and accepts older windows", () => {
    expect(SessionLogWindowSchema.parse(windowOf()).activities).toBeUndefined();
    expect(SessionLogWindowSchema.parse({ ...windowOf(), activities: [audit("a")], prev_entry_created_at: null, activities_truncated: true }).activities).toEqual([audit("a")]);
    expect(SessionLogWindowSchema.safeParse({ ...windowOf(), activities: [{ ...audit("a"), details: "invalid" }] }).success).toBe(false);
  });
  it("unions activity pages by id and replaces the sidecar on readTail", async () => {
    mocks.read.mockReset();
    mocks.read.mockImplementation(async (_id: string, params: { anchor?: number; with_activity?: number }) => {
      if (params.anchor === 0) return windowOf([row(0, "head")]);
      if (params.anchor === 79) return { ...windowOf([row(78), row(79)]), activities: [audit("old"), audit("same")], prev_entry_created_at: "older" };
      if (params.anchor === 81) return { ...windowOf([row(82)]), activities: [audit("new"), audit("same")], activities_truncated: true };
      return { ...windowOf(), activities: [audit("tail")] };
    });
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: { ...windowOf(), activities: [audit("same")] } }, false, true);
    await replica.earlier(); await replica.newer();
    expect(replica.window?.activities?.map(a => a.id).sort()).toEqual(["new", "old", "same"]);
    expect(replica.window?.activities_truncated).toBe(true);
    expect(replica.window?.prev_entry_created_at).toBe("older");
    expect(mocks.read.mock.calls.filter(([, p]) => p.anchor !== 0).every(([, p]) => p.with_activity === 1)).toBe(true);
    await replica.loadTail();
    expect(replica.window?.activities?.map(a => a.id)).toEqual(["tail"]);
    expect(replica.window?.activities_truncated).toBeUndefined();
  });
  it("keeps activity on preserve-window refresh, but 404 fallback replaces it", async () => {
    mocks.read.mockReset(); mocks.locate.mockReset();
    mocks.locate.mockResolvedValue({ id: "r80", seq: 80, head_seq: 81 });
    mocks.read.mockImplementation(async (_id, p) => p.anchor === 0 ? windowOf([row(0, "head")]) : { ...windowOf(), activities: [audit("fresh")] });
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: { ...windowOf(), activities: [audit("held")] } }, false, true);
    await replica.loadAround("r80", true);
    expect(replica.window?.activities?.map(a => a.id)).toEqual(["fresh", "held"]);
    mocks.locate.mockRejectedValue(new ApiError("missing", 404, "Not Found"));
    await replica.loadAround("deleted", true);
    expect(replica.missingCommentId).toBe("deleted");
    expect(replica.window?.activities?.map(a => a.id)).toEqual(["fresh"]);
    expect(mocks.read).toHaveBeenCalledWith("s", { before: 30, with_activity: 1 });
  });
  it("appends live activity only to an enabled tail, without changing seq/head or freshness", () => {
    const seed = { sessionId: "s", head: row(0, "head"), window: windowOf() };
    for (const enabled of [false, true]) for (const middle of [false, true]) {
      const replica = new IssueLogReplica("s", { ...seed, window: { ...seed.window, has_more_after: middle } }, false, enabled);
      const before = replica.getSnapshot("s");
      replica.appendActivity(audit("live")); replica.appendActivity(audit("live"));
      replica.appendActivity({ ...audit("ignore"), action: "comment_created" });
      expect(replica.window?.activities?.map(a => a.id) ?? []).toEqual(enabled && !middle ? ["live"] : []);
      expect(replica.getSnapshot("s")).toMatchObject({ head: before.head, ready: before.ready, fresh: before.fresh, entries: before.entries });
    }
  });
  it("refreshes an expanded default-session history with activities from every intervening page", async () => {
    const seed = { ...windowOf([row(3), row(4)]), prev_entry_created_at: "held-boundary", before_visible_count: 2,
      activities: [audit("held")] };
    mocks.read.mockImplementation(async (_id, params) => params.anchor === 2
      ? { ...windowOf([row(3), row(4), row(5), row(6)]), activities: [audit("bridge"), audit("held")] }
      : { ...windowOf([row(7), row(8)]), activities: [audit("tail")], head_seq: 8 });
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: seed }, false, true);
    await replica.refreshVisible();
    expect(replica.getSnapshot("s").entries.map(entry => entry.seq)).toEqual([0, 3, 4, 5, 6, 7, 8]);
    expect(replica.window?.activities?.map(entry => entry.id)).toEqual(["bridge", "held", "tail"]);
    expect(replica.window).toMatchObject({ prev_entry_created_at: "held-boundary", before_visible_count: 2 });
    expect(mocks.read.mock.calls.map(([, params]) => params)).toEqual([
      { before: 30, with_activity: 1 }, { anchor: 2, after: 100, with_activity: 1 },
    ]);
    expect(replica.getSnapshot("s")).toMatchObject({ ready: true, fresh: true, head: 8 });
  });
  it("removes deleted comments and refreshes edited comments without dropping loaded activities", async () => {
    const seed = { ...windowOf([row(3), row(4), row(80), row(81)]), activities: [audit("held")] };
    const edited = { ...row(80), revision: 2, body_md: "edited" };
    mocks.read.mockImplementation(async (_id, params) => params.anchor === 2
      ? { ...windowOf([row(4)]), activities: [audit("held")] }
      : { ...windowOf([edited]), activities: [audit("fresh")] });
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: seed }, false, true);
    await replica.refreshVisible();
    expect(replica.getSnapshot("s").entries.map(entry => entry.seq)).toEqual([0, 4, 80]);
    expect(replica.getSnapshot("s").entries.at(-1)).toMatchObject({ revision: 2, body_md: "edited" });
    expect(replica.window?.activities?.map(entry => entry.id)).toEqual(["fresh", "held"]);
  });
  it("keeps log-only deep-link refreshes on their existing replacement behavior", async () => {
    const seed = { ...windowOf([row(3), row(80)]), activities: [audit("ignored")] };
    mocks.locate.mockResolvedValue({ id: "r80", seq: 80, head_seq: 81 });
    mocks.read.mockImplementation(async (_id, params) => params.anchor === 0
      ? windowOf([row(0, "head")]) : windowOf([row(80), row(81)]));
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: seed });
    await replica.loadAround("r80", true);
    expect(replica.getSnapshot("s").entries.map(entry => entry.seq)).toEqual([0, 80, 81]);
    expect(replica.window?.activities).toBeUndefined();
    expect(mocks.read.mock.calls.every(([, params]) => params.with_activity === undefined)).toBe(true);
  });
});

afterEach(() => { vi.unstubAllGlobals(); mocks.read.mockReset(); mocks.locate.mockReset(); });

describe("Issue log presentation over C7", () => {
  it("imports SSR rows into C7 without a second network read or losing display fields", async () => {
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: windowOf() });
    const cleanup = await replica.connect({ userId: "u", workspaceId: "w", subscribe: vi.fn(), unsubscribe: vi.fn(), env: { hasOpfs: false } });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(replica.getSnapshot("s").entries.map(e => e.id)).toEqual(["r0", "r80", "r81"]);
    expect(replica.getSnapshot("s").fresh).toBe(true);
    expect(SessionLogEntrySchema.parse(replica.getSnapshot("s").entries[1]).author_id).toBe("u");
    cleanup();
  });
  it("connects and subscribes over http without crypto.randomUUID or Web Locks", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: undefined,
      getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto),
    });
    const subscribe = vi.fn();
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: windowOf() });
    const cleanup = await replica.connect({ userId: "u", workspaceId: "w", subscribe, unsubscribe: vi.fn(),
      env: { hasOpfs: false, locks: {} as LockManager } });
    try {
      expect(subscribe).toHaveBeenCalledWith("s", 82);
      expect(replica.getSnapshot("s")).toMatchObject({ ready: true, fresh: true });
      expect(replica.getSnapshot("s").entries.map(entry => entry.id)).toEqual(["r0", "r80", "r81"]);
    } finally { cleanup(); }
  });
  it("keeps the head and bounds DOM rows; thread markers cannot render", () => {
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"), window: windowOf([
      ...Array.from({ length: 350 }, (_, n) => row(n + 1)), row(351, "thread_resolved"), row(352, "thread_unresolved"), row(353, "follow_frozen"),
    ]) });
    const entries = replica.getSnapshot("s").entries;
    expect(entries).toHaveLength(300); expect(entries[0]?.seq).toBe(0);
    expect(entries.some(e => e.kind.startsWith("thread_"))).toBe(false);
    expect(entries.at(-1)?.kind).toBe("follow_frozen");
  });
  it("locates a deep-link window, extends both sparse ends, then returns to the tail", async () => {
    mocks.read.mockReset(); mocks.locate.mockReset();
    mocks.locate.mockResolvedValue({ id: "r40", seq: 40, head_seq: 81 });
    mocks.read.mockImplementation(async (_sessionId: string, params: { anchor?: number; before?: number; after?: number }) => {
      if (params.anchor === 0) return windowOf([row(0, "head")]);
      if (params.anchor === 40) return { ...windowOf([row(39), row(40), row(41)]), has_more_after: true };
      if (params.anchor === 38) return { ...windowOf([row(37), row(38)]), has_more_after: true };
      if (params.anchor === 41) return { ...windowOf([row(42), row(43)]), has_more_after: true };
      return windowOf();
    });
    const replica = new IssueLogReplica("s");
    await replica.loadAround("r40");
    expect(mocks.locate).toHaveBeenCalledWith("s", "r40");
    expect(mocks.read).toHaveBeenCalledWith("s", { anchor: 40, before: 15, after: 15 });
    expect(replica.getSnapshot("s").entries.map(entry => entry.seq)).toEqual([0, 39, 40, 41]);
    await replica.earlier();
    await replica.newer();
    expect(mocks.read).toHaveBeenCalledWith("s", { anchor: 38, before: 30 });
    expect(mocks.read).toHaveBeenCalledWith("s", { anchor: 41, after: 30 });
    expect(replica.getSnapshot("s").entries.map(entry => entry.seq)).toEqual([0, 37, 38, 39, 40, 41, 42, 43]);
    await replica.loadTail();
    expect(replica.hasWindowFor()).toBe(true);
    expect(replica.getSnapshot("s").entries.map(entry => entry.seq)).toEqual([0, 80, 81]);
  });

  it("refreshes Chat's tail without discarding manually expanded older rows", async () => {
    mocks.read.mockReset().mockResolvedValue({ ...windowOf([row(80), row(81), row(82)]), head_seq: 82 });
    const replica = new IssueLogReplica("s", { sessionId: "s", head: null,
      window: { ...windowOf([row(78), row(79), row(80), row(81)]), has_more_before: true } });
    await replica.refreshTailPreservingWindow();
    expect(mocks.read).toHaveBeenCalledWith("s", { before: 30 });
    expect(replica.getSnapshot("s").entries.map(entry => entry.seq)).toEqual([78, 79, 80, 81, 82]);
    expect(replica.window?.has_more_before).toBe(true);
  });

  it.each(["deleted-comment", "missing-comment"])("falls back to a ready tail when locate cannot find %s", async commentId => {
    mocks.locate.mockReset().mockRejectedValue(new ApiError("entry not found", 404, "Not Found"));
    mocks.read.mockReset().mockImplementation(async (_id, params) => params.anchor === 0
      ? windowOf([row(0, "head")]) : windowOf());
    const replica = new IssueLogReplica("s");
    const readyFrames: Array<string | null> = [];
    replica.subscribe("s", () => {
      if (replica.getSnapshot("s").ready) readyFrames.push(replica.missingCommentId);
    });
    await replica.loadAround(commentId);
    expect(replica.getSnapshot("s")).toMatchObject({ ready: true, fresh: true });
    expect(replica.getSnapshot("s").entries.map(entry => entry.id)).toEqual(["r0", "r80", "r81"]);
    expect(readyFrames).toEqual([commentId]);
    expect(replica.hasWindowFor(commentId)).toBe(true);
    expect(replica.hasWindowFor()).toBe(true);
    mocks.locate.mockClear();
    await replica.refreshVisible();
    expect(mocks.locate).not.toHaveBeenCalled();
  });

  it.each([new ApiError("server unavailable", 503, "Unavailable"), new TypeError("Failed to fetch")])(
    "preserves locate errors other than not-found: %s", async error => {
      mocks.locate.mockReset().mockRejectedValue(error);
      mocks.read.mockReset();
      const replica = new IssueLogReplica("s");
      await expect(replica.loadAround("target")).rejects.toBe(error);
      expect(mocks.read).not.toHaveBeenCalled();
      expect(replica.missingCommentId).toBeNull();
      expect(replica.getSnapshot("s").ready).toBe(false);
    },
  );

  it("does not hide a tail read failure after locate returns not-found", async () => {
    mocks.locate.mockReset().mockRejectedValue(new ApiError("entry not found", 404, "Not Found"));
    const error = new ApiError("session not found", 404, "Not Found");
    mocks.read.mockReset().mockRejectedValue(error);
    const replica = new IssueLogReplica("s");
    await expect(replica.loadAround("target")).rejects.toBe(error);
    expect(replica.getSnapshot("s").ready).toBe(false);
    expect(replica.missingCommentId).toBeNull();
  });

  it("rechecks an SSR target that is absent from its window, then uses the tail", async () => {
    const replica = new IssueLogReplica("s", { sessionId: "s", head: row(0, "head"),
      window: windowOf(), targetCommentId: "missing-comment" });
    expect(replica.hasWindowFor("missing-comment")).toBe(false);
    mocks.locate.mockReset().mockRejectedValue(new ApiError("entry not found", 404, "Not Found"));
    mocks.read.mockReset().mockResolvedValue(windowOf());
    await replica.loadAround("missing-comment");
    expect(replica.hasWindowFor("missing-comment")).toBe(true);
    expect(replica.missingCommentId).toBe("missing-comment");
  });

  it("imports an SSR missing-target fallback without locating it again", () => {
    const replica = new IssueLogReplica("s", { sessionId: "s", head: null,
      window: windowOf(), missingCommentId: "missing-comment" });
    expect(replica.hasWindowFor("missing-comment")).toBe(true);
    expect(replica.hasWindowFor()).toBe(true);
    expect(replica.missingCommentId).toBe("missing-comment");
  });

  it("hydrates live message metadata before forwarding ordered frames to C7", async () => {
    mocks.read.mockReset().mockImplementation(async (_sessionId: string, input: { anchor: number }) => {
      if (input.anchor === 9) await new Promise(resolve => setTimeout(resolve, 10));
      return windowOf([row(input.anchor + 1)]);
    });
    const replica = new IssueLogReplica("s");
    const delivered: number[][] = [];
    vi.spyOn(replica, "frames").mockImplementation((_sessionId, frames) => {
      delivered.push(frames.map(frame => (frame.payload as { seq: number }).seq));
      for (const frame of frames) {
        expect((frame.payload as { metadata: { attachments: unknown[] } }).metadata.attachments).toHaveLength(1);
        expect((frame.payload as { metadata: { reactions: unknown[] } }).metadata.reactions).toEqual([]);
      }
    });
    const frame = (seq: number) => ({ seq, kind: "entry" as const,
      payload: { session_id: "s", id: `r${seq}`, seq, kind: "message", metadata: {} } });
    await Promise.all([replica.hydratedFrames("s", [frame(10)]), replica.hydratedFrames("s", [frame(11)])]);
    expect(mocks.read).toHaveBeenCalledWith("s", { anchor: 9, after: 1 });
    expect(delivered).toEqual([[10], [11]]);
  });
});
