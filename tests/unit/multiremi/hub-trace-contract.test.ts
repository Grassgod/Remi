/**
 * The hub's A-0 trace contract and the human-request feed (MUL-403 §2, C1).
 *
 * Two acceptance lists share this file because they share one object:
 *
 *   - **trace contract**: ordering, `gap`, no delivery after `unsubscribe`, replay
 *     and jumping sequences, several subscribers on one task, `head`/`closed` as
 *     *live* getters, and `close` for a task that was never appended to.
 *   - **human requests**: the four lifecycle transitions keyed by request id, and
 *     the rule that a process without `MULTIREMI_BACKGROUND_JOBS` does not consume.
 *
 * A-0's own `trace-sink.ts` is the reference implementation of the first list, so
 * the same cases run against both: a divergence between the hub and the shipped
 * sink is a bug in whichever one moved.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  HubImpl,
  createHub,
  type HubSubscriberSink,
} from "@multiremi/api/hub/hub-core.js";
import { createHubTraceSink, TRACE_SINK_ADAPTER_NOTES } from "@multiremi/api/hub/trace-sink-adapter.js";
import {
  attachHumanRequestFeed,
  consumesHumanRequestFeed,
  humanRequestEventType,
} from "@multiremi/api/hub/human-request-feed.js";
import { HUMAN_REQUEST_EVENT_TYPES } from "@multiremi/api/hub/live-hub.js";
import type { HumanRequestEvent } from "@multiremi/api/hub/live-hub.js";
import { createLocalHubTransport } from "@multiremi/api/hub/hub-transport.js";
import { InMemoryTraceSink } from "@multiremi/api/trace/trace-sink.js";
import type { TraceEvent } from "@multiremi/contracts/trace.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function traceEvent(seq: number, content = `t-${seq}`): TraceEvent {
  return { seq, ts: new Date(1_700_000_000_000 + seq).toISOString(), type: "text", content };
}

async function settle(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** The hub with the default timer wiring; trace cases never need the hole clock. */
function hub(): HubImpl {
  return createHub({ transport: createLocalHubTransport() });
}

// ── Trace contract, run against the hub and A-0's shipped sink ──────────────────────────────────

describe.each([
  ["hub", (): InMemoryTraceSink | HubImpl => hub()],
  ["in-memory sink (A-0 reference)", (): InMemoryTraceSink | HubImpl => new InMemoryTraceSink()],
])("trace contract: %s", (_label, build) => {
  it("delivers a continuous append to a subscriber that is already current", async () => {
    const sink = build();
    sink.append("task_a", [traceEvent(1)]);
    const seen: number[] = [];
    sink.subscribe("task_a", 1, (_taskId, events) => {
      for (const event of events) seen.push(event.seq);
    });
    sink.append("task_a", [traceEvent(2), traceEvent(3)]);
    await settle();
    expect(seen).toEqual([2, 3]);
  });

  it("replays the retained window to a subscriber that starts behind it", async () => {
    const sink = build();
    sink.append("task_a", [traceEvent(1), traceEvent(2), traceEvent(3)]);
    const seen: number[] = [];
    sink.subscribe("task_a", 0, (_taskId, events) => {
      for (const event of events) seen.push(event.seq);
    });
    await settle();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("serves a synchronous retained snapshot and never replays it on the next flush", async () => {
    const sink = build();
    sink.append("task_a", [traceEvent(1), traceEvent(2)]);
    const snapshot: number[] = [];
    sink.subscribe("task_a", 0, (_id, events) => snapshot.push(...events.map(event => event.seq))).unsubscribe();
    expect(snapshot).toEqual([1, 2]);
    const live: number[] = [];
    sink.subscribe("task_a", 0, (_id, events) => live.push(...events.map(event => event.seq)));
    expect(live).toEqual([1, 2]);
    sink.append("task_a", [traceEvent(3)]);
    await settle();
    expect(live).toEqual([1, 2, 3]);
  });

  it("stops delivering after unsubscribe", async () => {
    const sink = build();
    sink.append("task_a", [traceEvent(1)]);
    const seen: number[] = [];
    const subscription = sink.subscribe("task_a", 1, (_taskId, events) => {
      for (const event of events) seen.push(event.seq);
    });
    subscription.unsubscribe();
    sink.append("task_a", [traceEvent(2)]);
    await settle();
    expect(seen).toEqual([]);
  });

  it("fans one append out to several subscribers of the same task", async () => {
    const sink = build();
    sink.append("task_a", [traceEvent(1)]);
    const first: number[] = [];
    const second: number[] = [];
    sink.subscribe("task_a", 1, (_taskId, events) => {
      for (const event of events) first.push(event.seq);
    });
    sink.subscribe("task_a", 1, (_taskId, events) => {
      for (const event of events) second.push(event.seq);
    });
    sink.append("task_a", [traceEvent(2)]);
    await settle();
    expect(first).toEqual([2]);
    expect(second).toEqual([2]);
  });

  it("reads head and closed live rather than snapshotting them at subscribe time", async () => {
    const sink = build();
    sink.append("task_a", [traceEvent(1)]);
    const subscription = sink.subscribe("task_a", 1, () => {});
    expect(subscription.head).toBe(1);
    expect(subscription.closed).toBe(false);

    sink.append("task_a", [traceEvent(2)]);
    sink.close?.("task_a");
    await settle();

    // No re-subscribe: the getters read the sink's own state.
    expect(subscription.head).toBe(2);
    expect(subscription.closed).toBe(true);
  });

  it("closes a task that was never appended to", () => {
    const sink = build();
    const subscription = sink.subscribe("task_empty", 0, () => {});
    expect(subscription.closed).toBe(false);
    // A zero-event turn, or a cold hub that sees the completion frame before any
    // append: the flag must flip for a task with no rows behind it.
    sink.close?.("task_empty");
    expect(subscription.closed).toBe(true);
    // The contract fixes the *closed* transition, which is what this case pins. What
    // `head` answers for a task with no frames differs by implementation and is
    // pinned separately: A-0's shipping sink materializes a 0 when `close` creates
    // its state, while the hub keeps "I hold no frames" as `null` so a caller cannot
    // believe it can read events this process never received.
    if (sink instanceof HubImpl) expect(sink.head("task_empty")).toBeNull();
    else expect(sink.head("task_empty")).toBe(0);
  });

  it("answers a task it has never seen with a null head", () => {
    expect(build().head("task_never")).toBeNull();
  });

  it("drops a replayed event instead of delivering it twice", async () => {
    const sink = build();
    sink.append("task_a", [traceEvent(1), traceEvent(2)]);
    const seen: number[] = [];
    sink.subscribe("task_a", 2, (_taskId, events) => {
      for (const event of events) seen.push(event.seq);
    });
    sink.append("task_a", [traceEvent(2)]);
    await settle();
    expect(seen).toEqual([]);
  });
});

describe("trace contract: hub-specific guarantees", () => {
  it("keeps a jumping sequence in the continuity buffer instead of renumbering it", async () => {
    const sink = hub();
    const seen: number[] = [];
    sink.subscribe("task_a", 0, (_taskId, events) => {
      for (const event of events) seen.push(event.seq);
    });
    sink.append("task_a", [traceEvent(1)]);
    sink.append("task_a", [traceEvent(5)]); // 2..4 missing
    await settle();

    // The daemon's numbering is passed through untouched: the hub neither renumbers
    // the frame nor invents the missing ones.
    expect(seen).toEqual([1]);
    expect(sink.snapshot().pending_frames).toBe(1);
    expect(sink.head("task_a")).toBe(1);
  });

  it("reports the gap flag for a subscriber whose request predates the ring", () => {
    // The front of the ring is dropped by the per-stream budget, exactly as it is
    // in production; a fake trim hook would not be the same thing.
    const sink = createHub({
      transport: createLocalHubTransport(),
      limits: { ring: { streamMaxFrames: 2 } },
    });
    sink.append("task_a", [traceEvent(1), traceEvent(2), traceEvent(3), traceEvent(4)]);
    expect(sink.head("task_a")).toBe(4);

    const behind = sink.subscribe("task_a", 0, () => {});
    expect(behind.first_seq).toBe(3);
    expect(behind.gap).toBe(true);

    // A caller that is already inside the window reports no gap.
    const current = sink.subscribe("task_a", 3, () => {});
    expect(current.first_seq).toBe(3);
    expect(current.gap).toBe(false);
  });

  it("reads A-0's spelling through the keyed stream and reports no log_version", async () => {
    const sink = hub();
    const seen: number[] = [];
    sink.subscribe("task_b", 0, (_taskId, events) => {
      for (const event of events) seen.push(event.seq);
    });
    sink.append("task_b", [traceEvent(1)]);
    await settle();
    expect(seen).toEqual([1]);
    // The same stream reached through the keyed spelling: one implementation.
    const keyed = sink.subscribe("trace:task_b" as never, 1, () => {});
    expect((keyed as { log_version?: number | null }).log_version).toBeNull();
  });

  it("hands C3 and A-6 the narrow sink, with the rules stated in the module", () => {
    const sink = createHubTraceSink(hub());
    sink.append("task_a", [traceEvent(1)]);
    expect(sink.head("task_a")).toBe(1);
    const subscription = sink.subscribe("task_a", 1, () => {});
    expect(subscription.closed).toBe(false);
    sink.close?.("task_a");
    expect(subscription.closed).toBe(true);
    // Closing a task nobody appended to is the case the flag exists for.
    sink.close?.("task_empty");
    expect(sink.subscribe("task_empty", 0, () => {}).closed).toBe(true);
    // The rules the adapter exists to state are executable assertions elsewhere in
    // this file; the list itself is checked so a rule cannot be quietly dropped.
    expect(TRACE_SINK_ADAPTER_NOTES).toHaveLength(5);
    expect(TRACE_SINK_ADAPTER_NOTES.join(" ")).toContain("live getters");
    expect(TRACE_SINK_ADAPTER_NOTES.join(" ")).toContain("trace streams stay in the process");
  });
});

// ── Human requests ──────────────────────────────────────────────────────────────────────────────

describe("human request feed", () => {
  it("names the four lifecycle events and excludes reminder_due", () => {
    expect([...HUMAN_REQUEST_EVENT_TYPES]).toEqual(["created", "responded", "expired", "cancelled"]);
    expect([...HUMAN_REQUEST_EVENT_TYPES]).not.toContain("reminder_due" as never);
  });

  it("carries a store transition through as the event E5 expects", () => {
    // The store maps its own statuses (`timeout` -> `expired`) at the write path, so
    // this function is deliberately the identity: it exists as the one place the
    // wire name is decided, which is what keeps a new store status from reaching the
    // wire unclassified.
    for (const type of HUMAN_REQUEST_EVENT_TYPES) {
      expect(humanRequestEventType(type)).toBe(type);
    }
  });

  it("treats an unset or non-disabling background-jobs flag as consuming", () => {
    expect(consumesHumanRequestFeed({} as NodeJS.ProcessEnv)).toBe(true);
    expect(consumesHumanRequestFeed({ MULTIREMI_BACKGROUND_JOBS: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(consumesHumanRequestFeed({ MULTIREMI_BACKGROUND_JOBS: "on" } as NodeJS.ProcessEnv)).toBe(true);
    for (const off of ["0", "false", "no", "off", "FALSE", " 0 "]) {
      expect(consumesHumanRequestFeed({ MULTIREMI_BACKGROUND_JOBS: off } as NodeJS.ProcessEnv)).toBe(false);
    }
  });

  it("subscribes nothing when the process has background jobs off", () => {
    const store = createStore();
    const task = seedTask(store);
    const seen: HumanRequestEvent[] = [];
    const feed = attachHumanRequestFeed({
      store,
      hub: { publishHumanRequest: (event: HumanRequestEvent) => { seen.push(event); } },
      enabled: false,
    });
    expect(feed.enabled).toBe(false);

    // The real store write happens; no listener was attached, so nothing reaches
    // the hub. This is the acceptance bullet "MULTIREMI_BACKGROUND_JOBS=0 的进程
    // 不消费" exercised against the store rather than a stub.
    store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    expect(seen).toEqual([]);
    feed.detach();
  });

  it("delivers created, responded, expired and cancelled for a real store", () => {
    const store = createStore();
    const task = seedTask(store);
    const seen: HumanRequestEvent[] = [];
    const feed = attachHumanRequestFeed({
      store,
      hub: { publishHumanRequest: (event: HumanRequestEvent) => { seen.push(event); } },
      enabled: true,
    });
    expect(feed.enabled).toBe(true);

    const created = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    const responded = store.createTaskHumanRequest({ taskId: task.id, kind: "permission", payload: {} });
    const expired = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    const cancelled = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });

    // One answer only settles the task when the last pending request is gone, so a
    // single `task:running` can carry more than one request's transition: each is
    // published under its own id, which is what E5 keys on.
    store.respondTaskHumanRequest(responded.id, { response: {}, respondedBy: "mem_1" });
    store.respondTaskHumanRequest(created.id, { response: {}, respondedBy: "mem_1" });
    store.expireTaskHumanRequest(expired.id, "timeout");
    store.expireTaskHumanRequest(cancelled.id, "cancelled");
    feed.detach();

    const byRequest = new Map(seen.map((event) => [event.request_id, event.type]));
    expect(byRequest.get(created.id)).toBe("responded");
    expect(byRequest.get(responded.id)).toBe("responded");
    expect(byRequest.get(expired.id)).toBe("expired");
    expect(byRequest.get(cancelled.id)).toBe("cancelled");
    // Every event is keyed by request id and stamped with the task and workspace.
    for (const event of seen) {
      expect(event.task_id).toBe(task.id);
      expect(event.workspace_id).toBe(task.workspaceId);
      expect(event.at).toBeTruthy();
    }
    // `created` fires for a request that is still pending — the case the map above
    // cannot show, because these requests were all settled by the end.
    const createdOnly = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    const second: HumanRequestEvent[] = [];
    const feed2 = attachHumanRequestFeed({
      store,
      hub: { publishHumanRequest: (event: HumanRequestEvent) => { second.push(event); } },
      enabled: true,
    });
    store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    feed2.detach();
    expect(second.map((event) => event.type)).toEqual(["created"]);
    expect(second[0]!.request_id).not.toBe(createdOnly.id);
  });

  it("publishes each transition once, even when a settle signal repeats", () => {
    const store = createStore();
    const task = seedTask(store);
    const seen: HumanRequestEvent[] = [];
    const feed = attachHumanRequestFeed({
      store,
      hub: { publishHumanRequest: (event: HumanRequestEvent) => { seen.push(event); } },
      enabled: true,
    });
    const request = store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    store.respondTaskHumanRequest(request.id, { response: {}, respondedBy: "mem_1" });
    // A second response for a request that is no longer pending: the store refuses
    // it (first-write-wins) and emits no second transition, so the feed must not
    // invent one. The `task:running` event that follows a settled request is the
    // ambiguous signal the dedupe key exists for.
    expect(store.respondTaskHumanRequest(request.id, { response: {}, respondedBy: "mem_2" })).toBeNull();
    feed.detach();

    expect(seen.map((event) => event.type)).toEqual(["created", "responded"]);
  });

  it("stops publishing after detach", () => {
    const store = createStore();
    const task = seedTask(store);
    const seen: HumanRequestEvent[] = [];
    const feed = attachHumanRequestFeed({
      store,
      hub: { publishHumanRequest: (event: HumanRequestEvent) => { seen.push(event); } },
      enabled: true,
    });
    feed.detach();
    store.createTaskHumanRequest({ taskId: task.id, kind: "question", payload: {} });
    expect(seen).toEqual([]);
  });
});

/** A dispatched task in the seeded local workspace: the row a human request hangs off. */
function seedTask(store: ReturnType<typeof createStore>): { id: string; workspaceId: string } {
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({
    name: "Hub test runtime",
    provider: "claude",
    workspaceId: "local",
    maxConcurrency: 4,
  });
  const agent = store.createAgent({ name: "Hub test agent", provider: "claude" });
  const issue = store.createIssue({ title: "Hub human requests", workspaceId: "local" });
  const session = store.createIssueSession(issue.id, { title: "Requests" });
  const task = store.createTask({
    agentId: agent.id,
    issueId: issue.id,
    issueSessionId: session.id,
    prompt: "ask a human",
  });
  store.claimTask(runtime.id);
  return { id: task.id, workspaceId: task.workspaceId };
}

/** Keep the `HubSubscriberSink` import honest: the type is part of the module's surface. */
const sinkProbe: HubSubscriberSink = { getBufferedAmount: () => 0, send: () => {} };
describe("hub trace contract probes", () => {
  it("keeps the sink probe referenced", () => {
    expect(typeof sinkProbe.getBufferedAmount()).toBe("number");
  });
});
