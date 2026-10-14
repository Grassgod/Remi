import { describe, expect, it } from "bun:test";
import { IssueWorkspaceLifecycleLocker } from "@daemon/agent-runtime/workspace/lifecycle-lock.js";

describe("IssueWorkspaceLifecycleLocker", () => {
  it("allows shared execution and makes GC wait for every holder without writer starvation", async () => {
    const locker = new IssueWorkspaceLifecycleLocker();
    const first = await locker.acquireShared("iss_1");
    const second = await locker.acquireShared("iss_1");
    const events: string[] = [];
    const gc = locker.runExclusive("iss_1", async () => { events.push("gc"); });
    const later = locker.acquireShared("iss_1").then((release) => { events.push("later"); release(); });
    first();
    first();
    await Promise.resolve();
    expect(events).toEqual([]);
    second();
    await Promise.all([gc, later]);
    expect(events).toEqual(["gc", "later"]);
  });

  it("keeps final GC work behind the provider lifecycle for the same Issue", async () => {
    const locker = new IssueWorkspaceLifecycleLocker();
    const releaseProvider = await locker.acquire("iss_1");
    const events = ["provider-started"];

    const gc = locker.runExclusive("iss_1", async () => {
      events.push("gc-archive-and-delete");
    });
    await Promise.resolve();
    expect(events).toEqual(["provider-started"]);

    events.push("provider-exited");
    releaseProvider();
    await gc;
    expect(events).toEqual(["provider-started", "provider-exited", "gc-archive-and-delete"]);
  });

  it("does not serialize unrelated Issues", async () => {
    const locker = new IssueWorkspaceLifecycleLocker();
    const releaseFirst = await locker.acquire("iss_1");
    let secondRan = false;

    await locker.runExclusive("iss_2", async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
    releaseFirst();
  });

  describe("tryAcquire", () => {
    it("takes a free key exclusively and frees it on release", async () => {
      const locker = new IssueWorkspaceLifecycleLocker();
      const release = locker.tryAcquire("iss_1");
      expect(release).not.toBeNull();
      expect(locker.tryAcquire("iss_1")).toBeNull();
      let shared = false;
      const waiting = locker.acquireShared("iss_1").then((done) => { shared = true; done(); });
      await Promise.resolve();
      expect(shared).toBe(false);

      release!();
      release!();
      await waiting;
      expect(shared).toBe(true);
      expect(locker.tryAcquire("iss_1")).not.toBeNull();
    });

    it("never queues behind a running execution or a waiting writer", async () => {
      const locker = new IssueWorkspaceLifecycleLocker();
      const execution = await locker.acquireShared("iss_1");
      expect(locker.tryAcquire("iss_1")).toBeNull();
      execution();

      const writer = await locker.acquire("iss_1");
      const queued = locker.acquireShared("iss_1");
      writer();
      const reader = await queued;
      expect(locker.tryAcquire("iss_1")).toBeNull();
      reader();
      expect(locker.tryAcquire("iss_1")).not.toBeNull();
    });

    it("leaves other keys alone", async () => {
      const locker = new IssueWorkspaceLifecycleLocker();
      const held = await locker.acquireShared("iss_1");
      expect(locker.tryAcquire("iss_2")).not.toBeNull();
      held();
    });

    it("rejects an empty key", () => {
      expect(() => new IssueWorkspaceLifecycleLocker().tryAcquire(" ")).toThrow("ownership key");
    });
  });
});
