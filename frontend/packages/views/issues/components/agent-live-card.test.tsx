import { useEffect } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent as rtlFireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TaskMessagePayload } from "@multiremi/core/types/events";
import type { TimelineItem } from "../../common/task-transcript";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Capture WS event handlers so the test can drive them directly. The card
// subscribes to task:queued, task:dispatch, task:completed, task:failed,
// task:cancelled, and task:message via useWSEvent. We mirror the real
// hook's useEffect-based subscription so stale subscriptions clean up
// across re-renders (otherwise every render would stack a duplicate
// handler and one event would fan out into many reconcile calls).
type EventHandler = (payload: unknown) => void;
const wsHandlers = vi.hoisted(() => new Map<string, Set<EventHandler>>());
const wsReconnectCallbacks = vi.hoisted(() => new Set<() => void>());
const transcriptItemsByTask = vi.hoisted(() => new Map<string, TimelineItem[]>());

vi.mock("@multiremi/core/realtime", () => ({
  useWSEvent: (event: string, handler: EventHandler) => {
    useEffect(() => {
      const set = wsHandlers.get(event) ?? new Set<EventHandler>();
      set.add(handler);
      wsHandlers.set(event, set);
      return () => {
        set.delete(handler);
      };
    }, [event, handler]);
  },
  useWSReconnect: (cb: () => void) => {
    useEffect(() => {
      wsReconnectCallbacks.add(cb);
      return () => {
        wsReconnectCallbacks.delete(cb);
      };
    }, [cb]);
  },
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_: string, id: string) => (id ? `Agent ${id}` : "Agent"),
    getActorInitials: (_: string, id: string) =>
      id ? id.slice(0, 2).toUpperCase() : "AG",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => (
    <span data-testid="actor-avatar">{actorId}</span>
  ),
}));

vi.mock("../../common/task-transcript", async () => {
  const actual = await vi.importActual<typeof import("../../common/task-transcript")>(
    "../../common/task-transcript",
  );
  return {
    ...actual,
    TranscriptButton: ({ task, items }: { task: AgentTask; items: TimelineItem[] }) => {
      transcriptItemsByTask.set(task.id, items);
      return <button data-testid="transcript-button">transcript</button>;
    },
  };
});

vi.mock("../../common/human-request-dock", () => ({
  HumanRequestDock: ({ taskId }: { taskId: string }) => (
    <div data-testid={`human-request-${taskId}`}>Human request for {taskId}</div>
  ),
}));

const mockApi = vi.hoisted(() => ({
  getActiveTasksForIssue: vi.fn(),
  listTaskMessages: vi.fn(),
  cancelTask: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({
  api: mockApi,
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { countToolCalls } from "../../common/task-transcript";
import { AgentLiveCard } from "./agent-live-card";

function makeTask(id: string, overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    agent_id: "agent-1",
    runtime_id: "rt-1",
    issue_id: "issue-1",
    status: "running",
    priority: 0,
    dispatched_at: "2026-01-01T00:00:00Z",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}

function fireEvent(event: string, payload: unknown) {
  const handlers = wsHandlers.get(event) ?? [];
  for (const h of handlers) h(payload);
}

function renderCard(issueId = "issue-1", issueSessionId?: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <AgentLiveCard issueId={issueId} issueSessionId={issueSessionId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

function taskMessage(
  seq: number,
  type: TaskMessagePayload["type"] = "tool_use",
): TaskMessagePayload {
  return {
    task_id: "task-1",
    issue_id: "issue-1",
    seq,
    type,
    tool: "Bash",
  };
}

beforeEach(() => {
  wsHandlers.clear();
  wsReconnectCallbacks.clear();
  transcriptItemsByTask.clear();
  mockApi.getActiveTasksForIssue.mockReset();
  mockApi.listTaskMessages.mockReset();
  mockApi.listTaskMessages.mockResolvedValue([]);
  mockApi.cancelTask.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentLiveCard reconcile race", () => {
  it("keeps the visible summary and transcript on the complete hydrated message set", async () => {
    const hydration = deferred<TaskMessagePayload[]>();
    mockApi.getActiveTasksForIssue.mockResolvedValue({ tasks: [makeTask("task-1")] });
    mockApi.listTaskMessages.mockReturnValue(hydration.promise);

    renderCard();
    await waitFor(() => expect(mockApi.listTaskMessages).toHaveBeenCalledWith("task-1"));

    await act(async () => {
      hydration.resolve([
        taskMessage(1),
        taskMessage(2, "tool_result"),
        taskMessage(3, "text"),
        taskMessage(4),
      ]);
    });
    await screen.findByText("2 tools");

    act(() => {
      fireEvent("task:message", taskMessage(5));
    });

    await waitFor(() => {
      expect(screen.getByText("3 tools")).toBeTruthy();
      expect(countToolCalls(transcriptItemsByTask.get("task-1") ?? [])).toBe(3);
    });
  });

  it("publishes hydrated history plus in-flight WS frames to the shared cache", async () => {
    const hydration = deferred<TaskMessagePayload[]>();
    mockApi.getActiveTasksForIssue.mockResolvedValue({ tasks: [makeTask("task-1")] });
    mockApi.listTaskMessages.mockReturnValue(hydration.promise);

    const { qc } = renderCard();
    await waitFor(() => expect(mockApi.listTaskMessages).toHaveBeenCalledWith("task-1"));

    act(() => {
      fireEvent("task:message", taskMessage(3));
    });
    await act(async () => {
      hydration.resolve([taskMessage(1), taskMessage(2)]);
    });

    await waitFor(() => {
      expect(qc.getQueryData<TaskMessagePayload[]>(["task-messages", "task-1"])?.map((item) => item.seq)).toEqual([
        1,
        2,
        3,
      ]);
    });
  });

  it("does not re-add a banner when an older active-task response resolves after a newer empty one", async () => {
    const mountFetch = deferred<{ tasks: AgentTask[] }>();
    const queuedFetch = deferred<{ tasks: AgentTask[] }>();
    const completedFetch = deferred<{ tasks: AgentTask[] }>();

    // The component issues three reconciles in this test:
    // 1. mount
    // 2. task:queued
    // 3. task:completed (after optimistic delete)
    // We control the order they resolve to reproduce the GPT-Boy race.
    mockApi.getActiveTasksForIssue
      .mockReturnValueOnce(mountFetch.promise)
      .mockReturnValueOnce(queuedFetch.promise)
      .mockReturnValueOnce(completedFetch.promise);

    renderCard();

    // Mount call resolves with empty — no banner yet.
    await act(async () => {
      mountFetch.resolve({ tasks: [] });
    });
    expect(screen.queryByText(/is working/)).toBeNull();

    // task:queued fires; reconcile A is now in flight (queuedFetch).
    act(() => {
      fireEvent("task:queued", { issue_id: "issue-1", task_id: "task-1" });
    });

    // task:completed fires; handler optimistically deletes (no-op since
    // the banner isn't rendered yet) then issues reconcile B (completedFetch).
    act(() => {
      fireEvent("task:completed", { issue_id: "issue-1", task_id: "task-1" });
    });

    // Reconcile B resolves first with empty list — server truth says no
    // active tasks. State is empty.
    await act(async () => {
      completedFetch.resolve({ tasks: [] });
    });
    expect(screen.queryByText(/is working/)).toBeNull();

    // Reconcile A (older, slow) resolves last with a stale snapshot that
    // still includes the task. With the generation guard, this response
    // must be dropped. Without the guard, the banner would re-appear.
    await act(async () => {
      queuedFetch.resolve({ tasks: [makeTask("task-1")] });
    });

    // The banner must NOT come back.
    expect(screen.queryByText(/is working/)).toBeNull();
    expect(mockApi.getActiveTasksForIssue).toHaveBeenCalledTimes(3);
  });

  it("WS reconnect refetch removes a stale banner whose end event was lost", async () => {
    const mountFetch = deferred<{ tasks: AgentTask[] }>();
    const reconnectFetch = deferred<{ tasks: AgentTask[] }>();

    mockApi.getActiveTasksForIssue
      .mockReturnValueOnce(mountFetch.promise)
      .mockReturnValueOnce(reconnectFetch.promise);

    renderCard();

    // Mount sees the task as active — banner shows.
    await act(async () => {
      mountFetch.resolve({ tasks: [makeTask("task-1")] });
    });
    await waitFor(() => {
      expect(screen.getByText(/is working/)).toBeTruthy();
    });

    // Simulate the WS dropping task:completed and then reconnecting.
    // The reconnect callback runs reconcile, which fetches and finds the
    // task is no longer active.
    expect(wsReconnectCallbacks.size).toBeGreaterThan(0);
    act(() => {
      for (const cb of wsReconnectCallbacks) cb();
    });

    await act(async () => {
      reconnectFetch.resolve({ tasks: [] });
    });

    // The banner self-heals.
    await waitFor(() => {
      expect(screen.queryByText(/is working/)).toBeNull();
    });
  });
});

describe("AgentLiveCard queued rendering", () => {
  it("renders 'is queued' copy without transcript when status is queued", async () => {
    const queuedTask = makeTask("task-q", {
      status: "queued",
      dispatched_at: null,
      started_at: null,
    });
    mockApi.getActiveTasksForIssue.mockResolvedValueOnce({ tasks: [queuedTask] });

    renderCard();

    await waitFor(() => {
      expect(screen.getByText(/is queued/)).toBeTruthy();
    });
    // No execution transcript while queued — no log to show yet.
    expect(screen.queryByTestId("transcript-button")).toBeNull();
    // Cancel button is still available so users can drop a queued task.
    const stop = screen.getByRole("button", { name: "Stop" });
    expect(stop).toBeTruthy();
    expect(stop.querySelector("span")).toHaveClass("hidden", "sm:inline");
  });

  it("Stop button opens a confirm dialog and only calls cancelTask after the user confirms", async () => {
    const runningTask = makeTask("task-r", { status: "running" });
    mockApi.getActiveTasksForIssue.mockResolvedValueOnce({ tasks: [runningTask] });
    mockApi.cancelTask.mockResolvedValue(undefined);

    renderCard();

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeTruthy();
    });

    // First click should not hit the API — it only opens the confirm.
    await act(async () => {
      rtlFireEvent.click(screen.getByText("Stop"));
    });
    expect(mockApi.cancelTask).not.toHaveBeenCalled();
    expect(screen.getByText(/Stop this task\?/)).toBeTruthy();

    // Confirm — now the cancel fires.
    await act(async () => {
      rtlFireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    });
    expect(mockApi.cancelTask).toHaveBeenCalledWith("issue-1", "task-r");
  });

  it("Stop confirm dialog dismisses without cancelling when the user picks Keep running", async () => {
    const runningTask = makeTask("task-r", { status: "running" });
    mockApi.getActiveTasksForIssue.mockResolvedValueOnce({ tasks: [runningTask] });
    mockApi.cancelTask.mockResolvedValue(undefined);

    renderCard();

    await waitFor(() => {
      expect(screen.getByText("Stop")).toBeTruthy();
    });

    await act(async () => {
      rtlFireEvent.click(screen.getByText("Stop"));
    });
    expect(screen.getByText(/Stop this task\?/)).toBeTruthy();

    await act(async () => {
      rtlFireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    });
    expect(mockApi.cancelTask).not.toHaveBeenCalled();
  });

  it("running tasks sort above queued tasks in the multi-agent accordion", async () => {
    const runningTask = makeTask("task-r", { status: "running", agent_id: "agent-r" });
    const queuedTask = makeTask("task-q", {
      status: "queued",
      agent_id: "agent-q",
      dispatched_at: null,
      started_at: null,
    });
    // Server returns queued first (created_at DESC), but the client must
    // re-sort so the running row leads the popover list.
    mockApi.getActiveTasksForIssue.mockResolvedValueOnce({
      tasks: [queuedTask, runningTask],
    });

    renderCard();

    // Two agents → collapsed summary; the per-agent rows aren't in the DOM
    // until the accordion is expanded.
    await waitFor(() => {
      expect(screen.getByText(/agents working/)).toBeTruthy();
    });
    expect(screen.queryByText(/is working/)).toBeNull();

    await act(async () => {
      rtlFireEvent.click(screen.getByText(/agents working/));
    });

    const working = await screen.findByText(/is working/);
    const queued = screen.getByText(/is queued/);
    // Running row appears earlier in the document order.
    expect(working.compareDocumentPosition(queued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("collapses multiple agents into a summary and exposes each agent's Stop inside the accordion", async () => {
    const taskA = makeTask("task-a", { status: "running", agent_id: "agent-a" });
    const taskB = makeTask("task-b", { status: "running", agent_id: "agent-b" });
    mockApi.getActiveTasksForIssue.mockResolvedValueOnce({ tasks: [taskA, taskB] });
    mockApi.cancelTask.mockResolvedValue(undefined);

    renderCard();

    // Collapsed: one summary, no inline banners.
    await waitFor(() => {
      expect(screen.getByText(/2 agents working/)).toBeTruthy();
    });
    expect(screen.queryByText(/is working/)).toBeNull();

    // Expand the accordion → one row per agent, each with its own Stop.
    await act(async () => {
      rtlFireEvent.click(screen.getByText(/2 agents working/));
    });
    const [firstStop, secondStop] = await screen.findAllByText("Stop");
    expect(secondStop).toBeTruthy();

    // Stop on the first row → confirm → cancelTask fires for that task only.
    await act(async () => {
      rtlFireEvent.click(firstStop!);
    });
    await act(async () => {
      rtlFireEvent.click(screen.getByRole("button", { name: "Stop task" }));
    });
    expect(mockApi.cancelTask).toHaveBeenCalledWith("issue-1", "task-a");
  });
});

describe("AgentLiveCard human requests", () => {
  it("mounts the shared request dock for an awaiting task", async () => {
    mockApi.getActiveTasksForIssue.mockResolvedValueOnce({
      tasks: [makeTask("task-question", { status: "awaiting_human" })],
    });

    renderCard();

    expect(await screen.findByTestId("human-request-task-question")).toBeTruthy();
  });

  it("shows an Issue-level request even when another Session is selected", async () => {
    mockApi.getActiveTasksForIssue.mockResolvedValueOnce({
      tasks: [makeTask("task-other-session", {
        status: "awaiting_human",
        issue_session_id: "session-other",
      })],
    });

    renderCard("issue-1", "session-current");

    expect(await screen.findByTestId("human-request-task-other-session")).toBeTruthy();
    expect(screen.queryByText(/is waiting for your response/)).toBeNull();
  });
});
