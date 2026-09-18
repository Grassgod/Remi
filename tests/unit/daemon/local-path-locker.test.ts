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
