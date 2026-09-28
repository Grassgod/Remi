import { describe, expect, test } from "vitest";
import { ReplicaLeader } from "./leader";
import { ReplicaFollower } from "./follower";
import { ReplicaView } from "./view";
import type { ReplicaChannelMessage } from "./channel";
import type { ReplicaWorkerRequest, ReplicaWorkerResponse } from "./worker-protocol";

function leaderHarness() {
  const requests: ReplicaWorkerRequest[] = [];
  const subscriptions: number[] = [];
  const unsubs: string[] = [];
  const view = new ReplicaView();
  const leader = new ReplicaLeader({
    userId: "user", workspaceId: "ws", tabId: "tab", view,
    worker: { postMessage: (message) => requests.push(message), onMessage: () => () => {} },
    subscription: { subscribe: (_id, from) => subscriptions.push(from), unsubscribe: (id) => unsubs.push(id) },
    readRange: async () => [], broadcast: () => {},
  });
  const opened = (request: ReplicaWorkerRequest, fromSeq = 1): ReplicaWorkerResponse => ({
    ...request, type: "opened", sessionId: "session", fromSeq, head: fromSeq - 1,
    fresh: false, cleared: null, entries: [],
  });
  return { leader, requests, subscriptions, unsubs, view, opened };
}

describe("page and subscription lifetimes", () => {
  test("Worker responses need the current request token", () => {
    const h = leaderHarness(); h.leader.open("session");
    const request = h.requests.at(-1)!;
    h.leader.handleWorkerMessage({ ...h.opened(request, 4), token: undefined });
    expect(h.subscriptions).toEqual([]);
    h.leader.handleWorkerMessage(h.opened(request, 8));
    expect(h.subscriptions).toEqual([8]);
  });

  test("clear preserves a mounted page's interest for data in the new database lifetime", () => {
    const h = leaderHarness(); h.leader.open("session");
    h.leader.handleWorkerMessage(h.opened(h.requests.at(-1)!));
    h.leader.clear("logout");
    h.leader.frames("session", [{ seq: 9, kind: "entry", payload: { session_id: "session", seq: 9, revision: 1 } }]);
    expect(h.requests.at(-1)?.type).toBe("frames");
    expect(h.leader.sessions).toEqual(["session"]);
    h.leader.close("session");
    expect(h.unsubs).toEqual(["session"]);
  });

  test("a window read completes after the worker has published the write", async () => {
    const h = leaderHarness(); h.leader.open("session");
    h.leader.handleWorkerMessage(h.opened(h.requests.at(-1)!));
    let completed = false;
    const loading = h.leader.loadWindow("session", { from: 8, to: 9 }).then(() => { completed = true; });
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(completed).toBe(false);
    const write = h.requests.find(request => request.type === "writeWindow")!;
    h.leader.handleWorkerMessage({ ...write, type: "appended", sessionId: "session", entries: [],
      range: { from: 8, to: 9 }, head: 0, fresh: false, missing: null });
    await loading;
    expect(completed).toBe(true);
  });

  test("clear cancels worker replies and follower window replies from the previous database", () => {
    const h = leaderHarness(); h.leader.open("session");
    const request = h.requests.at(-1)!;
    h.leader.clear("logout");
    h.leader.handleWorkerMessage(h.opened(request, 8));
    expect(h.subscriptions).toEqual([]);
    const view = new ReplicaView();
    const follower = new ReplicaFollower({ view, broadcast: () => {}, requestWindow: () => {} });
    follower.getSnapshot("session");
    follower.handle({ type: "replica:cleared", reason: "logout" });
    follower.handle({ type: "replica:window", sessionId: "session", requestId: "req_1",
      entries: [], snapshot: { head: 8, fresh: true, ready: true } });
    expect(view.getSnapshot("session")).toMatchObject({ head: null, ready: false, fresh: false });
  });

  test("late opened after close or dispose never subscribes", () => {
    for (const action of ["close", "dispose"] as const) {
      const h = leaderHarness(); h.leader.open("session");
      const request = h.requests.at(-1)!;
      if (action === "close") h.leader.close("session"); else h.leader.dispose();
      h.leader.handleWorkerMessage(h.opened(request));
      expect(h.subscriptions).toEqual([]);
    }
  });

  test("close then reopen rejects the old opened and subscribes the new lifetime once", () => {
    const h = leaderHarness(); h.leader.open("session");
    const old = h.requests.at(-1)!;
    h.leader.close("session"); h.leader.open("session");
    const current = h.requests.at(-1)!;
    h.leader.handleWorkerMessage(h.opened(old, 4));
    h.leader.handleWorkerMessage(h.opened(current, 8));
    h.leader.handleWorkerMessage(h.opened(current, 8));
    expect(h.subscriptions).toEqual([8]);
  });

  test("follower reopens an already ready cache and receives future appends", () => {
    const view = new ReplicaView();
    const broadcasts: ReplicaChannelMessage[] = [];
    const queries: unknown[] = [];
    const follower = new ReplicaFollower({ view, broadcast: (m) => broadcasts.push(m), requestWindow: (q) => queries.push(q) });
    follower.getSnapshot("session");
    view.setWindow("session", [], { head: 3, fresh: true, ready: true });
    follower.close("session");
    // Explicit open belongs to the page handle, independent of cached readiness.
    (follower as unknown as { open(id: string): void }).open("session");
    follower.handle({ type: "replica:appended", sessionId: "session", head: 4, fresh: true, range: { from: 4, to: 4 } });
    expect(broadcasts.filter((m) => m.type === "replica:open")).toHaveLength(2);
    expect(queries).toHaveLength(3);
  });
});
