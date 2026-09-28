import { afterEach, describe, expect, test } from "vitest";
import { openBrowserReplica, type BrowserReplica } from "./browser";
import { replicaLockName } from "./channel";

const replicas: BrowserReplica[] = [];
afterEach(() => { for (const replica of replicas.splice(0)) replica.dispose(); });

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
