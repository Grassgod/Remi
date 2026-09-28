import { describe, expect, it } from "bun:test";
import {
  HUB_FRAME_KINDS,
  HUB_LOG_STREAM_PREFIX,
  HUB_TRACE_STREAM_PREFIX,
  hubLogStreamKey,
  hubTraceStreamKey,
  parseHubStreamKey,
} from "@multiremi/contracts/live-hub";
import type {
  BrowserWsClientFrame,
  BrowserWsClientFrameType,
  BrowserWsServerFrame,
  BrowserWsServerFrameType,
  HubFrame,
  HubFrameListener,
  HubSeqRange,
  HubStreamAckPayload,
  HubStreamDataPayload,
  HubStreamGapPayload,
  HubStreamKey,
  HubSubscription,
} from "@multiremi/contracts/live-hub";
import {
  EMPTY_LIVE_HUB_ALIGNMENT_NOTES,
  EmptyLiveHub,
  HUMAN_REQUEST_EVENT_TYPES,
  createEmptyLiveHub,
} from "@multiremi/api/hub/live-hub";
import type {
  B0ConversationLogEntry,
  ConversationLogListener,
  ConversationLogPatch,
  HumanRequestEvent,
  LiveHub,
} from "@multiremi/api/hub/live-hub";
// A-0's real modules: `43e41952` is merged into this branch, so these are the
// upstream signatures themselves rather than a transcription to compare against.
import type { TraceEvent } from "@multiremi/contracts/trace";
import type {
  TraceSink,
  TraceSinkListener,
  TraceSinkSubscription,
} from "@multiremi/api/trace/trace-sink";
import {
  HUB_TRANSPORT_KINDS,
  LocalHubTransport,
  createLocalHubTransport,
} from "@multiremi/api/hub/hub-transport";
import type { HubTransport } from "@multiremi/api/hub/hub-transport";

/**
 * C0 is contracts and an empty skeleton, so most of what it promises is a shape,
 * not behaviour. These probes are erased at runtime and fail `tsc --noEmit` the
 * moment a signature drifts — the same technique `tests/arch/package-boundaries`
 * uses for the plugin-sdk mirror. The runtime assertions below then pin the few
 * facts that are values rather than types.
 */

// ── A-0 compatibility: the hub satisfies the published TraceSink seam ───────────────────────────

/** A-0 `TraceEvent`: `ts` is an ISO string and `type` is an open string. */
function a0TraceEvent(seq: number): TraceEvent {
  return {
    seq,
    ts: new Date(1_700_000_000_000 + seq).toISOString(),
    type: "text",
    content: `event-${seq}`,
  };
}

/** An event whose `type` no enum lists, to prove it passes through verbatim. */
function unknownTypeEvent(seq: number, type: string): TraceEvent {
  return { seq, ts: new Date(1_700_000_000_000 + seq).toISOString(), type, content: "x" };
}

/** The wiring C1/A-6 use: the hub is handed to a consumer of A-0's `TraceSink`. */
function consumeTraceSink(sink: TraceSink): { head: number | null } {
  return { head: sink.head("task_a") };
}

function traceSinkShape(hub: LiveHub): {
  appended: { head: number };
  head: number | null;
  subscription: TraceSinkSubscription;
} {
  return {
    appended: hub.append("task_a", [a0TraceEvent(1)]),
    head: hub.head("task_a"),
    subscription: hub.subscribe("task_a", 0, (_taskId, _events) => {}),
  };
}

/**
 * A-0's subscription carries `closed` as well as `gap`, and both `gap` and the
 * getter-backed fields must be present. Reading them through the upstream type
 * (rather than a local restatement) is what makes a drift a compile error.
 */
function a0SubscriptionProbe(hub: LiveHub): {
  gap: boolean;
  closed: boolean;
  head: number;
} {
  const subscription: TraceSinkSubscription = hub.subscribe("task_a", 0, (_taskId, _events) => {});
  return { gap: subscription.gap, closed: subscription.closed, head: subscription.head };
}

// ── The keyed subscription is the browser/A-6 shape ─────────────────────────────────────────────

function keyedSubscriptionProbe(hub: LiveHub): {
  first_seq: number;
  head: number;
  log_version: number | null | undefined;
  gap: HubSeqRange | null | undefined;
} {
  const subscription: HubSubscription = hub.subscribe(
    "log:session_a",
    12,
    (_key, _frames) => {},
  );
  return {
    first_seq: subscription.first_seq,
    head: subscription.head,
    log_version: subscription.log_version,
    gap: subscription.gap,
  };
}

// ── B1 compatibility: the hub satisfies the write hook's listener ───────────────────────────────

function consumeConversationLogListener(listener: ConversationLogListener): void {
  const entry: B0ConversationLogEntry = {
    session_id: "ises_1",
    seq: 7,
    kind: "message",
    visibility: "shown",
    revision: 1,
  };
  const patch: ConversationLogPatch = {
    session_id: "ises_1",
    target_seq: 7,
    revision: 2,
    fields: { body_md: "edited" },
  };
  listener.onEntry(entry.session_id, entry);
  listener.onEntry(patch.session_id, patch);
}

// ── MUL-400 E5 reaches the human-request feed through the same object ───────────────────────────

function consumeHumanRequests(hub: LiveHub): HumanRequestEvent[] {
  const seen: HumanRequestEvent[] = [];
  const handle: { unsubscribe(): void } = hub.subscribeHumanRequests("ws_1", (event) => {
    seen.push(event);
  });
  handle.unsubscribe();
  return seen;
}

describe("live hub contract", () => {
  it("addresses the two streams by their documented prefixes", () => {
    expect(HUB_LOG_STREAM_PREFIX).toBe("log:");
    expect(HUB_TRACE_STREAM_PREFIX).toBe("trace:");
    expect(hubLogStreamKey("ises_1")).toBe("log:ises_1");
    expect(hubTraceStreamKey("tsk_1")).toBe("trace:tsk_1");
  });

  it("parses a stream key into kind and id, and rejects anything without a known prefix", () => {
    expect(parseHubStreamKey("log:chat_1")).toEqual({ stream: "log", id: "chat_1" });
    expect(parseHubStreamKey("trace:tsk_1")).toEqual({ stream: "trace", id: "tsk_1" });
    // An id with no prefix, an empty id and a near-miss prefix are all errors, not
    // a silent guess at the stream kind.
    expect(parseHubStreamKey("tsk_1")).toBeNull();
    expect(parseHubStreamKey("log:")).toBeNull();
    expect(parseHubStreamKey("trace")).toBeNull();
    expect(parseHubStreamKey("logs:ises_1")).toBeNull();
  });

  it("keeps the three frame kinds in the order the plan fixed", () => {
    expect([...HUB_FRAME_KINDS]).toEqual(["entry", "patch", "trace"]);
  });

  it("carries exactly the four human-request lifecycle events E5 consumes", () => {
    expect([...HUMAN_REQUEST_EVENT_TYPES]).toEqual([
      "created",
      "responded",
      "expired",
      "cancelled",
    ]);
    // `reminder_due` stays on the bot host's timer, so it must never appear here.
    expect(HUMAN_REQUEST_EVENT_TYPES).not.toContain("reminder_due" as never);
  });

  it("names the frames of the browser v2 protocol without restating the auth handshake", () => {
    const clientFrames: BrowserWsClientFrameType[] = ["stream.subscribe", "stream.unsubscribe", "ping"];
    const serverFrames: BrowserWsServerFrameType[] = [
      "stream.ack",
      "stream.data",
      "stream.gap",
      "stream.error",
      "pong",
    ];
    expect(clientFrames).toHaveLength(3);
    expect(serverFrames).toHaveLength(5);
    // The handshake is untouched by v2: C3 adds frames, it does not re-key auth.
    expect([...clientFrames, ...serverFrames]).not.toContain("auth" as never);
    expect([...clientFrames, ...serverFrames]).not.toContain("auth_ack" as never);
  });

  it("keeps local fan-out inert when peer transport is available", () => {
    expect([...HUB_TRANSPORT_KINDS]).toEqual(["local", "peer"]);
    const transport: HubTransport = createLocalHubTransport();
    expect(transport.kind).toBe("local");
    expect(transport.healthy?.()).toBe(true);
    // Publishing locally is a no-op and must stay cheap: the hub owns local fan-out.
    const seen: string[] = [];
    const handle = transport.subscribe((input) => seen.push(input.key));
    transport.publish({ key: "trace:tsk_1", frames: [{ seq: 1, kind: "trace", payload: null }] });
    handle.unsubscribe();
    expect(seen).toEqual([]);
    transport.close();
    expect(transport.healthy?.()).toBe(false);
  });

  it("records that A-0 is aligned and B0 is still pending", () => {
    const notes = EMPTY_LIVE_HUB_ALIGNMENT_NOTES.join("\n");
    // A-0's final commit, and the fact that no stand-in is left for it. The
    // superseded 5fa2a3e must not come back: it is the transcription this
    // revision replaced.
    expect(notes).toContain("43e41952");
    expect(notes).toContain("A-0 aligned");
    expect(notes).not.toContain("5fa2a3e2");
    // B0 is still hand-written, and the note names the commit it was written from.
    expect(notes).toContain("B0 pending");
    expect(notes).toContain("fe7810c9");
  });
});

describe("EmptyLiveHub", () => {
  it("answers every call with the empty-but-well-formed shape", () => {
    const hub = createEmptyLiveHub(createLocalHubTransport());

    // A-0 spelling: no ring, so the head is null and nothing was appended.
    expect(hub.head("task_a")).toBeNull();
    expect(hub.append("task_a", [a0TraceEvent(1)])).toEqual({ head: 0 });

    const keyed = hub.subscribe("trace:task_a", 4, () => {});
    expect(keyed.first_seq).toBe(1);
    expect(keyed.head).toBe(0);
    expect(keyed.gap).toBeNull();
    expect(keyed.log_version).toBeNull();

    const logKeyed = hub.subscribe("log:ises_1", 0, () => {});
    expect(logKeyed.first_seq).toBe(1);
    expect(logKeyed.head).toBe(0);

    const sinkSub = hub.subscribe("task_a", 0, () => {});
    // A-0's shape: `closed` is part of it, and `head`/`closed` are getters rather
    // than snapshot properties, so `toEqual` on the object is not how to read it.
    expect(sinkSub.first_seq).toBe(1);
    expect(sinkSub.head).toBe(0);
    expect(sinkSub.gap).toBe(false);
    expect(sinkSub.closed).toBe(false);
    expect(typeof sinkSub.unsubscribe).toBe("function");

    // The handles are inert but real, so a caller's cleanup path is exercised.
    expect(() => keyed.unsubscribe()).not.toThrow();
    expect(() => sinkSub.unsubscribe()).not.toThrow();
    expect(() => hub.onEntry("ises_1", {
      session_id: "ises_1",
      seq: 1,
      kind: "message",
      visibility: "shown",
      revision: 1,
    })).not.toThrow();
    const human = hub.subscribeHumanRequests("ws_1", () => {});
    expect(() => human.unsubscribe()).not.toThrow();
  });

  it("has the hub's transport injected, so C2 can swap in a cross-process adapter", () => {
    const transport = new LocalHubTransport();
    const hub = new EmptyLiveHub(transport);
    expect(hub.transport).toBe(transport);
    expect(hub.transport.kind).toBe("local");
  });

  it("is structurally usable where A-0's TraceSink and B1's listener are expected", () => {
    const hub = createEmptyLiveHub(createLocalHubTransport());
    // Same probes as above, executed so the erased type-level assertions have a
    // runtime companion and the file fails loudly rather than at lint time.
    expect(consumeTraceSink(hub)).toEqual({ head: null });
    expect(traceSinkShape(hub).appended).toEqual({ head: 0 });
    expect(a0SubscriptionProbe(hub)).toEqual({ gap: false, closed: false, head: 0 });
    expect(keyedSubscriptionProbe(hub)).toEqual({
      first_seq: 1,
      head: 0,
      log_version: null,
      gap: null,
    });
    expect(() => consumeConversationLogListener(hub)).not.toThrow();
    expect(consumeHumanRequests(hub)).toEqual([]);
  });

  it("tells the two subscription spellings apart by key shape, not by caller intent", () => {
    const hub = createEmptyLiveHub(createLocalHubTransport());
    // `trace:<id>` is a stream key and gets the keyed shape…
    const keyed = hub.subscribe("trace:task_a", 0, () => {});
    expect(keyed).toHaveProperty("log_version", null);
    expect(keyed.gap).toBeNull();
    // …and a bare id is A-0's spelling and gets the sink shape. The two differ on
    // purpose: A-0's `gap` is a boolean and may not be widened.
    const sink = hub.subscribe("task_a", 0, () => {});
    expect(sink.gap).toBe(false);
    expect(sink).not.toHaveProperty("log_version");
  });

  it("flips `closed` for a task it never appended to, read live through the getter", () => {
    // `isClosed` is on the empty implementation, not on `LiveHub`: C1's hub keeps
    // its retention state internally, so the interface stays the A-0/B1 surface.
    const hub = new EmptyLiveHub(createLocalHubTransport());
    // A zero-event turn, or a cold hub that sees the completion frame before any
    // `trace.append`: A-0 says a later subscriber must still see `closed: true`.
    const subscriber = hub.subscribe("task_empty", 0, () => {});
    expect(subscriber.closed).toBe(false);

    expect(hub.head("task_empty")).toBeNull();
    hub.close?.("task_empty");

    // The getter reads live state, so a subscription created *before* the close
    // already reports it — no re-subscribe needed.
    expect(subscriber.closed).toBe(true);
    expect(hub.isClosed("task_empty")).toBe(true);
    // Closing is per task and does not leak to a sibling.
    expect(hub.isClosed("task_other")).toBe(false);
    // A-0 types `close` as optional, so callers must guard it; this hub implements it.
    expect(typeof hub.close).toBe("function");
  });

  it("carries an unknown `type` through untouched instead of normalizing it", () => {
    const hub = createEmptyLiveHub(createLocalHubTransport());
    // `TraceEvent.type` is an open string (MUL-402 ruling 1). The 13 known values
    // are for enumeration and bucketing, not validation, so the hub must not be
    // the layer that drops or rewrites a type it has not seen.
    const exotic = unknownTypeEvent(1, "some_future_type");
    expect(exotic.type).toBe("some_future_type");
    expect(() => hub.append("task_a", [exotic])).not.toThrow();
  });

  it("never fabricates a sequence for a caller", () => {
    const hub = createEmptyLiveHub(createLocalHubTransport());
    // The one invariant A-0 restates: the sequence belongs to the daemon. An
    // empty hub must not answer with a head it invented from the caller's input.
    const big = hub.append("task_a", [a0TraceEvent(900_000)]);
    expect(big.head).toBe(0);
    expect(hub.subscribe("task_a", 899_999, () => {}).head).toBe(0);
  });
});

/**
 * Probes whose only job is to make the erased type imports real. Without them
 * `tsc` reports unused imports and the type-level half of this file silently
 * stops being checked.
 */
const typeOnlyProbes = {
  frame: null as unknown as HubFrame,
  frameListener: null as unknown as HubFrameListener,
  streamKey: null as unknown as HubStreamKey,
  subscription: null as unknown as HubSubscription,
  ack: null as unknown as HubStreamAckPayload,
  data: null as unknown as HubStreamDataPayload,
  gap: null as unknown as HubStreamGapPayload,
  clientFrame: null as unknown as BrowserWsClientFrame,
  serverFrame: null as unknown as BrowserWsServerFrame,
  traceListener: null as unknown as TraceSinkListener,
  traceSink: null as unknown as TraceSink,
};

describe("live hub contract probes", () => {
  it("keeps the erased type probes referenced", () => {
    expect(Object.keys(typeOnlyProbes)).toHaveLength(11);
  });
});
