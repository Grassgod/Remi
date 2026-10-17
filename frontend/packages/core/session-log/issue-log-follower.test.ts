import { afterEach, expect, it, vi } from "vitest";
import type { HubFrame } from "@multiremi/contracts/live-hub";
import { SessionLogEntrySchema, type LogWindowParams, type SessionLogRow, type SessionLogWindow } from "../api/schemas/session-log";
import { sharedTabsEnv } from "../replica/test-tabs";
const reads = vi.hoisted(() => ({ get: vi.fn(), locate: vi.fn() }));
vi.mock("../api", () => ({ api: { getSessionLog: reads.get, locateSessionLogEntry: reads.locate } }));
import { IssueLogReplica } from "./issue-log";

/**
 * Two session logs share one replica lock: an Issue detail and the floating chat
 * over it on one page, or two tabs. Whichever connected first leads and holds
 * the socket subscription for both; the other follows. A leader that refused
 * the follower's frames left the chat without its live reply until a remount.
 */
const server = new Map<string, SessionLogRow[]>();
const row = (sessionId: string, seq: number, fields: Partial<SessionLogRow> = {}) => SessionLogEntrySchema.parse({
  session_id: sessionId, id: `${sessionId}_${seq}`, seq, kind: seq === 0 ? "head" : "message", revision: 1,
  body_md: `${sessionId} ${seq}`, body_html: null, render_version: null, author_type: "member", author_id: "u",
  metadata: { attachments: [] }, ...fields,
});
function read(sessionId: string, params: LogWindowParams): SessionLogWindow {
  const rows = server.get(sessionId) ?? [];
  const head = rows.at(-1)?.seq ?? 0;
  const anchor = params.anchor ?? head;
  const before = params.before ? rows.filter(entry => entry.seq <= anchor).slice(-params.before) : [];
  const after = params.after ? rows.filter(entry => entry.seq > anchor).slice(0, params.after) : [];
  return { entries: [...before, ...after], head_seq: head, log_version: rows.length, has_more_before: false, has_more_after: false };
}
const frame = (entry: SessionLogRow): HubFrame => ({ seq: entry.seq, kind: "entry", payload: {
  session_id: entry.session_id, seq: entry.seq, id: entry.id, kind: entry.kind, revision: entry.revision,
} });
const bodies = (replica: IssueLogReplica) => replica.getSnapshot(replica.sessionId).entries.map(entry => entry.body_md);

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); server.clear(); vi.clearAllMocks(); });

async function open(env: ReturnType<typeof sharedTabsEnv>, sessionId: string) {
  const replica = new IssueLogReplica(sessionId);
  void replica.loadTail();
  const subscribe = vi.fn();
  const close = await replica.connect({ userId: "u", workspaceId: "w", env, subscribe, unsubscribe: vi.fn() });
  cleanups.push(() => { close(); replica.disconnect(); });
  return { replica, subscribe };
}

it("the leading Issue log hydrates the following chat's reply, and its gap, into the chat", async () => {
  reads.get.mockImplementation(async (sessionId: string, params: LogWindowParams) => read(sessionId, params));
  server.set("ises_issue", [row("ises_issue", 0), row("ises_issue", 1)]);
  server.set("chat_b", [row("chat_b", 0), row("chat_b", 1, { body_md: "First" }),
    row("chat_b", 2, { author_type: "agent", body_md: "First answer" }), row("chat_b", 3, { body_md: "Second" })]);
  const env = sharedTabsEnv();
  const issue = await open(env, "ises_issue");
  await vi.waitFor(() => expect(issue.subscribe).toHaveBeenCalledWith("ises_issue", expect.any(Number)));
  const chat = await open(env, "chat_b");
  // The chat follows: the Issue log's socket subscribes for it.
  await vi.waitFor(() => expect(issue.subscribe).toHaveBeenCalledWith("chat_b", expect.any(Number)));
  expect(chat.subscribe).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(bodies(chat.replica)).toContain("Second"));

  // The second turn's reply streams in on the leader's socket.
  const reply = row("chat_b", 4, { author_type: "agent", body_md: "Second answer" });
  server.get("chat_b")!.push(reply);
  await issue.replica.hydratedFrames("chat_b", [frame(reply)]);
  await vi.waitFor(() => expect(bodies(chat.replica)).toContain("Second answer"));
  // The leader read the chat's row from the read route and kept its own log intact.
  expect(reads.get).toHaveBeenCalledWith("chat_b", { anchor: 3, after: 1 });
  expect(bodies(issue.replica)).toEqual(["ises_issue 0", "ises_issue 1"]);

  // A mid-stream gap in the chat is backfilled for the chat, not for the Issue.
  const released = row("chat_b", 5, { body_md: "Queued follow-up" });
  server.get("chat_b")!.push(released);
  await issue.replica.backfill("chat_b", { from: 5, to: 5 });
  await vi.waitFor(() => expect(bodies(chat.replica)).toContain("Queued follow-up"));
  expect(bodies(issue.replica)).toEqual(["ises_issue 0", "ises_issue 1"]);
});
