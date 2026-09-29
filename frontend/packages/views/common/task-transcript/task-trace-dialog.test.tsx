import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTask } from "@multiremi/core/types/agent";
import { renderWithI18n } from "../../test/i18n";
import { TaskTraceDialog } from "./task-trace-dialog";

const { getTaskTrace, handlers, subscriptionEnabled } = vi.hoisted(() => ({
  getTaskTrace: vi.fn(),
  handlers: { current: null as null | Record<string, (...args: never[]) => void> },
  subscriptionEnabled: vi.fn(),
}));

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: { getTaskTrace, getTaskPrompt: vi.fn(), getAgent: vi.fn(), listRuntimes: vi.fn() },
}));

vi.mock("@multiremi/core/realtime", () => ({
  useTraceStreamSubscription: (_id: string, callbacks: typeof handlers.current, enabled: boolean) => {
    handlers.current = callbacks;
    subscriptionEnabled(enabled);
  },
}));

const task = {
  id: "task-trace-1", agent_id: "", runtime_id: "", issue_id: "issue-1",
  status: "running", priority: 0, dispatched_at: null, started_at: null,
  completed_at: null, result: null, error: null, created_at: "2026-08-08T00:00:00Z",
} as AgentTask;

const event = (seq: number) => ({ seq, ts: "2026-08-08T00:00:00Z", type: "tool_use", tool: "Bash", tool_call_id: `call-${seq}` });
const page = (overrides: Record<string, unknown> = {}) => ({
  events: [], next_after_seq: 0, head: 0, eof: true, closed: false,
  source: "daemon", state: "ok", ...overrides,
});

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
  subscriptionEnabled.mockReset();
  handlers.current = null;
  HTMLElement.prototype.scrollTo = vi.fn();
});

describe("task trace dialog", () => {
  it("pages the trace and merges duplicate live frames and a gap by seq", async () => {
    getTaskTrace
      .mockResolvedValueOnce(page({ events: [event(1), event(2)], next_after_seq: 2, head: 3, eof: false }))
      .mockResolvedValueOnce(page({ events: [event(3)], next_after_seq: 3, head: 3 }))
      .mockResolvedValueOnce(page({ events: [event(5)], next_after_seq: 5, head: 5 }));
    renderTrace();
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith(task.id, 2));
    expect(await screen.findByText("3 tool calls")).toBeInTheDocument();
    await act(async () => {
      handlers.current?.onFrames?.([
        { seq: 3, kind: "trace", payload: event(3) },
        { seq: 4, kind: "trace", payload: event(4) },
      ] as never);
    });
    expect(screen.getByText("4 tool calls")).toBeInTheDocument();
    await act(async () => { handlers.current?.onGap?.({ from: 5, to: 5 } as never); });
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith(task.id, 4));
    expect(await screen.findByText("5 tool calls")).toBeInTheDocument();
  });

  it.each([
    ["backfilling", "Execution trace is being restored"],
    ["lost", "Execution trace was lost"],
    ["not_found", "No execution trace is available"],
  ])("shows the %s state", async (state, label) => {
    getTaskTrace.mockResolvedValue(page({ state, source: null }));
    renderTrace();
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("shows an offline runtime and retries without removing the dialog", async () => {
    getTaskTrace.mockResolvedValueOnce(page({ state: "unreachable", runtime_name: "Runtime A", retryable: true }))
      .mockResolvedValueOnce(page({ state: "ok", events: [event(1)], next_after_seq: 1, head: 1 }));
    renderTrace();
    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime A is offline");
    expect(screen.queryByText("Waiting for events...")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("1 tool call")).toBeInTheDocument();
    expect(getTaskTrace).toHaveBeenCalledTimes(2);
  });

  it("stops subscribing when a finished trace reports closed", async () => {
    getTaskTrace.mockResolvedValue(page({ closed: true, events: [event(1)], next_after_seq: 1, head: 1 }));
    renderTrace();
    expect(await screen.findByText("Execution finished · 1 events")).toBeInTheDocument();
    expect(subscriptionEnabled).toHaveBeenCalledWith(true);
    expect(subscriptionEnabled).toHaveBeenLastCalledWith(false);
  });
});
