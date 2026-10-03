import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { issueKeys } from "@multiremi/core/issues/queries";
import type { Issue } from "@multiremi/core/types";
import enIssues from "../../locales/en/issues.json";

const api = vi.hoisted(() => ({ listIssueDependencies: vi.fn(), addIssueDependency: vi.fn(),
  removeIssueDependency: vi.fn(), getIssue: vi.fn() }));
vi.mock("@multiremi/core/api", () => ({ api }));
vi.mock("@multiremi/core/hooks", () => ({ useWorkspaceId: () => "w" }));
vi.mock("../../modals/issue-picker-modal", () => ({
  IssuePickerModal: ({ open, onSelect }: { open: boolean; onSelect: (issue: { id: string }) => void }) =>
    open ? <button onClick={() => onSelect({ id: "prerequisite" })}>Select prerequisite</button> : null,
}));
import { IssueDependencyEditor } from "./issue-dependency-editor";

beforeEach(() => {
  vi.clearAllMocks();
  api.listIssueDependencies.mockResolvedValue([{ id: "dep", direction: "blocked_by",
    depends_on_issue_id: "prerequisite", depends_on_issue: { identifier: "MUL-1" } }]);
  api.getIssue.mockResolvedValue({ parent_issue_id: null });
  api.addIssueDependency.mockResolvedValue({});
  api.removeIssueDependency.mockResolvedValue({});
});

describe("dependency notice refresh", () => {
  it.each(["add", "remove"])("refreshes first-screen detail and parent children after %s", async action => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    render(<QueryClientProvider client={qc}><I18nProvider locale="en" resources={{ en: { issues: enIssues } }}>
      <IssueDependencyEditor issue={{ id: "i", parent_issue_id: "parent" } as Issue} />
    </I18nProvider></QueryClientProvider>);
    if (action === "add") {
      fireEvent.click(screen.getByRole("button", { name: "Add prerequisite" }));
      fireEvent.click(await screen.findByRole("button", { name: "Select prerequisite" }));
      await waitFor(() => expect(api.addIssueDependency).toHaveBeenCalledWith("i", "prerequisite"));
    } else {
      fireEvent.click(await screen.findByRole("button", { name: "Remove MUL-1" }));
      await waitFor(() => expect(api.removeIssueDependency).toHaveBeenCalledWith("i", "dep"));
    }
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: issueKeys.detail("w", "i") }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: issueKeys.dependencies("w", "i") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: issueKeys.children("w", "parent") });
  });
});
