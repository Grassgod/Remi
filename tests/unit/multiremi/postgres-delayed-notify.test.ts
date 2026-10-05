import { expect, it } from "bun:test";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";

it("waits for the current PostgreSQL reply after a previous request's delayed notify", () => {
  const NativeWorker = globalThis.Worker;
  const fixture = new URL("./fixtures/postgres-delayed-notify-worker.ts", import.meta.url);
  class DelayedNotifyWorker extends NativeWorker {
    constructor() { super(fixture.href); }
    override postMessage(message: any): void {
      super.postMessage(message);
      if (!message.init) return;
      const ctl = new Int32Array(message.control);
      const deadline = performance.now() + 2_000;
      // Ensure initialization sees DONE before Atomics.wait, leaving its
      // notification to be delivered while the real query is waiting.
      while (Atomics.load(ctl, 0) === 0) {
        if (performance.now() >= deadline) throw new Error("Worker initialization timed out");
        Atomics.wait(ctl, 0, 0, 5);
      }
    }
  }
  let db: PostgresSyncDatabase | undefined;
  globalThis.Worker = DelayedNotifyWorker;
  try {
    db = new PostgresSyncDatabase("postgres://isolated-notification-fixture");
    expect(db.query("SELECT 42 AS value").get()).toEqual({ value: 42 });
  } finally {
    db?.close();
    globalThis.Worker = NativeWorker;
  }
});
