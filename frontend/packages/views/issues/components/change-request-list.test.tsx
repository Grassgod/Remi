import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { ScmChangeRequest } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

let changes: ScmChangeRequest[] = [];

vi.mock("@multiremi/core/scm", async () => {
  const actual = await vi.importActual<typeof import("@multiremi/core/scm")>(
    "@multiremi/core/scm",
  );
  return {
    ...actual,
    issueChangeRequestsOptions: (issueId: string) => ({
      queryKey: ["scm", "change-requests", issueId],
      queryFn: async () => ({ changeRequests: changes, total: changes.length }),
      enabled: Boolean(issueId),
    }),
  };
});

import { ChangeRequestList } from "./change-request-list";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

function makeChange(overrides: Partial<ScmChangeRequest> = {}): ScmChangeRequest {
  return {
    id: "change-1",
    workspaceId: "workspace-1",
    connectionId: "connection-1",
    repositoryId: "repository-1",
    repositoryName: null,
    repositoryOwner: null,
    repositoryUrl: null,
    provider: "github",
    externalId: "1",
    number: 1,
    title: "Update source control",
    body: null,
    state: "open",
    draft: false,
    url: "https://example.test/change/1",
    sourceBranch: "feat/source-control",
    targetBranch: "main",
    headSha: null,
    baseSha: null,
    author: "octocat",
    providerCreatedAt: null,
    providerUpdatedAt: null,
    closedAt: null,
    mergedAt: null,
    mergeSha: null,
    mergeableState: null,
    checksConclusion: null,
    checksPassed: 0,
    checksFailed: 0,
    checksPending: 0,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>{children}</I18nProvider>
    </QueryClientProvider>
  );
}

describe("ChangeRequestList", () => {
  it("renders GitHub pull requests and Codebase merge requests in one list", async () => {
    changes = [
      makeChange({ id: "github-1", provider: "github", number: 42, title: "Public change" }),
      makeChange({
        id: "codebase-1",
        provider: "codebase",
        externalId: "mr-internal-9",
        number: null,
        url: null,
        title: "Internal change",
        checksConclusion: "neutral_with_warnings",
      }),
    ];

    render(<ChangeRequestList issueId="issue-1" />, { wrapper: Wrapper });

    await screen.findByText("Public change");
    const rows = screen.getAllByTestId("change-request-row");
    expect(rows[0]).toHaveTextContent("GitHub PR #42");
    expect(rows[1]).toHaveTextContent("Codebase MR !mr-internal-9");
    expect(screen.getByText("Internal change").closest("a")).toBeNull();
    expect(screen.queryByText("Checks pending")).not.toBeInTheDocument();
  });

  it("labels each change request with its repository in multi-repo issues", async () => {
    changes = [
      makeChange({
        id: "bound-1",
        number: 4,
        repositoryName: "Remi",
        title: "Bound repository change",
      }),
      makeChange({
        id: "unbound-1",
        number: 7,
        repositoryId: "repository-2",
        url: "https://github.com/acme/personal_automation/pull/7",
        title: "Unbound repository change",
      }),
    ];

    render(<ChangeRequestList issueId="issue-repos" />, { wrapper: Wrapper });

    await screen.findByText("Bound repository change");
    const rows = screen.getAllByTestId("change-request-row");
    expect(rows[0]).toHaveTextContent("Remi · GitHub PR #4");
    expect(rows[1]).toHaveTextContent("personal_automation · GitHub PR #7");
  });

  it("collapses long provider-mixed lists and expands them on demand", async () => {
    const user = userEvent.setup();
    changes = Array.from({ length: 5 }, (_, index) => makeChange({
      id: `change-${index}`,
      provider: index % 2 === 0 ? "github" : "codebase",
      number: index + 1,
      title: `Change ${index + 1}`,
    }));

    render(<ChangeRequestList issueId="issue-2" />, { wrapper: Wrapper });

    expect(await screen.findByText("Change 1")).toBeInTheDocument();
    expect(screen.queryByText("Change 4")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getByText("Change 4")).toBeInTheDocument();
    expect(screen.getByText("Change 5")).toBeInTheDocument();
  });

  it("uses semantic status text and stats for a failed change", async () => {
    changes = [makeChange({ checksFailed: 1, checksPassed: 2, additions: 8, deletions: 3, changedFiles: 2 })];
    render(<ChangeRequestList issueId="issue-3" />, { wrapper: Wrapper });

    expect(await screen.findByText("Some checks failed")).toBeInTheDocument();
    expect(screen.getByText("+8")).toHaveClass("text-success");
    expect(screen.getByText("−3")).toHaveClass("text-destructive");
    expect(screen.getByText("2 files")).toBeInTheDocument();
  });

  it("uses the provider draft flag even when state remains open", async () => {
    changes = [makeChange({ draft: true, state: "open" })];
    render(<ChangeRequestList issueId="issue-4" />, { wrapper: Wrapper });

    expect(await screen.findByText("Draft · Checks haven't reported yet")).toBeInTheDocument();
    expect(screen.getByTestId("change-request-row")).toHaveClass("opacity-80");
  });
});
