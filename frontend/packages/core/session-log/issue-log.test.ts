import { describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema, type SessionLogWindow } from "../api/schemas/session-log";
const mocks = vi.hoisted(() => ({ read: vi.fn(), locate: vi.fn() }));
vi.mock("../api", () => ({ api: { getSessionLog: mocks.read, locateSessionLogEntry: mocks.locate } }));
import { IssueLogReplica } from "./issue-log";

const row = (seq: number, kind = "message") => SessionLogEntrySchema.parse({ session_id: "s", id: `r${seq}`, seq, kind,
  revision: 1, body_md: `body ${seq}`, body_html: `<p>body ${seq}</p>`, render_version: "v", author_type: "member", author_id: "u",
  metadata: { attachments: [{ id: "att" }], reactions: [] } });
const windowOf = (entries = [row(80), row(81)]): SessionLogWindow => ({ entries, head_seq: 81, log_version: 4, has_more_before: true, has_more_after: false });

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
});
