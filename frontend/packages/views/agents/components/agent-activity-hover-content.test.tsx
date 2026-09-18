import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentTask } from "@multiremi/core/types";
import enIssues from "../../locales/en/issues.json";
import { AgentActivityHoverContent } from "./agent-activity-hover-content";

vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: [] }),
}));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "ws-1" }));
vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({ getActorName: () => "Agent", getActorInitials: () => "A", getActorAvatarUrl: () => null }),
}));

const task: AgentTask = {
  id: "task-1", agent_id: "agent-1", runtime_id: "", issue_id: "issue-1", status: "queued", priority: 0,
  dispatched_at: null, started_at: null, completed_at: null, result: null, error: null, created_at: "2026-09-18T00:00:00Z",
};

function hover(currentTask: AgentTask) {
  return <I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
    <AgentActivityHoverContent tasks={[currentTask]} />
  </I18nProvider>;
}

describe("Agent activity waiting reason", () => {
  it("keeps queued semantics in the issue/workspace hover and clears the reason after recovery", () => {
    const wait_reason = "等待模型能力恢复：2 个候选 Runtime 均无法执行 claude-opus-5";
    const view = render(hover({ ...task, wait_reason }));
    expect(screen.getByText(wait_reason)).toBeInTheDocument();
    expect(screen.getByText(enIssues.agent_activity.status_queued)).toBeInTheDocument();
    expect(screen.queryByText(enIssues.agent_activity.status_awaiting_human)).not.toBeInTheDocument();
    view.rerender(hover({ ...task, wait_reason: null }));
    expect(screen.queryByText(wait_reason)).not.toBeInTheDocument();
    view.rerender(hover({ ...task, status: "running", wait_reason }));
    expect(screen.queryByText(wait_reason)).not.toBeInTheDocument();
    expect(screen.getByText(enIssues.agent_activity.status_running)).toBeInTheDocument();
  });
});
