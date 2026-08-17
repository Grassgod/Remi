import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentTask } from "@multiremi/core/types/agent";
import { renderWithI18n } from "../../test/i18n";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import type { TimelineItem } from "./build-timeline";

// The mention chips reach for workspace queries; stub them the way
// common/markdown.test.tsx does so this file stays about the wiring.
vi.mock("../../issues/components/issue-mention-card", () => ({
  IssueMentionCard: ({ issueId }: { issueId: string }) => (
    <span data-testid="issue-mention-card">{issueId}</span>
  ),
}));

const task: AgentTask = {
  id: "task-1",
  agent_id: "",
  runtime_id: "",
  issue_id: "",
  status: "completed",
  priority: 0,
  dispatched_at: null,
  started_at: null,
  completed_at: null,
  result: null,
  error: null,
  created_at: "2026-07-30T00:00:00Z",
};

function renderTranscript(items: TimelineItem[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <AgentTranscriptDialog
        open
        onOpenChange={() => {}}
        task={task}
        items={items}
        agentName="Remi"
      />
    </QueryClientProvider>,
  );
}

describe("transcript markdown", () => {
  // The transcript used to import the raw ui Markdown, so an @issue mention
  // in an agent's reply rendered as inert text while the same mention in a
  // chat message rendered as a card. Both now go through views/common/markdown.
  it("renders issue mentions as chips, like every other markdown surface", () => {
    renderTranscript([
      {
        seq: 1,
        type: "text",
        content: "Fixed in [MUL-42](mention://issue/issue-42).",
      },
    ]);

    expect(screen.getAllByTestId("issue-mention-card").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("issue-mention-card")[0]).toHaveTextContent(
      "issue-42",
    );
  });

  it("still renders ordinary prose", () => {
    renderTranscript([
      { seq: 1, type: "text", content: "Audit done: env vars win." },
    ]);

    expect(
      screen.getAllByText("Audit done: env vars win.").length,
    ).toBeGreaterThan(0);
  });
});
