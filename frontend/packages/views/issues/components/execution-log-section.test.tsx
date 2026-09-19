// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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
vi.mock("@multiremi/core/api", () => ({ api: {} }));
vi.mock("../../common/actor-avatar", () => ({ ActorAvatar: () => null }));
vi.mock("../../common/task-transcript", () => ({ TranscriptButton: () => null }));
vi.mock("./task-steer-actions", () => ({ TaskSteerActions: () => null }));
vi.mock("./terminate-task-confirm-dialog", () => ({ TerminateTaskConfirmDialog: () => null }));

import { ExecutionLogSection } from "./execution-log-section";

describe("ExecutionLogSection", () => {
  it("shows the task's actual model and switch cause, not the Agent's current primary", () => {
    renderWithI18n(<ExecutionLogSection issueId="issue-1" />);
    expect(screen.getByText("deepseek-flash")).toBeInTheDocument();
    expect(screen.queryByText("gpt-primary")).toBeNull();
    expect(screen.getByText(/No available gateway account/)).toBeInTheDocument();
    expect(screen.getByText(/1 switch/)).toBeInTheDocument();
  });

  it("keeps the execution metadata visible in past runs", () => {
    task.status = "completed";
    try {
      renderWithI18n(<ExecutionLogSection issueId="issue-1" />);
      fireEvent.click(screen.getByRole("button", { name: /Show past runs/ }));
      expect(screen.getByText("deepseek-flash")).toBeInTheDocument();
    } finally {
      task.status = "running";
    }
  });

  it("uses legacy task usage instead of the Agent's current model and effort", () => {
    displayedTask = { ...task, status: "completed", executionModel: undefined,
      executionThinkingLevel: undefined, fallbackSwitched: false,
      usage: [{ model: "observed-backup", inputTokens: 7 }] };
    try {
      renderWithI18n(<ExecutionLogSection issueId="issue-1" />);
      fireEvent.click(screen.getByRole("button", { name: /Show past runs/ }));
      expect(screen.getByText("observed-backup")).toBeInTheDocument();
      expect(screen.queryByText("gpt-primary")).toBeNull();
      expect(screen.queryByText("(low)")).toBeNull();
    } finally {
      displayedTask = task;
    }
  });
});
