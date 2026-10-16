import { describe, expect, it } from "bun:test";
import { LocalPathLocker } from "@daemon/agent-runtime/workspace/ephemeral.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("LocalPathLocker asynchronous wait notifications", () => {
  it("preserves FIFO when the holder releases before the first wait notification completes", async () => {
    const locker = new LocalPathLocker();
    const signal = new AbortController().signal;
    const releaseFirst = await locker.acquire("/project", "first", () => {}, signal);
    const notification = deferred();
    const order: string[] = [];
    const second = locker.acquire("/project", "second", () => notification.promise, signal)
      .then((release) => { order.push("second"); return release; });
    const third = locker.acquire("/project", "third", () => {}, signal)
      .then((release) => { order.push("third"); return release; });

    releaseFirst();
    await Promise.resolve();
    expect(order).toEqual([]);
    notification.resolve();
    const releaseSecond = await second;
    expect(order).toEqual(["second"]);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["second", "third"]);
    releaseThird();
  });

  for (const promote of [false, true]) {
    it(`removes a waiter whose notification fails ${promote ? "after" : "before"} promotion`, async () => {
      const locker = new LocalPathLocker();
      const signal = new AbortController().signal;
      const releaseFirst = await locker.acquire("/project", "first", () => {}, signal);
      const notification = deferred();
      const second = locker.acquire("/project", "second", () => notification.promise, signal);
      const rejected = second.catch((error: Error) => error);
      const third = locker.acquire("/project", "third", () => {}, signal);
      await Promise.resolve();
      if (promote) releaseFirst();
      notification.reject(new Error("notification failed"));
      expect(await rejected).toMatchObject({ message: "notification failed" });
      if (!promote) releaseFirst();
      const releaseThird = await third;
      releaseThird();
      const releaseNext = await locker.acquire("/project", "next", () => {}, signal);
      releaseNext();
    });

    it(`cancels a waiter with an unfinished notification ${promote ? "after" : "before"} promotion`, async () => {
      const locker = new LocalPathLocker();
      const signal = new AbortController().signal;
      const cancelled = new AbortController();
      const releaseFirst = await locker.acquire("/project", "first", () => {}, signal);
      const notification = deferred();
      const second = locker.acquire("/project", "second", () => notification.promise, cancelled.signal);
      const rejected = second.catch((error: Error) => error);
      const third = locker.acquire("/project", "third", () => {}, signal);
      await Promise.resolve();
      if (promote) releaseFirst();
      cancelled.abort();
      expect(await rejected).toMatchObject({ message: "local_directory: wait cancelled" });
      if (!promote) releaseFirst();
      const releaseThird = await third;
      notification.resolve();
      releaseThird();
      const releaseNext = await locker.acquire("/project", "next", () => {}, signal);
      releaseNext();
    });
  }
});

describe("LocalPathLocker renotify (PR 6 §2.8)", () => {
  it("tells every waiter behind a holder again, in order, and nobody else", async () => {
    const locker = new LocalPathLocker();
    const signal = new AbortController().signal;
    const releaseFirst = await locker.acquire("/project", "first", () => {}, signal);
    const releaseOther = await locker.acquire("/other", "other", () => {}, signal);
    const notices: string[] = [];
    const slow = deferred();
    let calls = 0;
    const second = locker.acquire("/project", "second", async (holder) => {
      const call = ++calls;
      if (call === 1) await slow.promise;
      notices.push(`second:${holder}:${call}`);
    }, signal);
    const third = locker.acquire("/project", "third", (holder) => { notices.push(`third:${holder}`); }, signal);
    const elsewhere = locker.acquire("/other", "elsewhere", (holder) => { notices.push(`elsewhere:${holder}`); }, signal);
    await Bun.sleep(0);
    locker.renotify("first");
    locker.renotify("nobody");
    await Bun.sleep(0);
    // The repeated notice waits for the slow first one of the same waiter.
    expect(notices).toEqual(["third:first", "elsewhere:other", "third:first"]);
    slow.resolve();
    await Bun.sleep(0);
    expect(notices).toEqual(["third:first", "elsewhere:other", "third:first", "second:first:1", "second:first:2"]);
    releaseFirst();
    const releaseSecond = await second;
    // Granted: no longer a waiter of anyone.
    locker.renotify("first");
    await Bun.sleep(0);
    expect(notices.filter((notice) => notice.startsWith("second"))).toHaveLength(2);
    releaseSecond();
    (await third)();
    releaseOther();
    (await elsewhere)();
  });

  it("survives a failing repeated notice", async () => {
    const locker = new LocalPathLocker();
    const signal = new AbortController().signal;
    const releaseFirst = await locker.acquire("/project", "first", () => {}, signal);
    let calls = 0;
    const second = locker.acquire("/project", "second", () => {
      if (++calls === 2) throw new Error("server unreachable");
    }, signal);
    await Bun.sleep(0);
    locker.renotify("first");
    await Bun.sleep(0);
    expect(calls).toBe(2);
    releaseFirst();
    (await second)();
  });
});
