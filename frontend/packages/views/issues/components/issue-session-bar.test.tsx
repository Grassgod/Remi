import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

const mockMutations = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock("@multiremi/core/issues", () => ({
  useCreateIssueSession: () => ({
    mutateAsync: mockMutations.createSession,
    isPending: false,
  }),
}));

const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

import { NewSessionButton } from "./issue-session-bar";

function renderWithI18n(node: React.ReactElement) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      {node}
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NewSessionButton", () => {
  it("labels its field and creates the session", async () => {
    mockMutations.createSession.mockResolvedValue({ id: "session-2" });
    const onCreated = vi.fn();
    renderWithI18n(<NewSessionButton issueId="issue-1" onCreated={onCreated} />);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(
      await screen.findByText(
        "A session keeps its own conversation and agent runs, separate from the others on this issue.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Implementation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockMutations.createSession).toHaveBeenCalledWith({
        title: "Implementation",
        holds_workspace: true,
      }),
    );
    expect(onCreated).toHaveBeenCalledWith("session-2");
  });

  it("creates a discussion session without the shared workspace", async () => {
    mockMutations.createSession.mockResolvedValue({ id: "session-2" });
    renderWithI18n(<NewSessionButton issueId="issue-1" />);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), {
      target: { value: "Architecture chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(mockMutations.createSession).toHaveBeenCalledWith({
        title: "Architecture chat",
        holds_workspace: false,
      }),
    );
  });

  it("closes without creating anything when cancelled", async () => {
    renderWithI18n(<NewSessionButton issueId="issue-1" />);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument(),
    );
    expect(mockMutations.createSession).not.toHaveBeenCalled();
  });
});

