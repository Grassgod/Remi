// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api, ApiError } from "@multiremi/core/api";
import type { AgentTask } from "@multiremi/core/types";
import { renderWithI18n } from "../../test/i18n";

const task: AgentTask = {
  id: "task-1", agent_id: "agent-1", runtime_id: null, issue_id: "issue-1",
  status: "running", priority: 0, dispatched_at: null, started_at: null,
  completed_at: null, result: null, error: null, created_at: "2026-09-19T00:00:00Z",
  trigger_summary: "Research the issue",
  executionModel: "deepseek-flash", executionThinkingLevel: "high", fallbackSwitched: true,
  switchReason: "gateway_resource:agent_error.provider_no_available_account;provider_session_reset",
};
let displayedTask: AgentTask = task;

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => ({
    data: queryKey.includes("agents") ? [{ id: "agent-1", model: "gpt-primary", thinking_level: "low" }] : [displayedTask],
  }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: { rerunIssue: vi.fn(), updateIssue: vi.fn() },
}));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../../common/task-transcript", () => ({ TranscriptButton: () => null }));
vi.mock("./task-steer-actions", () => ({ TaskSteerActions: () => null }));
vi.mock("./terminate-task-confirm-dialog", () => ({ TerminateTaskConfirmDialog: () => null }));

import { ExecutionLogSection } from "./execution-log-section";

function renderLog() {
  return renderWithI18n(
    <QueryClientProvider client={new QueryClient()}>
      <ExecutionLogSection issueId="issue-1" />
    </QueryClientProvider>,
  );
}

describe("ExecutionLogSection", () => {
  it("shows the task's actual model and switch cause, not the Agent's current primary", () => {
    renderLog();
    expect(screen.getByText("deepseek-flash")).toBeInTheDocument();
    expect(screen.queryByText("gpt-primary")).toBeNull();
    expect(screen.getByText(/No available gateway account/)).toBeInTheDocument();
    expect(screen.getByText(/1 switch/)).toBeInTheDocument();
  });

  it("keeps the execution metadata visible in past runs", () => {
    task.status = "completed";
    try {
      renderLog();
      fireEvent.click(screen.getByRole("button", { name: /Show past runs/ }));
      expect(screen.getByText("deepseek-flash")).toBeInTheDocument();
    } finally {
      task.status = "running";
    }
  });

  it("uses configured model metadata instead of mixed auxiliary usage for a legacy task", () => {
    displayedTask = { ...task, status: "completed", executionModel: undefined,
      executionThinkingLevel: undefined, fallbackSwitched: false,
      usage: [{ model: "gpt-5.6-luna", inputTokens: 7 }] };
    try {
      renderLog();
      fireEvent.click(screen.getByRole("button", { name: /Show past runs/ }));
      expect(screen.queryByText("gpt-5.6-luna")).toBeNull();
      expect(screen.getByText("gpt-primary")).toBeInTheDocument();
      expect(screen.getByText("(low)")).toBeInTheDocument();
    } finally {
      displayedTask = task;
    }
  });

  it("offers force start only for a dependencies_unmet rerun conflict", async () => {
    displayedTask = { ...task, status: "failed" };
    vi.mocked(api.rerunIssue).mockRejectedValueOnce(
      new ApiError("dependencies unmet", 409, "Conflict", { code: "dependencies_unmet" }),
    );
    vi.mocked(api.updateIssue).mockResolvedValueOnce({ id: "issue-1" } as never);
    try {
      renderLog();
      fireEvent.click(screen.getByRole("button", { name: /Show past runs/ }));
      fireEvent.click(screen.getByRole("button", { name: /Retry task/ }));
      expect(await screen.findByText("Prerequisites are unfinished")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Force start" }));
      await waitFor(() => expect(api.updateIssue).toHaveBeenCalledWith("issue-1", { status: "todo", force: true }));
    } finally {
      displayedTask = task;
    }
  });
});
