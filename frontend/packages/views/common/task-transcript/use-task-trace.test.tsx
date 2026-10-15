import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { StreamSubscriptionHandlers } from "@multiremi/core/api/ws-client";
import { command, event, message, read, traceTurn, turnPage } from "../../test/trace-fixtures";
import { turnTraceKey, useTurnTrace } from "./use-task-trace";

const { getTaskTrace, consumer } = vi.hoisted(() => ({ getTaskTrace: vi.fn(),
  consumer: { callbacks: {} as StreamSubscriptionHandlers, enabled: false, options: undefined as { fromSeq?: number } | undefined } }));
vi.mock("@multiremi/core/api", async original => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: (_id: string, callbacks: StreamSubscriptionHandlers, enabled: boolean,
  options?: { fromSeq?: number }) => {
  consumer.callbacks = callbacks; consumer.enabled = enabled; consumer.options = options;
} }));
beforeEach(() => { getTaskTrace.mockReset(); consumer.enabled = false; });

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
const frame = (payload: unknown, seq: number) => ({ seq, kind: "trace" as const, payload });

it("folds every item page, then follows live frames and closes on stream.closed", async () => {
  const turn = traceTurn();
  getTaskTrace
    .mockResolvedValueOnce(turnPage(turn, [command("cmd_1", [read("a.ts")])], { next_item_cursor: 1, head: 5 }))
    .mockResolvedValueOnce(turnPage(turn, [message("msg:1", "Looking")], { head: 6 }));
  const { wrapper, client } = setup();
  const view = renderHook(() => useTurnTrace("att_1", { live: true, turnId: "turn_1" }), { wrapper });
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  expect(getTaskTrace.mock.calls).toEqual([["att_1", { itemCursor: 0, turnId: "turn_1" }], ["att_1", { itemCursor: 1, turnId: "turn_1" }]]);
  expect(view.result.current.items.map((item) => item.id)).toEqual(["cmd_1", "msg:1"]);
  expect(consumer.enabled).toBe(true);

  await act(async () => consumer.callbacks.onFrames?.([
    frame(event({ type: "item.delta", item_id: "msg:1", field: "text", delta: " again" }, 6), 6), // at the page head: a no-op
    frame(event({ type: "item.started", item: message("msg:2", "", "final", { status: "in_progress", completed_at: null }) }, 7), 7),
    frame(event({ type: "item.delta", item_id: "msg:2", field: "text", delta: "Done" }, 8), 8),
    frame(event({ type: "turn.updated", patch: { context_usage: { used: 5, size: 10 } } }, 9), 9),
    frame({ seq: 10, ts: turn.started_at, type: "tool_use", tool: "Bash" }, 10), // legacy fragment: skipped
  ]));
  // Query observers notify on the next tick.
  await waitFor(() => expect(view.result.current.items.map((item) => [item.id, "text" in item ? item.text : null])).toEqual([
    ["cmd_1", null], ["msg:1", "Looking"], ["msg:2", "Done"],
  ]));
  expect(view.result.current.turn?.context_usage).toEqual({ used: 5, size: 10 });
  expect(client.getQueryData(turnTraceKey("att_1"))).toBeDefined();

  act(() => consumer.callbacks.onClosed?.({ stream: "trace", id: "att_1", head_seq: 9 }));
  await waitFor(() => expect(view.result.current.closed).toBe(true));
  expect(consumer.enabled).toBe(false);
  view.unmount(); client.clear();
});

it("replays frames that arrive while a read is in flight on top of its pages", async () => {
  const turn = traceTurn();
  let resolve!: (value: unknown) => void;
  getTaskTrace.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const { wrapper, client } = setup();
  const view = renderHook(() => useTurnTrace("att_1", { live: true }), { wrapper });
  await act(async () => consumer.callbacks.onFrames?.([
    frame(event({ type: "item.started", item: command("cmd_2", [read("b.ts")], { status: "in_progress", completed_at: null }) }, 12), 12),
  ]));
  expect(view.result.current.loaded).toBe(false);
  await act(async () => resolve(turnPage(turn, [command("cmd_1", [read("a.ts")])], { head: 10 })));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  // Page items first, then what the socket started after the page head.
  expect(view.result.current.items.map((item) => item.id)).toEqual(["cmd_1", "cmd_2"]);
  view.unmount(); client.clear();
});

it("refetches the snapshot on a gap and when the hub cannot reach back to the loaded head", async () => {
  const turn = traceTurn();
  getTaskTrace.mockResolvedValue(turnPage(turn, [], { head: 3 }));
  const { wrapper, client } = setup();
  const view = renderHook(() => useTurnTrace("att_1", { live: true }), { wrapper });
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  expect(getTaskTrace).toHaveBeenCalledTimes(1);
  act(() => consumer.callbacks.onAck?.({ stream: "trace", id: "att_1", first_seq: 3, head_seq: 9, gap: { from: 1, to: 2 } }));
  expect(getTaskTrace).toHaveBeenCalledTimes(1);
  act(() => consumer.callbacks.onAck?.({ stream: "trace", id: "att_1", first_seq: 8, head_seq: 9, gap: { from: 1, to: 7 } }));
  await waitFor(() => expect(getTaskTrace).toHaveBeenCalledTimes(2));
  act(() => consumer.callbacks.onGap?.({ stream: "trace", id: "att_1", from: 10, to: 20 }));
  await waitFor(() => expect(getTaskTrace).toHaveBeenCalledTimes(3));
  view.unmount(); client.clear();
});

it("shows nothing for a legacy trace and never subscribes to it", async () => {
  getTaskTrace.mockResolvedValue(turnPage(null, [], { format: "legacy", closed: false }));
  const { wrapper, client } = setup();
  const view = renderHook(() => useTurnTrace("att_1", { live: true }), { wrapper });
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  expect(view.result.current).toMatchObject({ turn: null, items: [], read: { format: "legacy" } });
  expect(consumer.enabled).toBe(false);
  view.unmount(); client.clear();
});

it("reports refused streams and recovers on retry", async () => {
  getTaskTrace.mockResolvedValue(turnPage(traceTurn(), []));
  const { wrapper, client } = setup();
  const view = renderHook(() => useTurnTrace("att_1", { live: true }), { wrapper });
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  act(() => consumer.callbacks.onError?.({ stream: "trace", id: "att_1", code: "forbidden" }));
  expect(view.result.current.error).toBe(true);
  expect(consumer.enabled).toBe(false);
  act(() => view.result.current.retry());
  expect(view.result.current.error).toBe(false);
  await waitFor(() => expect(getTaskTrace).toHaveBeenCalledTimes(2));
  view.unmount(); client.clear();
});

it("does not subscribe or fetch while its consumer is hidden", () => {
  const { wrapper, client } = setup();
  const view = renderHook(() => useTurnTrace("att_1", { enabled: false, live: true }), { wrapper });
  expect(consumer.enabled).toBe(false);
  expect(getTaskTrace).not.toHaveBeenCalled();
  view.unmount(); client.clear();
});

it("rereads an unsealed snapshot when a non-live reader mounts, but trusts a sealed one", async () => {
  const { wrapper, client } = setup();
  getTaskTrace.mockResolvedValue(turnPage(traceTurn({ status: "completed" }), [], { closed: true }));
  const first = renderHook(() => useTurnTrace("att_1"), { wrapper });
  await waitFor(() => expect(first.result.current.closed).toBe(true));
  first.unmount();
  const second = renderHook(() => useTurnTrace("att_1"), { wrapper });
  expect(second.result.current.closed).toBe(true);
  expect(getTaskTrace).toHaveBeenCalledTimes(1);
  second.unmount(); client.clear();
});

it("shows each page as it arrives and marks the read landed after the last", async () => {
  const turn = traceTurn();
  let releaseSecond!: (value: unknown) => void;
  getTaskTrace
    .mockResolvedValueOnce(turnPage(turn, [command("cmd_1", [read("a.ts")])], { next_item_cursor: 1, head: 5 }))
    .mockReturnValueOnce(new Promise((resolve) => { releaseSecond = resolve; }));
  const { wrapper, client } = setup();
  const view = renderHook(() => useTurnTrace("att_1"), { wrapper });
  await waitFor(() => expect(view.result.current.items.map((item) => item.id)).toEqual(["cmd_1"]));
  expect(view.result.current.loaded).toBe(false);
  await act(async () => releaseSecond(turnPage(turn, [message("msg:1", "Looking")], { head: 6 })));
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  expect(view.result.current.items.map((item) => item.id)).toEqual(["cmd_1", "msg:1"]);
  view.unmount(); client.clear();
});

it("resubscribes after the loaded head instead of replaying the hub ring", async () => {
  getTaskTrace.mockResolvedValue(turnPage(traceTurn(), [command("cmd_1", [read("a.ts")])], { head: 12, closed: false }));
  const { wrapper, client } = setup();
  const view = renderHook(({ enabled }) => useTurnTrace("att_1", { enabled, live: true }), { wrapper, initialProps: { enabled: true } });
  expect(consumer.options).toEqual({ fromSeq: undefined });
  await waitFor(() => expect(view.result.current.loaded).toBe(true));
  view.rerender({ enabled: false });
  view.rerender({ enabled: true });
  expect(consumer.options).toEqual({ fromSeq: 13 });
  view.unmount(); client.clear();
});
