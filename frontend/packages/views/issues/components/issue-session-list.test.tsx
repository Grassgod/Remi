import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { Agent, IssueSession } from "@multiremi/core/types";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { common: enCommon, issues: enIssues } };

// Mirrors the TanStack shape the component reads: one mutation object shared
// by every row, so `isPending` alone can't say *which* row is in flight.
const addParticipantState = vi.hoisted(() => ({
  mutate: vi.fn(),
  isPending: false,
  variables: undefined as { participantType: string; participantId: string } | undefined,
}));

vi.mock("@multiremi/core/issues", () => ({
  useAddSessionParticipant: () => addParticipantState,
}));

// The session bar has its own spec; stub it so this file only exercises the rail.
vi.mock("./issue-session-bar", () => ({
  NewSessionButton: () => <button type="button">New session</button>,
  SessionDelegateTaskDialog: () => null,
  SessionPublishResultDialog: () => null,
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorType, actorId }: { actorType: string; actorId: string }) => (
    <span data-testid="actor-avatar">{actorType}:{actorId}</span>
  ),
}));

const mockToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock("sonner", () => ({ toast: mockToast }));

import { IssueSessionList } from "./issue-session-list";

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

function makeSession(overrides: Partial<IssueSession> = {}): IssueSession {
  return {
    id: "session-main",
    issue_id: "issue-1",
    workspace_id: "ws-1",
    title: "Main",
    status: "active",
    is_default: true,
    summary: null,
    created_by_type: "system",
    created_by_id: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    participants: [],
    ...overrides,
  };
}

const SESSIONS = [makeSession(), makeSession({ id: "session-2", title: "Review", is_default: false })];

async function openParticipants(agents: Agent[], sessions = SESSIONS) {
  render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <IssueSessionList
        issueId="issue-1"
        sessions={sessions}
        selectedSessionId="session-main"
        agents={agents}
        onSelectSession={vi.fn()}
      />
    </I18nProvider>,
  );
  fireEvent.click(screen.getAllByRole("button", { name: "Session actions" })[0]!);
  fireEvent.click(await screen.findByText("Session participants"));
  await screen.findByText("Add agent");
}

beforeEach(() => {
  vi.clearAllMocks();
  addParticipantState.isPending = false;
  addParticipantState.variables = undefined;
});

describe("SessionParticipantsDialog", () => {
  it("leaves every row idle when nothing is in flight", async () => {
    await openParticipants([
      makeAgent(),
      makeAgent({ id: "agent-2", name: "Codex Agent" }),
    ]);

    expect(document.querySelectorAll(".animate-spin")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Claude Agent/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Codex Agent/ })).toBeEnabled();
  });

  it("spins only the row that is actually being added and locks the rest", async () => {
    // The in-flight state TanStack reports while row 1's request is open.
    addParticipantState.isPending = true;
    addParticipantState.variables = { participantType: "agent", participantId: "agent-1" };

    await openParticipants([
      makeAgent(),
      makeAgent({ id: "agent-2", name: "Codex Agent" }),
    ]);

    const claudeRow = screen.getByRole("button", { name: /Claude Agent/ });
    const codexRow = screen.getByRole("button", { name: /Codex Agent/ });
    expect(claudeRow.querySelector(".animate-spin")).not.toBeNull();
    expect(codexRow.querySelector(".animate-spin")).toBeNull();
    // No duplicate adds may be fired while one is in flight.
    expect(codexRow).toBeDisabled();
  });

  it("toasts when adding a participant fails", async () => {
    await openParticipants([makeAgent()]);

    fireEvent.click(screen.getByRole("button", { name: /Claude Agent/ }));

    const [, options] = addParticipantState.mutate.mock.calls[0]!;
    expect(typeof options.onError).toBe("function");

    options.onError(new Error("forbidden"));
    expect(mockToast.error).toHaveBeenCalledWith("forbidden");

    options.onError({});
    expect(mockToast.error).toHaveBeenLastCalledWith("Failed to add participant");
  });

  it("says why there is nothing to add: workspace has no agents", async () => {
    await openParticipants([makeAgent({ archived_at: "2026-02-01T00:00:00Z" })]);

    expect(
      screen.getByText("This workspace has no agents yet. Create one before delegating work."),
    ).toBeInTheDocument();
  });

  it("says why there is nothing to add: everyone is already in the session", async () => {
    const sessions = [
      makeSession({
        participants: [{ participant_type: "agent", participant_id: "agent-1" }],
      } as Partial<IssueSession>),
      SESSIONS[1]!,
    ];
    await openParticipants([makeAgent()], sessions);

    expect(
      screen.getByText("Every agent in this workspace is already in this session."),
    ).toBeInTheDocument();
  });

  it("bounds the agent list so a big workspace stays reachable", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      makeAgent({ id: `agent-${i}`, name: `Agent ${i}` }),
    );
    await openParticipants(many);

    const list = screen.getByRole("button", { name: /Agent 0/ }).parentElement!;
    expect(list.className).toContain("max-h-64");
    expect(list.className).toContain("overflow-y-auto");
  });
});
