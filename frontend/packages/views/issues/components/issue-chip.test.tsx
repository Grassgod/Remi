import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@multiremi/core/types";

const mockApiObj = vi.hoisted(() => ({
  listIssues: vi.fn(),
  getIssue: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({
  api: mockApiObj,
  getApi: () => mockApiObj,
}));

vi.mock("@multiremi/core/hooks", () => ({
  useWorkspaceId: () => "ws-1",
}));

import { issueKeys } from "@multiremi/core/issues/queries";
import { IssueChip } from "./issue-chip";

const WS_ID = "ws-1";

function makeIssue(id: string, title: string): Issue {
  return {
    id,
    workspace_id: WS_ID,
    number: 7,
    identifier: "MUL-7",
    title,
    description: null,
    status: "todo",
    priority: "none",
    assignee_type: null,
    assignee_id: null,
    creator_type: "member",
    creator_id: "user-1",
    parent_issue_id: null,
    project_id: null,
    position: 1,
    start_date: null,
    due_date: null,
    labels: [],
    metadata: {},
    completed_at: null,
    archived_at: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
  } as Issue;
}

function renderChip(seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  const result = render(
    <QueryClientProvider client={queryClient}>
      <IssueChip issueId="issue-7" fallbackLabel="fallback" />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

// MUL-172. IssueChip renders inline for every issue mention in a comment body.
// It used to subscribe to the workspace issue list, so a single mention-heavy
// issue paid for the full per-board-status list fan-out. Fixing only the detail
// page would have left this path — and therefore most real issues — unchanged.
describe("IssueChip list fan-out (MUL-172 regression)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiObj.listIssues.mockResolvedValue({ issues: [], total: 0 });
    mockApiObj.getIssue.mockResolvedValue(makeIssue("issue-7", "From detail endpoint"));
  });

  it("never requests the issue list, falling back to the single-issue endpoint on a cache miss", async () => {
    renderChip();

    await waitFor(() => {
      expect(screen.getByText("From detail endpoint")).toBeInTheDocument();
    });

    expect(mockApiObj.listIssues).not.toHaveBeenCalled();
    expect(mockApiObj.getIssue).toHaveBeenCalledWith("issue-7");
  });

  it("issues no request at all when the list page already cached the issue under a sort", async () => {
    // The list page writes under `listSorted(wsId, sort)`. The chip has no sort
    // to pass, so a key-equality lookup would miss and refetch; the fix matches
    // on the shared prefix instead.
    renderChip((qc) => {
      qc.setQueryData(issueKeys.listSorted(WS_ID, { sort_by: "priority" }), {
        byStatus: {
          todo: { issues: [makeIssue("issue-7", "From cached list")], total: 1 },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByText("From cached list")).toBeInTheDocument();
    });

    expect(mockApiObj.listIssues).not.toHaveBeenCalled();
    expect(mockApiObj.getIssue).not.toHaveBeenCalled();
  });
});
