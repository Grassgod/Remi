import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTask } from "@multiremi/core/types/agent";
import { renderWithI18n } from "../../test/i18n";
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
  getTurnInput.mockReset();
  subscriptionEnabled.mockReset();
  handlers.current = null;
  HTMLElement.prototype.scrollTo = vi.fn();
});

describe("task trace dialog", () => {
  it("counts only display events and surfaces the complete final reply and latest context", async () => {
    const prose = (seq: number, type: string, content: string, meta?: Record<string, unknown>) => ({
      seq, type, content, meta, ts: "2026-10-04T00:00:00Z",
    });
    getTaskTrace.mockResolvedValue(page({
      closed: true, head: 8, next_after_seq: 8,
      events: [
        event(1),
        { ...event(2), type: "tool_result", tool_call_id: "call-1", output: "ok", status: "completed" },
        prose(3, "text", "Fixed the bug "),
        prose(4, "usage", "", { used: 210908, size: 1000000 }),
        prose(5, "execution", "", { model: "model-x" }),
        prose(6, "text", "and added tests."),
        prose(7, "usage", "", { used: 82000, size: 1000000 }),
        prose(8, "text", "Child reply.", { parent_tool_call_id: "child" }),
      ],
    }));
    renderTrace({ status: "completed", usage: [{ totalTokens: 210908 }] });

    expect(await screen.findByText("Context 82K / 1M")).toBeInTheDocument();
    expect(screen.queryByText("210.9K ctx")).toBeNull();
    expect(screen.getByText("4 events")).toBeInTheDocument();
    expect(screen.getByText("Execution finished · 4 events")).toBeInTheDocument();
    const answer = screen.getByText("Final answer").parentElement!.parentElement!;
    expect(within(answer).getByText("Fixed the bug and added tests.")).toBeInTheDocument();
    expect(within(answer).queryByText("Child reply.")).toBeNull();
    expect(screen.queryByText(/usage|execution \(empty\)/i)).toBeNull();
  });

  it("merges fragments across pages and live usage frames without losing input/output usage", async () => {
    const text = (seq: number, content: string) => ({ seq, ts: "2026-10-04T00:00:00Z", type: "text", content });
    const usage = (seq: number, used: number) => ({ seq, ts: "2026-10-04T00:00:00Z", type: "usage", content: "", meta: { used } });
    getTaskTrace
      .mockResolvedValueOnce(page({ events: [text(1, "Hello "), usage(2, 100)], eof: false, next_after_seq: 2, head: 3 }))
      .mockResolvedValueOnce(page({ events: [text(3, "world")], next_after_seq: 3, head: 3 }));
    renderTrace({ usage: [{ inputTokens: 40, outputTokens: 9300 }] });
    expect(await screen.findByText("Context 100")).toBeInTheDocument();
    expect(screen.getByText("40→9.3K")).toBeInTheDocument();
    expect(screen.getByText("1 events")).toBeInTheDocument();
    expect(screen.getAllByText("Hello world")).toHaveLength(2);

    await act(async () => {
      handlers.current?.onFrames?.([
        { seq: 4, kind: "trace", payload: usage(4, 200) },
        { seq: 5, kind: "trace", payload: text(5, "!") },
      ] as never);
    });
    expect(screen.getByText("Context 200")).toBeInTheDocument();
    expect(screen.queryByText("Context 100")).toBeNull();
    expect(screen.getByText("1 events")).toBeInTheDocument();
    expect(screen.getAllByText("Hello world!")).toHaveLength(2);
    expect(screen.queryByText(/usage|\(empty\)/i)).toBeNull();
  });

  it("does not render a new context chip without usage and preserves the old token rollup", async () => {
    getTaskTrace.mockResolvedValue(page({ events: [event(1)], next_after_seq: 1, head: 1 }));
    renderTrace({ usage: [{ totalTokens: 60000 }] });
    expect(await screen.findByText("1 tool call")).toBeInTheDocument();
    expect(screen.queryByText(/^Context /)).toBeNull();
    expect(screen.getByText("60K ctx")).toBeInTheDocument();
  });

  it("shows zero context with no fabricated rows or final answer when all events are metadata", async () => {
    getTaskTrace.mockResolvedValue(page({
      closed: true, next_after_seq: 2, head: 2,
      events: [
        { seq: 1, ts: "2026-10-04T00:00:00Z", type: "execution", content: "" },
        { seq: 2, ts: "2026-10-04T00:00:00Z", type: "usage", content: "", meta: { used: 0, size: 1000000 } },
      ],
    }));
    renderTrace({ status: "completed" });
    expect(await screen.findByText("Context 0 / 1M")).toBeInTheDocument();
    expect(screen.getByText("0 events")).toBeInTheDocument();
    expect(screen.getByText("Execution finished · 0 events")).toBeInTheDocument();
    expect(screen.queryByText("Final answer")).toBeNull();
    expect(screen.queryByText(/\(empty\)/)).toBeNull();
  });

  it("passes assignment fallback through to the Input Prompt view on 404", async () => {
    getTaskTrace.mockResolvedValue(page({ state: "not_found", source: null }));
    getTurnInput.mockRejectedValue(Object.assign(new Error("prompt not recorded"), { status: 404 }));
    renderWithI18n(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TaskTraceDialog task={{ ...task, status: "queued" }} agentName="Agent" onOpenChange={() => {}} initialView="prompt" promptFallback={<p>Assignment from the turn</p>} />
    </QueryClientProvider>);
    expect(await screen.findByText("Assignment from the turn")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Input Prompt" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/older runtime/)).toBeNull();
  });

  it("pages the trace and merges duplicate live frames and a gap by seq", async () => {
    getTaskTrace
      .mockResolvedValueOnce(page({ events: [event(1), event(2)], next_after_seq: 2, head: 3, eof: false }))
      .mockResolvedValueOnce(page({ events: [event(3)], next_after_seq: 3, head: 3 }))
      .mockResolvedValueOnce(page({ events: [event(5)], next_after_seq: 5, head: 5 }));
    renderTrace();
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith(task.id, 2, 500, "turn_1"));
    expect(await screen.findByText("3 tool calls")).toBeInTheDocument();
    await act(async () => {
      handlers.current?.onFrames?.([
        { seq: 3, kind: "trace", payload: event(3) },
        { seq: 4, kind: "trace", payload: event(4) },
      ] as never);
    });
    expect(screen.getByText("4 tool calls")).toBeInTheDocument();
    await act(async () => { handlers.current?.onGap?.({ from: 5, to: 5 } as never); });
    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith(task.id, 4, 500, "turn_1"));
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
