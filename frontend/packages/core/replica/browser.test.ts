import { afterEach, describe, expect, test } from "vitest";
import { openBrowserReplica, type BrowserReplica } from "./browser";
import { replicaLockName } from "./channel";

const replicas: BrowserReplica[] = [];
afterEach(() => { for (const replica of replicas.splice(0)) replica.dispose(); });

test.each(["shared", "no-opfs", "no-locks"])("%s consumes minimal hidden seqs without backfill or display rows", async mode => {
  const reads: unknown[] = [];
  const replica = await openBrowserReplica({
    userId: "user", workspaceId: "ws", tabId: "tab", subscribe: () => {}, unsubscribe: () => {},
    readRange: async (_id, range) => { reads.push(range); return []; },
    env: { hasOpfs: mode !== "no-opfs", broadcastChannel: class { onmessage = null; postMessage() {} close() {} } as never,
      locks: mode === "no-locks" ? {} as never : { request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback() } as never },
  });
  replicas.push(replica);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  replica.open("session");
  replica.ack("session", { stream: "log", id: "session", first_seq: 1, head_seq: 3, log_version: 1, gap: null });
  const shown = { seq: 1, kind: "entry" as const, payload: { session_id: "session", seq: 1, revision: 1, body_md: "visible" } };
  const hidden = [2, 3].map(seq => ({ seq, kind: "entry" as const, payload: {
    session_id: "session", seq, revision: 1, visibility: "hidden",
  } }));
  replica.frames("session", [shown, ...hidden]);
  for (let n = 0; n < 24; n++) await Promise.resolve();
  expect(replica.port.getSnapshot("session")).toMatchObject({ head: 3, fresh: true, entries: [{ seq: 1 }] });
  replica.frames("session", [...hidden, { seq: 1, kind: "entry", payload: {
    session_id: "session", seq: 1, revision: 1, visibility: "hidden",
  } }]);
  replica.frames("session", [shown]);
  for (let n = 0; n < 24; n++) await Promise.resolve();
  expect(reads).toEqual([]);
  expect(replica.port.getSnapshot("session")).toMatchObject({ head: 3, fresh: true, entries: [] });
});

test("storage and degraded reflect the delayed Worker ready result", async () => {
  let deliver: ((event: MessageEvent) => void) | undefined;
  const replica = await openBrowserReplica({
    userId: "user", workspaceId: "ws", tabId: "tab", subscribe: () => {}, unsubscribe: () => {}, readRange: async () => [],
    env: { hasOpfs: true, broadcastChannel: class { onmessage = null; postMessage() {} close() {} } as never,
      locks: { request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback() } as never,
      createWorker: () => ({ postMessage() {}, terminate() {}, addEventListener: (_type, listener) => { deliver = listener; } }),
    },
  });
  replicas.push(replica);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  expect(replica.storage).toBeNull();
  deliver!({ data: { type: "ready", storage: "memory", degraded: "denied" } } as MessageEvent);
  expect(replica.storage).toBe("memory");
  expect(replica.degraded).toBe(true);
});

test.each(["shared", "no-opfs", "no-locks"])("%s fills every hole from one sparse frame batch", async (mode) => {
  const reads: Array<{ from: number; to: number }> = [];
  const replica = await openBrowserReplica({
    userId: "user", workspaceId: "ws", tabId: "tab", subscribe: () => {}, unsubscribe: () => {},
    readRange: async (_id, range) => {
      reads.push(range);
      return Array.from({ length: range.to - range.from + 1 }, (_, index) => ({
        session_id: "session", seq: range.from + index, id: `row_${range.from + index}`,
        kind: "message", revision: 1, body_md: "filled", body_html: null, render_version: null,
      }));
    },
    env: { hasOpfs: mode !== "no-opfs", broadcastChannel: class { onmessage = null; postMessage() {} close() {} } as never,
      locks: mode === "no-locks" ? {} as never : { request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback() } as never },
  });
  replicas.push(replica);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  replica.open("session");
  replica.ack("session", { stream: "log", id: "session", first_seq: 1, head_seq: 5, log_version: 1, gap: null });
  replica.frames("session", [1, 3, 5].map(seq => ({ seq, kind: "entry", payload: { session_id: "session", seq, revision: 1 } })));
  for (let n = 0; n < 24; n++) await Promise.resolve();
  expect(reads).toEqual([{ from: 2, to: 2 }, { from: 4, to: 4 }]);
  expect(replica.port.getSnapshot("session")).toMatchObject({ head: 5, fresh: true });
});

test.each([[2, 1], [1, 2]])("an ack head=%s version=%s publishes stale status and restarts a changed version", async (head, version) => {
  const subscriptions: number[] = [];
  const replica = await openBrowserReplica({
    userId: "user", workspaceId: "ws", tabId: "tab", subscribe: (_id, from) => subscriptions.push(from),
    unsubscribe: () => {}, readRange: async () => [],
    env: { hasOpfs: true, broadcastChannel: class { onmessage = null; postMessage() {} close() {} } as never,
      locks: { request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback() } as never },
  });
  replicas.push(replica);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  replica.open("session");
  const ack = { stream: "log" as const, id: "session", first_seq: 1, head_seq: 1, log_version: 1, gap: null };
  replica.ack("session", ack);
  replica.frames("session", [{ seq: 1, kind: "entry", payload: { session_id: "session", seq: 1, revision: 1, body_md: "one" } }]);
  expect(replica.port.getSnapshot("session").fresh).toBe(true);
  replica.ack("session", { ...ack, head_seq: head, log_version: version });
  expect(replica.port.getSnapshot("session").fresh).toBe(false);
  if (version === 2) expect(subscriptions).toEqual([1, 1]);
});

test("dispose lets the Web Lock callback finish and prevents a queued disposed page from starting", async () => {
  let callback: (() => Promise<void>) | undefined;
  let released = false;
  const replica = await openBrowserReplica({
    userId: "user", workspaceId: "ws", tabId: "tab", subscribe: () => {}, unsubscribe: () => {}, readRange: async () => [],
    env: { hasOpfs: true, broadcastChannel: class { onmessage = null; postMessage() {} close() {} } as never,
      locks: { request: (_name: string, _options: unknown, run: () => Promise<void>) => {
        callback = run;
        return run().then(() => { released = true; });
      } } as never },
  });
  replicas.push(replica);
  for (let n = 0; n < 8; n++) await Promise.resolve();
  expect(replica.isLeader).toBe(true);
  replica.dispose();
  for (let n = 0; n < 8; n++) await Promise.resolve();
  expect(released).toBe(true);
  await callback!();
  expect(replica.isLeader).toBe(false);
});

describe("identity partitions", () => {
  test.each([ ["other_user", "ws"], ["user", "other_ws"] ])("isolates %s/%s even when a foreign envelope reaches the receiver", async (userId, workspaceId) => {
    const channels: Array<{ name: string; onmessage: ((event: MessageEvent) => void) | null; sent: unknown[] }> = [];
    class Channel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      sent: unknown[] = [];
      constructor(readonly name: string) { channels.push(this); }
      postMessage(message: unknown) { this.sent.push(message); }
      close() {}
    }
    for (const [user, workspace] of [["user", "ws"], [userId, workspaceId]]) {
      const replica = await openBrowserReplica({
        userId: user!, workspaceId: workspace!, tabId: `${user}/${workspace}`,
        subscribe: () => {}, unsubscribe: () => {}, readRange: async () => [],
        env: { hasOpfs: true, locks: { request: () => new Promise(() => {}) } as never, broadcastChannel: Channel as never },
      });
      replicas.push(replica);
      replica.open("session");
    }
    const foreign = channels[1]!;
    expect(channels.map((channel) => channel.name)).toEqual([
      replicaLockName("user", "ws"), replicaLockName(userId, workspaceId),
    ]);
    const query = foreign.sent.find((message: any) => message.type === "replica:query") as { requestId: string };
    foreign.onmessage?.({ data: {
      type: "replica:window", requestId: query.requestId, sessionId: "session",
      identityKey: replicaLockName("user", "ws"), senderTabId: "foreign",
      entries: [{ session_id: "session", seq: 1, revision: 1, body_md: "private" }],
      snapshot: { head: 1, fresh: true, ready: true },
    } } as MessageEvent);
    expect(replicas[1]!.port.getSnapshot("session").entries).toEqual([]);
    expect(foreign.sent.every((message: any) => message.identityKey === replicaLockName(userId, workspaceId))).toBe(true);
  });
});
