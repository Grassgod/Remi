import { describe, expect, it } from "bun:test";
import { subscribeFeishuTask } from "../../../apps/remi/cli/multiremi.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import type { FeishuBotTaskSnapshot } from "@multiremi/contracts/types.js";
import type { DaemonProtocolClient } from "@multiremi/worker/daemon-protocol-client.js";
import { DaemonTraceSubscriptions } from "@multiremi/worker/trace-subscriptions.js";
import { FeishuCotTimeline } from "@connectors/feishu/cot-timeline.js";

const event = (seq: number): TraceEvent => ({ seq, ts: "2026-09-28T00:00:00Z", type: "thinking", content: `event ${seq}` });

function fixture(initial: TraceEvent[] = [], initiallyClosed = false) {
  let connected = true, subscribed = false, closed = initiallyClosed, snapshotReads = 0;
  const events = [...initial];
  const requests: Array<{ type: string; payload: Record<string, any> }> = [];
  const frames = new Set<(frame: any) => unknown>();
  const welcomes = new Set<() => void>();
  const push = async (batch: TraceEvent[], done: boolean) => {
    await Promise.all([...frames].map(listener => listener({ type: "trace.push", payload: { task_id: "task", events: batch, closed: done } })));
  };
  const protocol = {
    connectionState: () => connected ? "connected" : "disconnected",
    onFrame: (listener: (frame: any) => unknown) => { frames.add(listener); return () => { frames.delete(listener); }; },
    onWelcome: (listener: () => void) => { welcomes.add(listener); return () => { welcomes.delete(listener); }; },
    rpc: async (type: string, payload: Record<string, any>) => {
      requests.push({ type, payload });
      if (type === "trace.subscribe") {
        subscribed = true;
        queueMicrotask(() => { void push(events.filter(event => event.seq > payload.from_seq), closed); });
        return { head: events.at(-1)?.seq ?? 0, gap: false };
      }
      if (type === "trace.unsubscribe") { subscribed = false; return {}; }
      if (type === "trace.fetch") return { events: events.filter(event => event.seq > payload.after_seq), eof: true, closed };
      throw new Error(`Unexpected RPC ${type}`);
    },
  } as unknown as DaemonProtocolClient;
  const errors: unknown[] = [];
  const subscriptions = new DaemonTraceSubscriptions(protocol, () => "runtime", error => { errors.push(error); });
  const daemon = {
    subscribeTrace: subscriptions.subscribeTrace.bind(subscriptions),
    getFeishuBotTaskSnapshot: async () => {
      snapshotReads++;
      return { taskId: "task", status: "completed", result: "done", error: null, sessionId: "session", workDir: null, usage: [] } satisfies FeishuBotTaskSnapshot;
    },
  };
  return { daemon, requests, errors, subscriptions, push,
    get snapshotReads() { return snapshotReads; },
    disconnect: () => { connected = false; subscribed = false; },
    reconnect: () => { connected = true; for (const listener of welcomes) listener(); },
    append: async (batch: TraceEvent[]) => { events.push(...batch); if (connected && subscribed) await push(batch, false); },
    close: async () => { closed = true; if (connected && subscribed) await push([], true); },
  };
}

async function collect(stream: AsyncIterable<TaskStreamEvent>): Promise<TaskStreamEvent[]> {
  return await Array.fromAsync(stream);
}

async function waitUntil(predicate: () => boolean) {
  const end = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("Subscription did not advance");
    await Bun.sleep(1);
  }
}

describe("Feishu trace subscription", () => {
  it("resumes from the consumed checkpoint, starting at throughSeq + 1 without duplicates or omissions", async () => {
    const f = fixture([1, 2, 3, 4, 5, 6].map(event), true);
    try {
      const received = await collect(subscribeFeishuTask(f.daemon, "task", AbortSignal.timeout(500), 3));
      expect(received.filter(item => item.kind === "message").map(item => item.message.seq)).toEqual([4, 5, 6]);
      expect(f.requests[0]).toEqual({ type: "trace.subscribe", payload: { task_id: "task", from_seq: 3 } });
      expect(f.requests.map(request => request.type)).toEqual(["trace.subscribe", "trace.unsubscribe"]);
      expect(f.snapshotReads).toBe(1);
      expect(f.errors).toEqual([]);
    } finally { await f.subscriptions.stop(); }
  });

  it("keeps the subscription open while idle and resumes after disconnect using the last consumed sequence", async () => {
    const f = fixture([event(1), event(2)]);
    const seen: TraceEvent[] = [];
    const controller = new AbortController();
    const done = (async () => { for await (const item of subscribeFeishuTask(f.daemon, "task", controller.signal)) {
      if (item.kind === "message") seen.push(item.message);
    } })();
    try {
      await waitUntil(() => seen.length === 2);
      expect(f.snapshotReads).toBe(0);
      f.disconnect();
      await f.append([event(3), event(4)]);
      f.reconnect();
      await waitUntil(() => seen.length === 4);
      await f.push([event(2), event(3), event(4)], false);
      expect(seen.map(item => item.seq)).toEqual([1, 2, 3, 4]);
      expect(f.requests.filter(request => request.type === "trace.subscribe").map(request => request.payload.from_seq)).toEqual([0, 2]);
      await f.close();
      await done;
      expect(f.snapshotReads).toBe(1);
    } finally { controller.abort(); await done.catch(() => {}); await f.subscriptions.stop(); }
  });

  it("lets closed finish an empty event stream and releases the subscription", async () => {
    const f = fixture([], true);
    try {
      const received = await collect(subscribeFeishuTask(f.daemon, "task", AbortSignal.timeout(150), 7));
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ kind: "snapshot", snapshot: { status: "completed" } });
      expect(f.requests.at(-1)?.type).toBe("trace.unsubscribe");
    } finally { await f.subscriptions.stop(); }
  });

  it("passes an unknown type and every payload field unchanged through the connector and timeline", async () => {
    const unknown: TraceEvent = { seq: 1, ts: "2026-09-28T01:02:03Z", type: "future.widget", tool: "opaque", tool_call_id: "future-1",
      content: "literal content", input: { nested: [1, { two: true }] }, output: "raw output", status: "new status", meta: { arbitrary: "value" } };
    const f = fixture([unknown], true);
    try {
      const received = await collect(subscribeFeishuTask(f.daemon, "task", AbortSignal.timeout(500)));
      expect(received[0]).toEqual({ kind: "message", message: unknown });
      if (received[0]?.kind !== "message") throw new Error("Expected the original trace event");
      expect(received[0].message).toBe(unknown);
      const timeline = new FeishuCotTimeline("task");
      timeline.accept(received[0].message);
      expect(timeline.drain(true)).toEqual({ samples: [[unknown.type, { ...unknown }]], throughSeq: 1 });
    } finally { await f.subscriptions.stop(); }
  });

  it("aborts an idle subscription promptly without any status reads", async () => {
    const f = fixture();
    const controller = new AbortController();
    const done = collect(subscribeFeishuTask(f.daemon, "task", controller.signal));
    try {
      await waitUntil(() => f.requests.length === 1);
      controller.abort(new Error("lease lost"));
      await expect(done).rejects.toThrow("lease lost");
      expect(f.snapshotReads).toBe(0);
      expect(f.requests.at(-1)?.type).toBe("trace.unsubscribe");
    } finally { await f.subscriptions.stop(); }
  });
});
