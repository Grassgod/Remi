import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nProvider } from "@multiremi/core/i18n/react";
import { appendTaskMessagesToHydratedCache } from "@multiremi/core/chat/queries";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TaskMessagePayload } from "@multiremi/core/types/events";
import enAgents from "../../locales/en/agents.json";
import enCommon from "../../locales/en/common.json";
import enIssues from "../../locales/en/issues.json";

const TEST_RESOURCES = { en: { agents: enAgents, common: enCommon, issues: enIssues } };

const { getAgent, getTaskPrompt, listRuntimes, listTasksByIssue, listTaskMessages } = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getTaskPrompt: vi.fn(),
  listRuntimes: vi.fn(),
  listTasksByIssue: vi.fn(),
  listTaskMessages: vi.fn(),
}));

vi.mock("@multiremi/core/api", () => ({
  api: { getAgent, getTaskPrompt, listRuntimes, listTasksByIssue, listTaskMessages },
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

function message(over: Partial<TaskMessagePayload>): TaskMessagePayload {
  return { task_id: "tsk_abc123", issue_id: "issue-1", seq: 1, type: "tool_use", ...over } as TaskMessagePayload;
}

function productionMessages(): TaskMessagePayload[] {
  const types: Array<[TaskMessagePayload["type"], number]> = [
    ["tool_use", 61],
    ["tool_result", 60],
    ["usage", 137],
    ["plan", 11],
    ["text", 19],
  ];
  let seq = 0;
  return types.flatMap(([type, count]) =>
    Array.from({ length: count }, () => message({
      seq: ++seq,
      type,
      tool: type === "tool_use" ? "Bash" : undefined,
    })),
  );
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
  getAgent.mockResolvedValue({});
  getTaskPrompt.mockResolvedValue(null);
  listRuntimes.mockResolvedValue([]);
  listTaskMessages.mockResolvedValue([]);
});

describe("session agent stream row", () => {
  it("fetches the full 288-message history and shows all 61 tool calls", async () => {
    listTasksByIssue.mockResolvedValue([task()]);
    listTaskMessages.mockResolvedValue(productionMessages());
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    expect(appendTaskMessagesToHydratedCache(qc, "tsk_abc123", [
      message({ seq: 281 }),
      message({ seq: 283 }),
    ])).toBe(false);
    expect(qc.getQueryData(["task-messages", "tsk_abc123"])).toBeUndefined();

    renderRow(qc);

    const row = await screen.findByText("Agent a1 is working");
    await waitFor(() => expect(listTaskMessages).toHaveBeenCalledWith("tsk_abc123"));
    fireEvent.click(row.closest("button")!);

    expect(await screen.findByText("61 tool calls")).toBeInTheDocument();
  });

  it("announces the working agent with its current step", async () => {
    listTasksByIssue.mockResolvedValue([task()]);
    listTaskMessages.mockResolvedValue([
      message({ seq: 1, tool: "Read", input: { file_path: "/a/b/c/d.ts" } }),
      message({ seq: 2, tool: "Bash", input: { command: "bun test" } }),
    ]);

    renderRow();

    expect(await screen.findByText("Agent a1 is working")).toBeInTheDocument();
    // The latest tool call, summarized the same way the transcript does it.
    expect(await screen.findByText("$ bun test")).toBeInTheDocument();
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
