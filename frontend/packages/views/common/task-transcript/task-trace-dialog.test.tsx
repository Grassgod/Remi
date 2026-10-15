import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTask } from "@multiremi/core/types/agent";
import { renderWithI18n } from "../../test/i18n";
import { command, event, message, read, traceTurn, turnPage, unknown } from "../../test/trace-fixtures";
import { TaskTraceDialog } from "./task-trace-dialog";

const { getTaskTrace, getTurnInput, handlers, subscriptionEnabled } = vi.hoisted(() => ({
  getTaskTrace: vi.fn(),
  getTurnInput: vi.fn(),
  handlers: { current: null as null | Record<string, (...args: never[]) => void> },
  subscriptionEnabled: vi.fn(),
}));

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: { getTaskTrace, getTurnInput, getAgent: vi.fn(), listRuntimes: vi.fn() },
}));

vi.mock("@multiremi/core/realtime", () => ({
  useTraceStreamSubscription: (_id: string, callbacks: typeof handlers.current, enabled: boolean) => {
    handlers.current = callbacks;
    subscriptionEnabled(enabled);
  },
}));

const task = {
  id: "task-trace-1", turn_id: "turn_1", agent_id: "", runtime_id: "", issue_id: "issue-1",
  status: "running", priority: 0, dispatched_at: null, started_at: null,
  completed_at: null, result: null, error: null, created_at: "2026-08-08T00:00:00Z",
} as AgentTask;

const turn = traceTurn({ id: task.id });
const page = (items: Parameters<typeof turnPage>[1] = [], overrides: Parameters<typeof turnPage>[2] = {}) =>
  turnPage(turn, items, { closed: false, ...overrides });
const frame = (payload: unknown, seq: number) => ({ seq, kind: "trace", payload });

function renderTrace(overrides: Partial<AgentTask> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <TaskTraceDialog task={{ ...task, ...overrides }} agentName="Agent" onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getTaskTrace.mockReset();
  getTurnInput.mockReset();
  subscriptionEnabled.mockReset();
  handlers.current = null;
  HTMLElement.prototype.scrollTo = vi.fn();
});

describe("task trace dialog", () => {
  it("shows the turn's model and context usage from the trace", async () => {
    getTaskTrace.mockResolvedValue(page([], { turn: traceTurn({ id: task.id, model: "gpt-6.1-sol", status: "completed",
      context_usage: { used: 120_000, size: 1_000_000 } }), closed: true }));
    renderTrace({ status: "completed" });
    expect(await screen.findByText("gpt-6.1-sol")).toBeInTheDocument();
    expect(screen.getByText("Context 120K / 1M")).toBeInTheDocument();
  });

  it("reads every item page, then follows live frames on the shared reducer", async () => {
    getTaskTrace
      .mockResolvedValueOnce(page([command("cmd_1", [read("a.ts")]), command("cmd_2", [read("b.ts")])], { next_item_cursor: 2, head: 4 }))
      .mockResolvedValueOnce(page([command("cmd_3", [unknown("make")])], { head: 5 }));
    renderTrace();
    expect(await screen.findByText("3 tool calls")).toBeInTheDocument();
    expect(getTaskTrace.mock.calls).toEqual([[task.id, { itemCursor: 0, turnId: "turn_1" }], [task.id, { itemCursor: 2, turnId: "turn_1" }]]);
    expect(subscriptionEnabled).toHaveBeenLastCalledWith(true);
    await act(async () => {
      handlers.current?.onFrames?.([
        frame(event({ type: "item.completed", item: command("cmd_3", [unknown("make")]) }, 5), 5), // already in the page
        frame(event({ type: "item.started", item: command("cmd_4", [unknown("ls")], { status: "in_progress", completed_at: null }) }, 6), 6),
      ] as never);
    });
    expect(await screen.findByText("4 tool calls")).toBeInTheDocument();
    getTaskTrace.mockResolvedValueOnce(page([command("cmd_1", [read("a.ts")]), command("cmd_5", [read("c.ts")])], { head: 9 }));
    await act(async () => { handlers.current?.onGap?.({ from: 7, to: 8 } as never); });
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledTimes(3));
    // A gap rereads the snapshot, which replaces the state.
    expect(await screen.findByText("2 tool calls")).toBeInTheDocument();
  });

  it("surfaces the final item and stops tool spinners once the trace closes", async () => {
    getTaskTrace.mockResolvedValue(page([
      command("cmd_1", [unknown("bun test")], { status: "in_progress", completed_at: null }),
      message("msg:f", "All green.", "final"),
    ], { turn: traceTurn({ id: task.id, status: "completed" }), closed: true }));
    renderTrace();
    expect(await screen.findByText("Final answer")).toBeInTheDocument();
    expect(screen.getAllByText("All green.").length).toBeGreaterThan(0);
    expect(screen.getByText("Not finished")).toBeInTheDocument();
    expect(subscriptionEnabled).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("Execution finished · 2 events")).toBeInTheDocument();
  });

  it("passes assignment fallback through to the Input Prompt view on 404", async () => {
    getTaskTrace.mockResolvedValue(page([], { state: "not_found", source: null, turn: null }));
    getTurnInput.mockRejectedValue(Object.assign(new Error("prompt not recorded"), { status: 404 }));
    renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskTraceDialog task={{ ...task, status: "queued" }} agentName="Agent" onOpenChange={() => {}} initialView="prompt" promptFallback={<p>Assignment from the turn</p>} />
    </QueryClientProvider>);
    expect(await screen.findByText("Assignment from the turn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Input Prompt" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/older runtime/)).toBeNull();
  });

  it.each([
    ["lost", "Execution trace was lost"],
    ["not_found", "No execution trace is available"],
  ] as const)("shows the %s state", async (state, label) => {
    getTaskTrace.mockResolvedValue(page([], { state, source: null, turn: null }));
    renderTrace();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("shows an offline runtime and retries without removing the dialog", async () => {
    getTaskTrace.mockResolvedValueOnce(page([], { state: "unreachable", runtime_name: "Runtime A", retryable: true, turn: null }))
      .mockResolvedValueOnce(page([command("cmd_1", [read("a.ts")])]));
    renderTrace();
    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime A is offline");
    expect(screen.queryByText("Waiting for events...")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1 tool call")).toBeInTheDocument();
    expect(getTaskTrace).toHaveBeenCalledTimes(2);
  });

  it("does not subscribe to a trace that is already closed", async () => {
    getTaskTrace.mockResolvedValue(page([command("cmd_1", [read("a.ts")])], { closed: true }));
    renderTrace();
    expect(await screen.findByText("Execution finished · 1 events")).toBeInTheDocument();
    expect(subscriptionEnabled).toHaveBeenLastCalledWith(false);
  });
});
