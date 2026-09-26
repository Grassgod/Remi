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
  A0TraceEvent,
  A0TraceSink,
  A0TraceSinkListener,
  A0TraceSinkSubscription,
  B0ConversationLogEntry,
  ConversationLogListener,
  ConversationLogPatch,
  HumanRequestEvent,
  LiveHub,
} from "@multiremi/api/hub/live-hub";
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

function a0TraceEvent(seq: number): A0TraceEvent {
  return { seq, ts: 1_700_000_000_000 + seq, type: "text", content: `event-${seq}` };
}

/** The wiring C1/A-6 use: the hub is handed to a consumer of A-0's `TraceSink`. */
function consumeTraceSink(sink: A0TraceSink): { head: number | null } {
  return { head: sink.head("task_a") };
}

function traceSinkShape(hub: LiveHub): {
  appended: { head: number };
  head: number | null;
  subscription: A0TraceSinkSubscription;
} {
  return {
    appended: hub.append("task_a", [a0TraceEvent(1)]),
    head: hub.head("task_a"),
    subscription: hub.subscribe("task_a", 0, (_taskId, _events) => {}),
  };
}

/** The sink subscription keeps A-0's boolean `gap`, not the keyed range. */
function a0SubscriptionProbe(hub: LiveHub): boolean {
  return hub.subscribe("task_a", 0, (_taskId, _events) => {}).gap;
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

  it("only ships the local transport adapter, and it reports itself as such", () => {
    expect([...HUB_TRANSPORT_KINDS]).toEqual(["local"]);
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

  it("says out loud which upstream commits the hand-written seams must be replaced by", () => {
    // Both upstream contracts are off-branch at C0; if these notes disappear
    // without the imports changing, the alignment promise was quietly dropped.
    expect(EMPTY_LIVE_HUB_ALIGNMENT_NOTES.join("\n")).toContain("5fa2a3e2");
    expect(EMPTY_LIVE_HUB_ALIGNMENT_NOTES.join("\n")).toContain("fe7810c9");
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
    expect(sinkSub).toEqual({ first_seq: 1, head: 0, gap: false, unsubscribe: expect.any(Function) });

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
    expect(a0SubscriptionProbe(hub)).toBe(false);
    expect(keyedSubscriptionProbe(hub)).toEqual({
      first_seq: 1,
      head: 0,
      log_version: null,
      gap: null,
    });
    expect(() => consumeConversationLogListener(hub)).not.toThrow();
    expect(consumeHumanRequests(hub)).toEqual([]);
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
  traceListener: null as unknown as A0TraceSinkListener,
};

describe("live hub contract probes", () => {
  it("keeps the erased type probes referenced", () => {
    expect(Object.keys(typeOnlyProbes)).toHaveLength(10);
  });
});
