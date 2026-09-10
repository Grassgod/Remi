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
});
