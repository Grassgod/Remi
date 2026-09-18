import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const createSession = vi.hoisted(() => vi.fn());

vi.mock("@multiremi/core/issues", () => ({
  useAddSessionParticipant: () => addParticipantState,
  useCreateIssueSession: () => ({ mutateAsync: createSession, isPending: false }),
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
    parent_session_id: null,
    inherit_mode: "none",
    inherit_cutoff_seq: null,
    inherited_event_count: 0,
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

function renderRail(
  sessions: IssueSession[],
  agents: Agent[] = [],
  options: { selectedSessionId?: string; onSelectSession?: (sessionId: string) => void } = {},
) {
  return render(
    <I18nProvider locale="en" resources={TEST_RESOURCES}>
      <IssueSessionList
        issueId="issue-1"
        sessions={sessions}
        selectedSessionId={options.selectedSessionId ?? "session-main"}
        agents={agents}
        onSelectSession={options.onSelectSession ?? vi.fn()}
      />
    </I18nProvider>,
  );
}

async function openParticipants(agents: Agent[], sessions = SESSIONS) {
  renderRail(sessions, agents);
  fireEvent.click(screen.getAllByRole("button", { name: "Session actions" })[0]!);
  fireEvent.click(await screen.findByText("Session participants"));
  await screen.findByText("Add agent");
}

beforeEach(() => {
  vi.clearAllMocks();
  addParticipantState.isPending = false;
  addParticipantState.variables = undefined;
});

describe("IssueSessionList rail", () => {
  it("renders a single session as one highlighted row, header included", () => {
    renderRail([makeSession()]);

    // The rail is not conditional on having something to switch to.
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Main/ })).toBeInTheDocument();
    // Exactly one create-session control, in the header.
    const newSession = screen.getAllByRole("button", { name: "New session" });
    expect(newSession).toHaveLength(1);
    expect(screen.getByText("Sessions").parentElement).toContainElement(newSession[0]!);
  });

  it("offers participants and side chat in a regular session's row menu", async () => {
    // Publishing a result and delegating a task used to sit here too. Both are
    // agent-side actions driven from the CLI — members never used the buttons,
    // so the page no longer shows them (MUL-204).
    renderRail(SESSIONS);
    fireEvent.click(screen.getAllByRole("button", { name: "Session actions" })[0]!);

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Session participants", "Side chat"]);
  });

  it("opens a discussion prefilled with the chosen parent and selects the created side chat", async () => {
    createSession.mockResolvedValue({ id: "session-side" });
    const onSelectSession = vi.fn();
    renderRail(SESSIONS, [], { onSelectSession });
    fireEvent.click(screen.getAllByRole("button", { name: "Session actions" })[1]!);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Side chat" }));

    expect(await screen.findByRole("combobox")).toHaveValue("session-2");
    expect(screen.getByRole("button", { name: "Discussion" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Work" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Session name"), {
      target: { value: "Review side chat" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createSession).toHaveBeenCalledWith({
      title: "Review side chat",
      holds_workspace: false,
      parent_session_id: "session-2",
    }));
    expect(onSelectSession).toHaveBeenCalledWith("session-side");
  });

  it("does not offer side chat from an existing side session", async () => {
    renderRail([makeSession({ parent_session_id: "absent-parent" })]);
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Session participants"]);
  });

  it("groups children immediately after their parent with one indent and preserves selection", () => {
    const onSelectSession = vi.fn();
    renderRail([
      makeSession({ id: "side-1", title: "First side", is_default: false, parent_session_id: "session-main" }),
      SESSIONS[0]!,
      SESSIONS[1]!,
      makeSession({ id: "side-2", title: "Second side", is_default: false, parent_session_id: "session-main" }),
    ], [], { selectedSessionId: "side-2", onSelectSession });

    const rows = screen.getAllByRole("button", { name: /^(Main|First side|Second side|Review)/ });
    expect(rows.map((row) => row.querySelector(".text-xs")?.textContent)).toEqual([
      "Main", "First side", "Second side", "Review",
    ]);
    expect(rows[0]!.parentElement).not.toHaveClass("ml-3");
    expect(rows[1]!.parentElement).toHaveClass("ml-3");
    expect(rows[2]!.parentElement).toHaveClass("ml-3", "bg-accent");
    expect(rows[3]!.parentElement).not.toHaveClass("ml-3");
    fireEvent.click(rows[0]!);
    fireEvent.click(rows[2]!);
    expect(onSelectSession.mock.calls).toEqual([["session-main"], ["side-2"]]);
  });

  it("keeps an orphan side session visible as a flat, selectable row", () => {
    const onSelectSession = vi.fn();
    renderRail([
      makeSession({ id: "orphan", title: "Orphan", is_default: false, parent_session_id: "filtered-parent" }),
      SESSIONS[0]!,
    ], [], { onSelectSession });

    const orphan = screen.getByRole("button", { name: /^Orphan/ });
    expect(orphan.parentElement).not.toHaveClass("ml-3");
    fireEvent.click(orphan);
    expect(onSelectSession).toHaveBeenCalledWith("orphan");
  });

  it("shows the inherited raw event range using the parent's display name", () => {
    renderRail([
      makeSession({ title: "Stored default title" }),
      makeSession({ id: "side", title: "Side", is_default: false, parent_session_id: "session-main", inherited_event_count: 12 }),
      SESSIONS[1]!,
      makeSession({ id: "review-side", title: "Review side", is_default: false, parent_session_id: "session-2", inherited_event_count: 3 }),
    ]);

    expect(screen.getByText("Inherits Main 1–12")).toBeInTheDocument();
    expect(screen.getByText("Inherits Review 1–3")).toBeInTheDocument();
    expect(screen.queryByText(/Stored default title/)).not.toBeInTheDocument();
  });

  it("omits the inherited range when the count is zero or the parent is absent", () => {
    renderRail([
      SESSIONS[0]!,
      makeSession({ id: "empty-side", title: "Empty side", is_default: false, parent_session_id: "session-main", inherited_event_count: 0 }),
      makeSession({ id: "orphan", title: "Orphan", is_default: false, parent_session_id: "absent-parent", inherited_event_count: 12 }),
    ]);

    expect(screen.getByRole("button", { name: /^Empty side/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Orphan/ })).toBeInTheDocument();
    expect(screen.queryByText(/^Inherits /)).not.toBeInTheDocument();
  });

  it("carries the scope as a tooltip so the narrow header can stay one word", () => {
    renderRail(SESSIONS);

    expect(screen.getByText("Sessions")).toHaveAttribute(
      "title",
      "Sessions on this issue",
    );
  });

  it("shows the localized name for the default session, not its stored title", () => {
    renderRail([
      makeSession({ title: "Main-RAW", is_default: true }),
      makeSession({ id: "session-2", title: "Review", is_default: false }),
    ]);

    expect(screen.getByText("Main")).toBeInTheDocument();
    expect(screen.queryByText("Main-RAW")).not.toBeInTheDocument();
    // A user-named session keeps exactly what the user typed.
    expect(screen.getByRole("button", { name: /^Review/ })).toBeInTheDocument();
  });
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
      screen.getByText("This workspace has no agents yet. Create one before adding participants."),
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
