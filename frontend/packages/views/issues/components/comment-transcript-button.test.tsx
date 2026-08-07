import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TimelineEntry } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

const listTasksByIssue = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/api", () => ({
  api: { listTasksByIssue, listTaskMessages: vi.fn().mockResolvedValue([]) },
}));

// The dialog itself is covered by its own suite; here only the entry point matters.
vi.mock("../../common/task-transcript", () => ({
  TranscriptButton: ({ task, title }: { task: AgentTask; title?: string }) => (
    <button type="button" data-testid="transcript-button" data-task={task.id}>
      {title}
    </button>
  ),
}));

import { CommentTranscriptButton } from "./comment-card";

const task: AgentTask = {
  id: "task-1",
  agent_id: "agent-1",
  runtime_id: "rt-1",
  issue_id: "issue-1",
  status: "completed",
  priority: 0,
  dispatched_at: null,
  started_at: null,
  completed_at: null,
  result: null,
  error: null,
  created_at: "2026-08-08T00:00:00Z",
};

function entryOf(over: Partial<TimelineEntry>): TimelineEntry {
  return {
    type: "comment",
    id: "cmt-1",
    actor_type: "agent",
    actor_id: "agent-1",
    created_at: "2026-08-08T00:00:00Z",
    content: "done",
    ...over,
  } as TimelineEntry;
}

function renderButton(entry: TimelineEntry): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const ui: ReactElement = (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <CommentTranscriptButton issueId="issue-1" entry={entry} />
      </I18nProvider>
    </QueryClientProvider>
  );
  return render(ui);
}

beforeEach(() => {
  vi.clearAllMocks();
  listTasksByIssue.mockResolvedValue([task]);
});

describe("comment transcript entry point", () => {
  it("offers the transcript on an agent reply that recorded its run", async () => {
    renderButton(entryOf({ task_id: "task-1" }));

    const button = await screen.findByTestId("transcript-button");
    expect(button).toHaveAttribute("data-task", "task-1");
    expect(button).toHaveTextContent("View transcript");
  });

  it("shows nothing on comments predating the linkage", async () => {
    renderButton(entryOf({ task_id: null }));

    await waitFor(() => expect(listTasksByIssue).not.toHaveBeenCalled());
    expect(screen.queryByTestId("transcript-button")).not.toBeInTheDocument();
  });

  it("shows nothing on a human comment even if it somehow carries a task id", async () => {
    renderButton(entryOf({ actor_type: "member", actor_id: "user-1", task_id: "task-1" }));

    await waitFor(() => expect(listTasksByIssue).not.toHaveBeenCalled());
    expect(screen.queryByTestId("transcript-button")).not.toBeInTheDocument();
  });

  it("degrades to nothing when the task is gone (deleted run)", async () => {
    listTasksByIssue.mockResolvedValue([]);
    renderButton(entryOf({ task_id: "task-gone" }));

    await waitFor(() => expect(listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByTestId("transcript-button")).not.toBeInTheDocument();
  });

  it("survives a failing task fetch without crashing the comment", async () => {
    listTasksByIssue.mockRejectedValue(new Error("500"));
    renderButton(entryOf({ task_id: "task-1" }));

    await waitFor(() => expect(listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByTestId("transcript-button")).not.toBeInTheDocument();
  });
});
