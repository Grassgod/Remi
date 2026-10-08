import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { StreamSubscriptionHandlers } from "@multiremi/core/api/ws-client";
import { useTaskTraceState } from "./use-task-trace";

const { getTaskTrace, consumer } = vi.hoisted(() => ({ getTaskTrace: vi.fn(), consumer: { callbacks: {} as StreamSubscriptionHandlers, enabled: false } }));
vi.mock("@multiremi/core/api", async original => ({ ...await original<typeof import("@multiremi/core/api")>(), api: { getTaskTrace } }));
vi.mock("@multiremi/core/realtime", () => ({ useTraceStreamSubscription: (_id: string, callbacks: StreamSubscriptionHandlers, enabled: boolean) => {
  consumer.callbacks = callbacks; consumer.enabled = enabled;
} }));
beforeEach(() => { getTaskTrace.mockReset(); });
const event = (seq: number) => ({ seq, ts: "", type: "tool_use", tool_call_id: `call-${seq}`, tool: "Read", input: { file_path: `${seq}.ts` } });
const page = (events: ReturnType<typeof event>[], head: number) => ({ events, next_after_seq: events.at(-1)?.seq ?? 0, head, eof: true, closed: false, state: "ok", source: "daemon" });
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
it("discovers the head then fetches only a bounded recent page", async () => {
  getTaskTrace.mockResolvedValueOnce(page([event(1)], 1000))
    .mockResolvedValueOnce(page(Array.from({ length: 200 }, (_, index) => event(801 + index)), 1000));
  const { wrapper, client } = setup();
  const view = renderHook(() => useTaskTraceState("task", true, true, "turn"), { wrapper });
  await waitFor(() => expect(view.result.current.events).toHaveLength(200));
  expect(getTaskTrace.mock.calls).toEqual([["task", 0, 1, "turn"], ["task", 800, 200, "turn"]]);
  await act(async () => consumer.callbacks.onFrames?.([{ seq: 1001, kind: "trace", payload: event(1001) }]));
  await waitFor(() => expect(view.result.current.events[0]!.seq).toBe(802));
  expect(view.result.current.events).toHaveLength(200);
  expect(view.result.current.events[0]!.seq).toBe(802);
  act(() => consumer.callbacks.onClosed?.({ stream: "trace", id: "task", head_seq: 1001 }));
  expect(view.result.current.closed).toBe(true);
  expect(consumer.enabled).toBe(false);
  view.unmount(); client.clear();
});
it("does not subscribe or fetch while its consumer is hidden", () => {
  const { wrapper, client } = setup();
  const view = renderHook(() => useTaskTraceState("task", false, true), { wrapper });
  expect(consumer.enabled).toBe(false);
  expect(getTaskTrace).not.toHaveBeenCalled();
  view.unmount(); client.clear();
});
