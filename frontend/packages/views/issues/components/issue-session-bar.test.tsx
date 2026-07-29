import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Agent } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

const mockMutations = vi.hoisted(() => ({
  createSession: vi.fn(),
  createTask: vi.fn(),
  publishResult: vi.fn(),
}));

vi.mock("@multiremi/core/issues", () => ({
  useCreateIssueSession: () => ({
    mutateAsync: mockMutations.createSession,
    isPending: false,
  }),
  useCreateSessionTask: () => ({
    mutateAsync: mockMutations.createTask,
    isPending: false,
  }),
  usePublishSessionResult: () => ({
    mutateAsync: mockMutations.publishResult,
    isPending: false,
  }),
}));

// The real avatar pulls in hover cards, presence queries and workspace paths.
// What matters here is only that an avatar is rendered per agent row.
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">{actorType}:{actorId}</span>
  ),
}));

const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

import {
  NewSessionButton,
  SessionDelegateTaskDialog,
  SessionPublishResultDialog,
} from "./issue-session-bar";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    workspace_id: "ws-1",
    name: "Claude Agent",
    description: null,
    avatar_url: null,
    runtime_id: "rt-1",
    owner_id: "user-1",
    visibility: "workspace",
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as Agent;
}

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

describe("SessionDelegateTaskDialog", () => {
  const agents = [
    makeAgent(),
    makeAgent({ id: "agent-2", name: "Codex Agent" }),
    makeAgent({ id: "agent-3", name: "Retired Agent", archived_at: "2026-02-01T00:00:00Z" }),
  ];

  function renderDialog(list: Agent[] = agents, onOpenChange = vi.fn()) {
    renderWithI18n(
      <SessionDelegateTaskDialog
        issueId="issue-1"
        issueSessionId="session-main"
        agents={list}
        open
        onOpenChange={onOpenChange}
      />,
    );
    return onOpenChange;
  }

  it("picks the agent through the shared picker rather than a native select", async () => {
    renderDialog();

    // A native <select> can carry neither an avatar nor a presence dot.
    expect(document.querySelector("select")).toBeNull();

    const trigger = screen.getByLabelText("Agent");
    expect(trigger).toHaveTextContent("Claude Agent");
    fireEvent.click(trigger);

    const codexRow = await screen.findByText("Codex Agent");
    // Archived agents are never delegable.
    expect(screen.queryByText("Retired Agent")).not.toBeInTheDocument();
    // Every row identifies its agent visually, not just by name.
    expect(screen.getAllByTestId("actor-avatar").length).toBeGreaterThan(1);

    fireEvent.click(codexRow);
    await waitFor(() => expect(screen.getByLabelText("Agent")).toHaveTextContent("Codex Agent"));

    fireEvent.change(screen.getByLabelText("Task"), {
      target: { value: "Ship the migration" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delegate" }));

    await waitFor(() =>
      expect(mockMutations.createTask).toHaveBeenCalledWith({
        agentId: "agent-2",
        prompt: "Ship the migration",
      }),
    );
  });

  it("explains the dead end instead of showing an empty picker", () => {
    renderDialog([makeAgent({ archived_at: "2026-02-01T00:00:00Z" })]);

    expect(
      screen.getByText("This workspace has no agents yet. Create one before delegating work."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delegate" })).toBeDisabled();
  });

  it("offers an explicit cancel", () => {
    const onOpenChange = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("surfaces a delegate failure as a toast", async () => {
    mockMutations.createTask.mockRejectedValueOnce(new Error("runtime offline"));
    renderDialog();

    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "do it" } });
    fireEvent.click(screen.getByRole("button", { name: "Delegate" }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith("runtime offline"));
  });
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
      expect(mockMutations.createSession).toHaveBeenCalledWith({ title: "Implementation" }),
    );
    expect(onCreated).toHaveBeenCalledWith("session-2");
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

describe("SessionPublishResultDialog", () => {
  it("labels both fields and publishes", async () => {
    mockMutations.publishResult.mockResolvedValue({ id: "result-1" });
    const onOpenChange = vi.fn();
    renderWithI18n(
      <SessionPublishResultDialog
        issueId="issue-1"
        issueSessionId="session-main"
        open
        onOpenChange={onOpenChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Title (optional)"), {
      target: { value: "Architecture decision" },
    });
    fireEvent.change(screen.getByLabelText("Result"), {
      target: { value: "Append-only log." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(mockMutations.publishResult).toHaveBeenCalledWith({
        title: "Architecture decision",
        body: "Append-only log.",
      }),
    );
  });
});
