import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  reconnectDelayMs,
  WS_RECONNECT_BASE_DELAY_MS,
  WS_RECONNECT_MAX_DELAY_MS,
  WSClient,
} from "./ws-client";

/**
 * MUL-438 client acceptance: the reconnect schedule, the resume that keeps a
 * stream alive across it, the `resync` path, and the heartbeat.
 *
 * The socket double is deliberately explicit about readyState so a test can
 * decide whether a send lands — the resume rule is about *when* the client sends,
 * and a stub that always accepted the write would hide the difference between
 * "sent on reconnect" and "sent before the socket was ready".
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  sent: string[] = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }

  /** Behave like an open socket and complete the handshake. */
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  serverSend(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Simulate a drop: the client's `onclose` schedules the reconnect. */
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }

  get streamFrames() {
    return this.sent
      .map((frame) => JSON.parse(frame))
      .filter((frame) => typeof frame.type === "string" && frame.type.startsWith("stream."));
  }
}

describe("MUL-438 WSClient reconnect schedule", () => {
  it("backs off exponentially inside the documented 1s–30s envelope", () => {
    // `random()` pinned to its extremes: the floor is the base delay, the ceiling
    // is the cap, and neither can be escaped.
    expect(reconnectDelayMs(0, () => 0)).toBe(WS_RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(0, () => 1)).toBe(WS_RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(1, () => 0)).toBe(WS_RECONNECT_BASE_DELAY_MS);
    expect(reconnectDelayMs(1, () => 1)).toBe(2_000);
    expect(reconnectDelayMs(2, () => 1)).toBe(4_000);
    expect(reconnectDelayMs(3, () => 1)).toBe(8_000);
    expect(reconnectDelayMs(4, () => 1)).toBe(16_000);
    expect(reconnectDelayMs(5, () => 1)).toBe(WS_RECONNECT_MAX_DELAY_MS);
    // A long outage keeps waiting 30s rather than growing without bound.
    expect(reconnectDelayMs(50, () => 1)).toBe(WS_RECONNECT_MAX_DELAY_MS);
    // …and stays inside the envelope for every attempt.
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const random of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = reconnectDelayMs(attempt, () => random);
        expect(delay).toBeGreaterThanOrEqual(WS_RECONNECT_BASE_DELAY_MS);
        expect(delay).toBeLessThanOrEqual(WS_RECONNECT_MAX_DELAY_MS);
      }
    }
  });
});

describe("MUL-438 WSClient streams", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function connected(token = "tok"): { ws: WSClient; socket: FakeWebSocket } {
    const ws = new WSClient("ws://example.test/ws");
    ws.setAuth(token, "acme");
    ws.connect();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    // Token mode authenticates with a first frame; the server answers auth_ack.
    socket.serverSend({ type: "auth_ack" });
    return { ws, socket };
  }

  it("sends stream.subscribe once the socket is authenticated", () => {
    const { ws, socket } = connected();
    ws.subscribeStream("log", "ises_1", {});

    expect(socket.streamFrames).toEqual([
      { type: "stream.subscribe", payload: { stream: "log", id: "ises_1", from_seq: 1 } },
    ]);
  });

  it("tracks the local head and resumes from head + 1 after a reconnect", () => {
    const { ws, socket } = connected();
    const subscription = ws.subscribeStream("log", "ises_1", {});
    socket.serverSend({
      type: "stream.data",
      payload: { stream: "log", id: "ises_1", frames: [{ seq: 7, kind: "entry", payload: {} }, { seq: 9, kind: "entry", payload: {} }] },
    });
    expect(subscription.head()).toBe(9);

    // Drop and let the client reconnect on its own timer.
    socket.drop();
    vi.runOnlyPendingTimers();
    const reconnected = FakeWebSocket.instances.at(-1)!;
    reconnected.open();
    reconnected.serverSend({ type: "auth_ack" });

    expect(reconnected.streamFrames).toEqual([
      { type: "stream.subscribe", payload: { stream: "log", id: "ises_1", from_seq: 10 } },
    ]);
  });

  it("keeps the caller's anchor when nothing arrived before the drop", () => {
    const { ws, socket } = connected();
    ws.subscribeStream("log", "ises_1", {}, { fromSeq: 42 });
    expect(socket.streamFrames[0]!.payload.from_seq).toBe(42);

    socket.drop();
    vi.runOnlyPendingTimers();
    const reconnected = FakeWebSocket.instances.at(-1)!;
    reconnected.open();
    reconnected.serverSend({ type: "auth_ack" });

    // Nothing was received, so there is no local head to advance past: the
    // original anchor is still the best information the client has.
    expect(reconnected.streamFrames[0]!.payload.from_seq).toBe(42);
  });

  it("re-subscribes every active stream and re-runs the resync work on a server resync", () => {
    const { ws, socket } = connected();
    ws.subscribeStream("log", "ises_1", {});
    ws.subscribeStream("log", "ises_2", {});
    const onResync = vi.fn();
    ws.onResync(onResync);
    socket.sent.length = 0;

    socket.serverSend({ type: "resync" });

    expect(socket.streamFrames.map((frame) => frame.payload.id)).toEqual(["ises_1", "ises_2"]);
    expect(socket.streamFrames.every((frame) => frame.payload.from_seq === 1)).toBe(true);
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it("dispatches ack, frames, gap and error to the right subscription", () => {
    const { ws, socket } = connected();
    const onAck = vi.fn();
    const onFrames = vi.fn();
    const onGap = vi.fn();
    const onError = vi.fn();
    ws.subscribeStream("log", "ises_1", { onAck, onFrames, onGap, onError });
    // A second stream must not receive the first one's traffic.
    const otherFrames = vi.fn();
    ws.subscribeStream("log", "ises_2", { onFrames: otherFrames });

    socket.serverSend({
      type: "stream.ack",
      payload: { stream: "log", id: "ises_1", first_seq: 1, head_seq: 5, log_version: 2, gap: null },
    });
    socket.serverSend({
      type: "stream.data",
      payload: { stream: "log", id: "ises_1", frames: [{ seq: 5, kind: "entry", payload: {} }] },
    });
    socket.serverSend({ type: "stream.gap", payload: { stream: "log", id: "ises_1", from: 2, to: 4 } });
    socket.serverSend({ type: "stream.error", payload: { stream: "log", id: "ises_1", code: "forbidden" } });

    expect(onAck).toHaveBeenCalledWith({
      stream: "log",
      id: "ises_1",
      first_seq: 1,
      head_seq: 5,
      log_version: 2,
      gap: null,
    });
    expect(onFrames).toHaveBeenCalledTimes(1);
    expect(onFrames.mock.calls[0]![0]).toHaveLength(1);
    expect(onGap).toHaveBeenCalledWith({ stream: "log", id: "ises_1", from: 2, to: 4 });
    expect(onError).toHaveBeenCalledWith({ stream: "log", id: "ises_1", code: "forbidden" });
    expect(otherFrames).not.toHaveBeenCalled();
  });

  it("does not forward stream frames to the generic event handlers", () => {
    const { ws, socket } = connected();
    const anyHandler = vi.fn();
    ws.onAny(anyHandler);
    ws.subscribeStream("log", "ises_1", {});

    socket.serverSend({ type: "stream.data", payload: { stream: "log", id: "ises_1", frames: [] } });

    expect(anyHandler).not.toHaveBeenCalled();
  });

  it("unsubscribes on the wire and stops resuming that stream", () => {
    const { ws, socket } = connected();
    const subscription = ws.subscribeStream("log", "ises_1", {});
    socket.sent.length = 0;
    subscription.unsubscribe();

    expect(socket.streamFrames).toEqual([
      { type: "stream.unsubscribe", payload: { stream: "log", id: "ises_1" } },
    ]);
    expect(ws.streamSubscriptionCount).toBe(0);

    socket.drop();
    vi.runOnlyPendingTimers();
    const reconnected = FakeWebSocket.instances.at(-1)!;
    reconnected.open();
    reconnected.serverSend({ type: "auth_ack" });
    expect(reconnected.streamFrames).toEqual([]);
  });

  it("pings every 25s and stops when the socket closes", () => {
    const { ws, socket } = connected();
    expect(socket.sent).not.toContain(JSON.stringify({ type: "ping" }));

    vi.advanceTimersByTime(25_000);
    expect(socket.sent.filter((frame) => frame === JSON.stringify({ type: "ping" }))).toHaveLength(1);
    vi.advanceTimersByTime(25_000);
    expect(socket.sent.filter((frame) => frame === JSON.stringify({ type: "ping" }))).toHaveLength(2);

    socket.drop();
    const before = socket.sent.length;
    vi.advanceTimersByTime(120_000);
    // No ping is queued behind a closed socket; the reconnect timer is what runs.
    expect(socket.sent.length).toBe(before);
    ws.disconnect();
  });

  it("clears the stream set on disconnect", () => {
    const { ws } = connected();
    ws.subscribeStream("log", "ises_1", {});
    ws.disconnect();

    expect(ws.streamSubscriptionCount).toBe(0);
    expect(ws.hasStreamSubscription("log", "ises_1")).toBe(false);
  });
});
