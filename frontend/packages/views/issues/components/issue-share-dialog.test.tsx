import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enIssues from "../../locales/en/issues.json";
import { IssueShareDialog } from "./issue-share-dialog";

const { getIssueShare, createIssueShare, extendIssueShare, revokeIssueShare } = vi.hoisted(() => ({
  getIssueShare: vi.fn(),
  createIssueShare: vi.fn(),
  extendIssueShare: vi.fn(),
  revokeIssueShare: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({
  api: {
    getIssueShare,
    createIssueShare,
    extendIssueShare,
    revokeIssueShare,
  },
}));

vi.mock("../../navigation", () => ({
  useNavigation: () => ({
    getShareableUrl: (path: string) => `https://remi.example${path}`,
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const TEST_RESOURCES = { en: { issues: enIssues } };

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <IssueShareDialog issueId="issue-1" open onOpenChange={vi.fn()} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getIssueShare.mockReset().mockResolvedValue(null);
  createIssueShare.mockReset().mockResolvedValue({
    token: "shr_1.signature",
    expires_at: "2026-10-13T00:00:00.000Z",
    view_count: 0,
    last_viewed_at: null,
    created_at: "2026-08-14T00:00:00.000Z",
  });
  extendIssueShare.mockReset();
  revokeIssueShare.mockReset();
});

describe("IssueShareDialog", () => {
  it("creates a default full-content link without a configuration form", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(await screen.findByText("Visible content matches the current issue. Viewers must sign in.")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create link" }));

    await waitFor(() => expect(createIssueShare).toHaveBeenCalledWith("issue-1"));
    expect(await screen.findByDisplayValue("https://remi.example/share/shr_1.signature")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Extend 60 days" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeInTheDocument();
  });
});
