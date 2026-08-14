import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { IssueWorkspace } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };
const mockApiObj = vi.hoisted(() => ({ getIssueWorkspace: vi.fn() }));

vi.mock("@multiremi/core/api", () => ({
  api: mockApiObj,
  getApi: () => mockApiObj,
  setApiInstance: vi.fn(),
}));

import { IssueCodeWorkspaceSection } from "./issue-code-workspace-section";

const WORKSPACE: IssueWorkspace = {
  issue_id: "issue-31",
  workspace_id: "local",
  issue_key: "MUL-31",
  runtime_id: "runtime-1",
  runtime_name: "claude (build-host)",
  runtime_status: "online",
  root_path: "/data00/home/user/.remi/multiremi/workspaces/MUL-31",
  branch_name: "agent/MUL-31",
  status: "ready",
  repos: [{
    repo_url: "git@example.test:team/1passport.git",
    repo_name: "1passport",
    worktree_path: "/data00/home/user/.remi/multiremi/workspaces/MUL-31/1passport",
    branch_name: "agent/MUL-31",
    base_ref: "refs/remotes/origin/main",
    status: "ready",
    dirty: false,
    error: null,
  }],
  last_task_id: "task-1",
  cleaned_at: null,
  created_at: "2026-08-10T00:00:00Z",
  updated_at: "2026-08-10T00:00:00Z",
};

describe("IssueCodeWorkspaceSection", () => {
  it("shows a readable workspace root and repo-relative directories", async () => {
    mockApiObj.getIssueWorkspace.mockResolvedValue({ workspace: WORKSPACE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider resources={TEST_RESOURCES} locale="en">
          <IssueCodeWorkspaceSection issueId="issue-31" />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("~/.remi/multiremi/workspaces/MUL-31")).toBeInTheDocument();
    expect(screen.getByText("./1passport")).toBeInTheDocument();
    expect(screen.getByTitle(WORKSPACE.root_path)).toBeInTheDocument();
    expect(screen.getByTitle(WORKSPACE.repos[0]!.worktree_path)).toBeInTheDocument();
  });

  it("labels intake directories as read-only snapshots instead of showing an empty branch", async () => {
    const intakeWorkspace: IssueWorkspace = {
      ...WORKSPACE,
      issue_id: "issue-44",
      issue_key: "MUL-44",
      root_path: "/data00/home/user/.remi/multiremi/workspaces/MUL-44",
      branch_name: "",
      repos: [{
        ...WORKSPACE.repos[0]!,
        worktree_path: "/data00/home/user/.remi/multiremi/workspaces/MUL-44/projects/Remi/repos/1passport",
        branch_name: "",
        base_ref: "abc123",
      }],
    };
    mockApiObj.getIssueWorkspace.mockResolvedValue({ workspace: intakeWorkspace });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider resources={TEST_RESOURCES} locale="en">
          <IssueCodeWorkspaceSection issueId="issue-44" issueKind="intake" />
        </I18nProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Read-only project snapshot")).toBeInTheDocument();
    expect(screen.getByText("./projects/Remi/repos/1passport")).toBeInTheDocument();
    expect(screen.queryByText("Branch")).not.toBeInTheDocument();
  });
});
