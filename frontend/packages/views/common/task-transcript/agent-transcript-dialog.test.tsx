import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { AgentTask } from "@multiremi/core/types/agent";
import { renderWithI18n } from "../../test/i18n";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import type { TimelineItem } from "./build-timeline";

const MISSING_COMMAND_LABEL = "Command not recorded (task from an older version)";

// agent_id / runtime_id are blank so the dialog skips its metadata fetches.
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

function bashStep(input?: Record<string, unknown>): TimelineItem[] {
  return [
    { seq: 1, type: "tool_use", tool: "Bash", toolCallId: "call-1", input },
    { seq: 2, type: "tool_result", tool: "Bash", toolCallId: "call-1", status: "completed", output: "ok" },
  ];
}

function renderTranscript(items: TimelineItem[]) {
  return renderWithI18n(
    <AgentTranscriptDialog open onOpenChange={() => {}} task={task} items={items} agentName="Remi" />,
  );
}

describe("transcript step card — Bash command", () => {
  it("renders the shell prompt with the command when the input carries one", () => {
    renderTranscript(bashStep({ command: "echo hi" }));

    expect(screen.getByText("$ echo hi")).toBeInTheDocument();
    expect(screen.queryByText(MISSING_COMMAND_LABEL)).not.toBeInTheDocument();
  });

  it("explains the gap instead of showing a bare $ when the step has no input", () => {
    renderTranscript(bashStep(undefined));

    expect(screen.getByText(MISSING_COMMAND_LABEL)).toBeInTheDocument();
    expect(screen.queryByText("$")).not.toBeInTheDocument();
  });

  it("explains the gap when the input is a terminal_id placeholder only", () => {
    renderTranscript(bashStep({ terminal_id: "term-1" }));

    expect(screen.queryByText("$")).not.toBeInTheDocument();
    expect(screen.getByText(MISSING_COMMAND_LABEL)).toBeInTheDocument();
  });

  it("leaves other tools untouched", () => {
    renderTranscript([
      { seq: 1, type: "tool_use", tool: "Read", toolCallId: "call-1", input: { file_path: "/a/b/c/d.ts" } },
    ]);

    expect(screen.getByText(".../c/d.ts")).toBeInTheDocument();
    expect(screen.queryByText(MISSING_COMMAND_LABEL)).not.toBeInTheDocument();
  });
});
