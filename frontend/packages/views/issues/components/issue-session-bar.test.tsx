import { describe, expect, it, vi, beforeEach } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { CreateIssueSessionRequest, IssueSession } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

const mockMutations = vi.hoisted(() => ({
  createSession: vi.fn(),
}));

vi.mock("@multiremi/core/issues", () => ({
  useCreateIssueSession: () => {
    const [isPending, setPending] = useState(false);
    return {
      isPending,
      mutateAsync: async (input: CreateIssueSessionRequest) => {
        setPending(true);
        try {
          return await mockMutations.createSession(input);
        } finally {
          setPending(false);
        }
      },
    };
  },
}));

const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

import { NewSessionButton } from "./issue-session-bar";

function makeSession(overrides: Partial<IssueSession> = {}): IssueSession {
  return {
    id: "main", issue_id: "issue-1", workspace_id: "workspace-1", title: "Main",
    status: "active", is_default: true, holds_workspace: true,
    parent_session_id: null, inherit_mode: "none", inherit_cutoff_seq: null,
    inherited_event_count: 0, summary: null, created_by_type: "member",
    created_by_id: null, created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z", participants: [], ...overrides,
  };
}

const sessions = [
  makeSession({ id: "work", title: "Implementation", is_default: false }),
  makeSession(),
  makeSession({ id: "side", title: "Existing side chat", is_default: false, parent_session_id: "main", inherit_mode: "snapshot" }),
];

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
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} onCreated={onCreated} />);

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
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={[]} />);

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
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} />);

    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument(),
    );
    expect(mockMutations.createSession).not.toHaveBeenCalled();
  });

  it("explains both session types and only offers inheritance for discussion sessions", async () => {
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));

    expect(await screen.findByRole("button", { name: "Work" })).toHaveAccessibleDescription(enIssues.detail.session_type_working_description);
    expect(screen.getByRole("button", { name: "Discussion" })).toHaveAccessibleDescription(enIssues.detail.session_type_discussion_description);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    expect(screen.getByRole("combobox", { name: enIssues.detail.session_inherit_from })).toHaveValue("main");
    expect(screen.getByRole("option", { name: "Implementation" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: enIssues.detail.main_session })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: enIssues.detail.session_inherit_none })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Existing side chat" })).not.toBeInTheDocument();
  });

  it("creates a discussion inheriting from the default main session", async () => {
    mockMutations.createSession.mockResolvedValue({ id: "new-side" });
    const onCreated = vi.fn();
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "  Review  " } });
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockMutations.createSession).toHaveBeenCalledWith({
      title: "Review", holds_workspace: false, parent_session_id: "main",
    }));
    expect(onCreated).toHaveBeenCalledWith("new-side");
  });

  it("allows choosing a different parent or no inheritance", async () => {
    mockMutations.createSession.mockRejectedValueOnce(new Error("Try again"));
    mockMutations.createSession.mockResolvedValueOnce({ id: "discussion" });
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "Review" } });
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("Try again"));
    expect(mockMutations.createSession).toHaveBeenNthCalledWith(1, {
      title: "Review", holds_workspace: false, parent_session_id: "work",
    });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockMutations.createSession).toHaveBeenNthCalledWith(2, {
      title: "Review", holds_workspace: false,
    }));
  });

  it("omits the parent after switching back to Work", async () => {
    mockMutations.createSession.mockResolvedValue({ id: "new-work" });
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "Implementation" } });
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(mockMutations.createSession).toHaveBeenCalledWith({
      title: "Implementation", holds_workspace: true,
    }));
  });

  it("resets the form when reopened after cancellation", async () => {
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "Cancelled" } });
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "work" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(await screen.findByLabelText("Session name")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Work" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Discussion" }));
    expect(screen.getByRole("combobox")).toHaveValue("main");
  });

  it("defaults to Main when sessions finish loading without overriding an explicit no-inheritance choice", async () => {
    const view = renderWithI18n(<NewSessionButton issueId="issue-1" sessions={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discussion" }));
    expect(screen.getByRole("combobox")).toHaveValue("");

    const updateSessions = (nextSessions: IssueSession[]) => view.rerender(
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <NewSessionButton issueId="issue-1" sessions={nextSessions} />
      </I18nProvider>,
    );
    updateSessions(sessions);
    expect(screen.getByRole("combobox")).toHaveValue("main");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    updateSessions([...sessions]);
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("keeps the pending form open and prevents duplicate creation until the request completes", async () => {
    let resolveCreation!: (session: { id: string }) => void;
    mockMutations.createSession.mockReturnValueOnce(new Promise((resolve) => { resolveCreation = resolve; }));
    const onCreated = vi.fn();
    renderWithI18n(<NewSessionButton issueId="issue-1" sessions={sessions} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(await screen.findByLabelText("Session name"), { target: { value: "Pending" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByLabelText("Session name")).toHaveValue("Pending");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    fireEvent.keyDown(screen.getByLabelText("Session name"), { key: "Enter" });
    expect(mockMutations.createSession).toHaveBeenCalledTimes(1);

    await act(async () => resolveCreation({ id: "created" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCreated).toHaveBeenCalledWith("created");
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(await screen.findByLabelText("Session name")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
