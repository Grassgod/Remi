import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { issueKeys } from "@multiremi/core/issues/queries";
import { ApiError } from "@multiremi/core/api";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TimelineEntry } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };
const { getTask, listTasksByIssue, getTaskTrace } = vi.hoisted(() => ({
  getTask: vi.fn(), listTasksByIssue: vi.fn(), getTaskTrace: vi.fn(),
}));
vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: { getTask, listTasksByIssue, getTaskTrace },
}));

// Trace paging/subscription are covered by the dialog suite. This regression
// verifies authoritative task lookup, lazy opening and its authorization gate.
vi.mock("../../common/task-transcript/task-trace-dialog", () => ({
  TaskTraceDialog: ({ task, agentName, onOpenChange, headerSlot }: { task: AgentTask; agentName: string; onOpenChange: (open: boolean) => void; headerSlot?: ReactNode }) => {
    const [historyPages, setHistoryPages] = useState(0);
    useEffect(() => { getTaskTrace(task.id); }, [task.id]);
    return <div role="dialog" aria-label="Task transcript" data-task={task.id}>
      {headerSlot}
      <span>{agentName}</span><button type="button" onClick={() => onOpenChange(false)}>Close transcript</button>
      <button type="button" onClick={() => setHistoryPages(value => value + 1)}>Load older history</button>
      <span data-testid="history-pages">{historyPages}</span>
    </div>;
  },
}));

import { CommentTranscriptButton } from "./comment-card";

const task: AgentTask = {
  id: "task-1", agent_id: "agent-1", runtime_id: "rt-1", issue_id: "issue-1",
  status: "completed", priority: 0, dispatched_at: null, started_at: null, completed_at: null,
  result: null, error: null, created_at: "2026-08-08T00:00:00Z",
};
function entryOf(over: Partial<TimelineEntry>): TimelineEntry {
  return { type: "comment", id: "cmt-1", actor_type: "agent", actor_id: "agent-1",
    created_at: "2026-08-08T00:00:00Z", content: "done", ...over } as TimelineEntry;
}
function renderButton(entry: TimelineEntry, qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })) {
  const ui = (value: TimelineEntry): ReactElement => (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <CommentTranscriptButton issueId="issue-1" entry={value} />
      </I18nProvider>
    </QueryClientProvider>
  );
  const result = render(ui(entry));
  return { ...result, rerenderEntry: (value: TimelineEntry) => result.rerender(ui(value)) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getTask.mockResolvedValue({ ...task, agent_name: "Leader" });
  listTasksByIssue.mockResolvedValue([]);
});

describe("comment transcript entry point", () => {
  it("offers a linked run immediately and loads its authorized detail only after clicking", async () => {
    renderButton(entryOf({ task_id: "task-1" }));
    const button = screen.getByRole("button", { name: "View transcript" });
    expect(getTask).not.toHaveBeenCalled();
    expect(listTasksByIssue).not.toHaveBeenCalled();
    expect(getTaskTrace).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(await screen.findByRole("dialog", { name: "Task transcript" })).toHaveAttribute("data-task", "task-1");
    expect(getTask).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(screen.getByText("Leader")).toBeInTheDocument();
  });

  it.each(["", "another-issue"])("opens a task absent from this Issue's cache, even with issue_id=%s", async (issueId) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qc.setQueryData(issueKeys.tasks("issue-1"), [{ ...task, id: "unrelated-run" }]);
    getTask.mockResolvedValue({ ...task, issue_id: issueId });
    renderButton(entryOf({ task_id: "task-1" }), qc);
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(await screen.findByRole("dialog", { name: "Task transcript" })).toHaveAttribute("data-task", "task-1");
    expect(getTask).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(listTasksByIssue).not.toHaveBeenCalled();
  });

  it.each([{ task_id: null }, { actor_type: "member", actor_id: "user-1", task_id: "task-1" }])(
    "fetches nothing for a human or pre-linkage comment: %j", async (entry) => {
      renderButton(entryOf(entry));
      expect(screen.queryByRole("button", { name: "View transcript" })).not.toBeInTheDocument();
      expect(getTask).not.toHaveBeenCalled();
      expect(listTasksByIssue).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 404, 500])("keeps HTTP %s failures inside the task-loading dialog and allows retry", async (status) => {
    getTask.mockRejectedValueOnce(new ApiError("Task request failed", status, "Failure")).mockResolvedValue({ ...task, agent_name: "Leader" });
    renderButton(entryOf({ task_id: "task-1" }));
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This task could not be loaded.");
    expect(screen.queryByRole("dialog", { name: "Task transcript" })).not.toBeInTheDocument();
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(listTasksByIssue).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("dialog", { name: "Task transcript" })).toHaveAttribute("data-task", "task-1");
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it("shows a loading state and does not reopen when a closed request finishes", async () => {
    let finish!: (value: AgentTask) => void;
    getTask.mockReturnValueOnce(new Promise<AgentTask>(resolve => { finish = resolve; }));
    renderButton(entryOf({ task_id: "task-1" }));
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(await screen.findByText("Loading task")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await act(async () => { finish(task); });
    expect(screen.queryByRole("dialog", { name: "Task transcript" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(await screen.findByRole("dialog", { name: "Task transcript" })).toHaveAttribute("data-task", "task-1");
    expect(getTask).toHaveBeenCalledTimes(1);
  });

  it("keeps loaded history mounted during a background detail refresh but respects a subsequent permission failure", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qc.setQueryData(["task-detail", "task-1"], { ...task, agent_name: "Leader" });
    let finish!: (value: AgentTask & { agent_name?: string }) => void;
    getTask.mockReturnValueOnce(new Promise<AgentTask & { agent_name?: string }>(resolve => { finish = resolve; }));
    renderButton(entryOf({ task_id: "task-1" }), qc);
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Load older history" }));
    expect(screen.getByTestId("history-pages")).toHaveTextContent("1");
    expect(getTaskTrace).toHaveBeenCalledExactlyOnceWith("task-1");

    act(() => { void qc.invalidateQueries({ queryKey: ["task-detail", "task-1"] }); });
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog", { name: "Task transcript" })).toBeInTheDocument();
    expect(screen.queryByText("Loading task")).not.toBeInTheDocument();
    expect(screen.getByTestId("history-pages")).toHaveTextContent("1");
    expect(getTaskTrace).toHaveBeenCalledTimes(1);

    await act(async () => { finish({ ...task, agent_name: "Updated leader" }); });
    expect(await screen.findByText("Updated leader")).toBeInTheDocument();
    expect(screen.getByTestId("history-pages")).toHaveTextContent("1");
    expect(getTaskTrace).toHaveBeenCalledTimes(1);

    getTask.mockRejectedValueOnce(new ApiError("Forbidden", 403, "Forbidden"));
    await act(async () => { await qc.invalidateQueries({ queryKey: ["task-detail", "task-1"] }); });
    expect(await screen.findByRole("alert")).toHaveTextContent("This task could not be loaded.");
    expect(screen.queryByRole("dialog", { name: "Task transcript" })).not.toBeInTheDocument();
    expect(getTaskTrace).toHaveBeenCalledTimes(1);

    // A transient failure after a known denial cannot revive the denied cache.
    getTask.mockRejectedValueOnce(new ApiError("Unavailable", 500, "Internal Server Error"));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This task could not be loaded.");
    expect(screen.queryByRole("dialog", { name: "Task transcript" })).not.toBeInTheDocument();
    expect(getTaskTrace).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "HTTP 500", error: new ApiError("Unavailable", 500, "Internal Server Error") },
    { name: "network failure", error: new TypeError("Failed to fetch") },
  ])("preserves loaded trace pages through a background $name and retry", async ({ error }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qc.setQueryData(["task-detail", "task-1"], { ...task, agent_name: "Leader" });
    renderButton(entryOf({ task_id: "task-1" }), qc);
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    await userEvent.click(screen.getByRole("button", { name: "Load older history" }));
    getTask.mockRejectedValueOnce(error);
    await act(async () => { await qc.invalidateQueries({ queryKey: ["task-detail", "task-1"] }); });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't refresh task status. Loaded execution records are still available.");
    expect(screen.getByRole("dialog", { name: "Task transcript" })).toBeInTheDocument();
    expect(screen.getByTestId("history-pages")).toHaveTextContent("1");
    expect(getTaskTrace).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByTestId("history-pages")).toHaveTextContent("1");
    expect(getTaskTrace).toHaveBeenCalledTimes(1);
    expect(getTask).toHaveBeenCalledTimes(2);
  });

  it("does not open a different returned task or reuse open state after the linked task changes", async () => {
    getTask.mockResolvedValueOnce({ ...task, id: "wrong-task" });
    const view = renderButton(entryOf({ task_id: "task-1" }));
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    view.rerenderEntry(entryOf({ task_id: "task-2" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(getTask).toHaveBeenCalledTimes(1);
    getTask.mockResolvedValueOnce({ ...task, id: "task-2" });
    await userEvent.click(screen.getByRole("button", { name: "View transcript" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Task transcript" })).toHaveAttribute("data-task", "task-2"));
  });
});
