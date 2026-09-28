import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TraceSocket,
  deriveTraceWsUrl,
  setTraceClientFactoryForTesting,
} from "./trace-socket";
import type { WSClient } from "./ws-client";

/**
 * MUL-438 client acceptance: 「执行过程」 opens a socket only when it is opened.
 *
 * The factory records every client it builds, so "lazy" is asserted directly —
 * not inferred from a rendered component.
 */
interface FakeClient {
  connectCalls: number;
  disconnectCalls: number;
  subscriptions: Array<{ stream: string; id: string; unsubscribed: boolean }>;
}

function installFactory(): { clients: FakeClient[] } {
  const clients: FakeClient[] = [];
  setTraceClientFactoryForTesting(() => {
    const client: FakeClient = { connectCalls: 1, disconnectCalls: 0, subscriptions: [] };
    clients.push(client);
    return {
      subscribeStream(stream: string, id: string) {
        const record = { stream, id, unsubscribed: false };
        client.subscriptions.push(record);
        return {
          stream,
          id,
          head: () => 0,
          unsubscribe: () => { record.unsubscribed = true; },
        };
      },
      disconnect() { client.disconnectCalls += 1; },
    } as unknown as WSClient;
  });
  return { clients };
}

afterEach(() => {
  setTraceClientFactoryForTesting(null);
});

describe("MUL-438 TraceSocket laziness", () => {
  it("builds no socket until the first subscription", () => {
    const { clients } = installFactory();
    const socket = new TraceSocket({ url: "ws://example.test/api/trace/ws", workspaceSlug: "acme" });

    expect(clients).toHaveLength(0);
    expect(socket.connected).toBe(false);

    socket.subscribe("tsk_1", {});
    expect(clients).toHaveLength(1);
    expect(socket.connected).toBe(true);
    expect(clients[0]!.subscriptions).toEqual([{ stream: "trace", id: "tsk_1", unsubscribed: false }]);
  });

  it("reuses one socket for several tasks and closes it with the last unsubscribe", () => {
    const { clients } = installFactory();
    const socket = new TraceSocket({ url: "ws://example.test/api/trace/ws", workspaceSlug: "acme" });

    const first = socket.subscribe("tsk_1", {});
    const second = socket.subscribe("tsk_2", {});
    expect(clients).toHaveLength(1);
    expect(socket.subscriptionCount).toBe(2);

    first.unsubscribe();
    expect(clients[0]!.disconnectCalls).toBe(0);
    expect(socket.connected).toBe(true);

    second.unsubscribe();
    expect(clients[0]!.disconnectCalls).toBe(1);
    expect(socket.connected).toBe(false);
    expect(socket.subscriptionCount).toBe(0);
  });

  it("opens a fresh socket after the previous one closed", () => {
    const { clients } = installFactory();
    const socket = new TraceSocket({ url: "ws://example.test/api/trace/ws", workspaceSlug: "acme" });

    socket.subscribe("tsk_1", {}).unsubscribe();
    socket.subscribe("tsk_1", {});
    expect(clients).toHaveLength(2);
    expect(socket.connected).toBe(true);
    socket.close();
    expect(socket.connected).toBe(false);
  });

  it("closing tears down every stream it still holds", () => {
    const { clients } = installFactory();
    const socket = new TraceSocket({ url: "ws://example.test/api/trace/ws", workspaceSlug: "acme" });
    socket.subscribe("tsk_1", {});
    socket.subscribe("tsk_2", {});

    socket.close();

    expect(clients[0]!.subscriptions.every((entry) => entry.unsubscribed)).toBe(true);
    expect(clients[0]!.disconnectCalls).toBe(1);
    expect(socket.subscriptionCount).toBe(0);
  });

  it("refuses a duplicate subscription for the same task", () => {
    installFactory();
    const socket = new TraceSocket({ url: "ws://example.test/api/trace/ws", workspaceSlug: "acme" });
    socket.subscribe("tsk_1", {});
    expect(() => socket.subscribe("tsk_1", {})).toThrow(/already subscribed/);
  });

  it("is safe to close twice and to unsubscribe twice", () => {
    const { clients } = installFactory();
    const socket = new TraceSocket({ url: "ws://example.test/api/trace/ws", workspaceSlug: "acme" });
    const subscription = socket.subscribe("tsk_1", {});
    subscription.unsubscribe();
    subscription.unsubscribe();
    socket.close();
    socket.close();
    expect(clients[0]!.disconnectCalls).toBe(1);
  });
});

describe("MUL-438 deriveTraceWsUrl", () => {
  it("moves the path of the main socket to the trace endpoint and drops the query", () => {
    expect(deriveTraceWsUrl("ws://example.test/ws")).toBe("ws://example.test/api/trace/ws");
    expect(deriveTraceWsUrl("wss://example.test/ws?workspace_slug=acme")).toBe("wss://example.test/api/trace/ws");
  });

  it("falls back to the documented path for a URL it cannot parse", () => {
    expect(deriveTraceWsUrl("/ws")).toBe("/api/trace/ws");
  });
});
