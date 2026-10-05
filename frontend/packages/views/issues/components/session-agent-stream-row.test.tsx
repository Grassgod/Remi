import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import type { AgentTask } from "@multiremi/core/types/agent";
import enAgents from "../../locales/en/agents.json";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { agents: enAgents, common: enCommon, issues: enIssues } };

const { getAgent, getTaskPrompt, getTaskTrace, listRuntimes, listTasksByIssue } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getTaskPrompt: vi.fn(),
  getTaskTrace: vi.fn(),
  listRuntimes: vi.fn(),
  listTasksByIssue: vi.fn(),
}));

vi.mock("@multiremi/core/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/api")>(),
  api: { getAgent, getTaskPrompt, getTaskTrace, listRuntimes, listTasksByIssue },
}));

vi.mock("@multiremi/core/realtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@multiremi/core/realtime")>(),
  useTraceStreamSubscription: vi.fn(),
}));

vi.mock("@multiremi/core/workspace/hooks", () => ({
  useActorName: () => ({
    getActorName: (_type: string, id: string) => (id ? `Agent ${id}` : "Agent"),
    getActorInitials: () => "AG",
    getActorAvatarUrl: () => null,
  }),
}));

vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: ({ actorId }: { actorId: string }) => <span data-testid="actor-avatar">{actorId}</span>,
}));

import { SessionAgentStreamRow } from "./session-agent-stream-row";

const SESSION = "ses-1";

function task(over: Partial<AgentTask> = {}): AgentTask {
  return {
    id: "tsk_abc123",
    agent_id: "a1",
    runtime_id: "rt-1",
    issue_id: "issue-1",
    issue_session_id: SESSION,
    status: "running",
    priority: 0,
    dispatched_at: null,
    started_at: "2026-08-08T00:00:00Z",
    completed_at: null,
    result: null,
    error: null,
    created_at: "2026-08-08T00:00:00Z",
    ...over,
  } as AgentTask;
}

function renderRow(
  qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }),
) {
  const view = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en" resources={TEST_RESOURCES}>
        <SessionAgentStreamRow issueId="issue-1" issueSessionId={SESSION} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...view, qc };
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  getAgent.mockResolvedValue({});
  getTaskPrompt.mockResolvedValue(null);
  getTaskTrace.mockResolvedValue({ events: [], next_after_seq: 0, head: 0, eof: true, closed: false, source: "daemon", state: "ok" });
  listRuntimes.mockResolvedValue([]);
});

describe("session agent stream row", () => {
  it("loads trace history only after opening the execution dialog", async () => {
    listTasksByIssue.mockResolvedValue([task()]);
    getTaskTrace.mockResolvedValue({
      events: Array.from({ length: 61 }, (_, index) => ({
        seq: index + 1, ts: "2026-08-08T00:00:00Z", type: "tool_use", tool: "Bash",
      })),
      next_after_seq: 61, head: 61, eof: true, closed: false, source: "daemon", state: "ok",
    });
    renderRow();
    const row = await screen.findByText("Agent a1 is working");
    expect(getTaskTrace).not.toHaveBeenCalled();
    fireEvent.click(row.closest("button")!);

    await waitFor(() => expect(getTaskTrace).toHaveBeenCalledWith("tsk_abc123", 0, 200));
    expect(await screen.findByText("61 tool calls")).toBeInTheDocument();
  });

  it("announces the working agent with server progress without a trace observer", async () => {
    listTasksByIssue.mockResolvedValue([task({ progress_summary: "Running focused tests" })]);
    getTaskTrace.mockResolvedValue({ events: [
      { seq: 1, ts: "2026-08-08T00:00:00Z", type: "tool_use", tool: "Read", input: { file_path: "/a/b/c/d.ts" } },
      { seq: 2, ts: "2026-08-08T00:00:01Z", type: "tool_use", tool: "Bash", input: { command: "bun test" } },
    ], next_after_seq: 2, head: 2, eof: true, closed: false, source: "daemon", state: "ok" });

    renderRow();

    expect(await screen.findByText("Agent a1 is working")).toBeInTheDocument();
    expect(await screen.findByText("Running focused tests")).toBeInTheDocument();
    expect(getTaskTrace).not.toHaveBeenCalled();
  });

  it("keeps a queued agent visibly queued instead of calling it working", async () => {
    listTasksByIssue.mockResolvedValue([task({ status: "queued", runtime_id: null, started_at: null })]);

    renderRow();

    expect(await screen.findByText("Agent a1 is queued")).toBeInTheDocument();
    expect(screen.queryByText("Agent a1 is working")).not.toBeInTheDocument();
  });

  it("names the active task blocking a queued run", async () => {
    listTasksByIssue.mockResolvedValue([task({
      status: "queued",
      runtime_id: null,
      started_at: null,
      queue_blocker: {
        task_id: "tsk_blocking123",
        agent_id: "a2",
        agent_name: "Builder",
        issue_session_id: "ses-work",
        issue_session_title: "Implementation",
        reason: "issue_workspace",
      },
    })]);

    renderRow();

    expect(await screen.findByText(
      "Waiting for Builder in Implementation (tsk_blocking123)",
    )).toBeInTheDocument();
  });

  it("shows a dispatched task blocked on an Issue workspace as waiting, with the blocker", async () => {
    listTasksByIssue.mockResolvedValue([task({
      status: "dispatched",
      dispatched_at: "2026-08-08T00:00:20Z",
      started_at: null,
      created_at: "2026-08-08T00:00:00Z",
      queue_blocker: {
        task_id: "tsk_blocking123",
        agent_id: "a2",
        agent_name: "Builder",
        issue_session_id: SESSION,
        issue_session_title: "Implementation",
        reason: "issue_workspace",
      },
    })]);

    renderRow();

    expect(await screen.findByText("Agent a1 is waiting to start")).toBeInTheDocument();
    expect(await screen.findByText("Waiting for Builder in Implementation (tsk_blocking123)")).toBeInTheDocument();
    expect(screen.queryByText("Agent a1 is starting")).not.toBeInTheDocument();
  });

  it("shows an agent waiting for review instead of calling it working", async () => {
    listTasksByIssue.mockResolvedValue([task({ status: "awaiting_human" })]);

    renderRow();

    expect(await screen.findByText("Agent a1 is waiting for review")).toBeInTheDocument();
    expect(screen.queryByText("Agent a1 is working")).not.toBeInTheDocument();
  });

  it("shows nothing when the session has no active run", async () => {
    listTasksByIssue.mockResolvedValue([task({ status: "completed" })]);

    renderRow();

    await waitFor(() => expect(listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByText(/is working/)).not.toBeInTheDocument();
  });

  it("ignores runs belonging to another session, and unlinked runs entirely", async () => {
    listTasksByIssue.mockResolvedValue([
      task({ id: "other", issue_session_id: "ses-2" }),
      task({ id: "unlinked", issue_session_id: undefined }),
    ]);

    renderRow();

    await waitFor(() => expect(listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByText(/is working/)).not.toBeInTheDocument();
  });

  it("keeps a watched run visible as a failure instead of letting it vanish", async () => {
    listTasksByIssue.mockResolvedValue([task()]);
    const { qc } = renderRow();
    expect(await screen.findByText("Agent a1 is working")).toBeInTheDocument();

    // Next poll of the same stream: the run failed.
    listTasksByIssue.mockResolvedValue([task({ status: "failed" })]);
    await qc.invalidateQueries();

    expect(await screen.findByText("Agent a1 stopped — the run failed")).toBeInTheDocument();
    expect(screen.queryByText(/is working/)).not.toBeInTheDocument();
  });

  it("does not resurrect a run that already failed before the stream opened", async () => {
    listTasksByIssue.mockResolvedValue([task({ status: "failed" })]);

    renderRow();

    await waitFor(() => expect(listTasksByIssue).toHaveBeenCalled());
    expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
  });
});
