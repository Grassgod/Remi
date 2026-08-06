import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
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

  it("renders a slash-heavy command verbatim rather than as a compressed path", () => {
    renderTranscript(bashStep({ command: 'grep -rn "foo" ./src | head -30 > /dev/null' }));

    expect(screen.getByText('$ grep -rn "foo" ./src | head -30 > /dev/null')).toBeInTheDocument();
    expect(screen.queryByText("$ .../dev/null")).not.toBeInTheDocument();
  });

  it("renders a multiline command as its first line plus a dropped-line count", () => {
    renderTranscript(bashStep({ command: "cd frontend/packages/views\nbun run test\nbun run lint" }));

    expect(screen.getByText("$ cd frontend/packages/views (+2)")).toBeInTheDocument();
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

describe("transcript subagent group", () => {
  const agentWithChild: TimelineItem[] = [
    { seq: 1, type: "tool_use", tool: "Agent", toolCallId: "agent-1", input: { description: "count files" } },
    {
      seq: 2,
      type: "tool_use",
      tool: "Glob",
      toolCallId: "glob-1",
      input: { pattern: "**/*.ts" },
      meta: { parent_tool_call_id: "agent-1" },
    },
    {
      seq: 3,
      type: "tool_result",
      tool: "Glob",
      toolCallId: "glob-1",
      status: "completed",
      output: "3 files",
      meta: { parent_tool_call_id: "agent-1" },
    },
    { seq: 4, type: "tool_result", tool: "Agent", toolCallId: "agent-1", status: "completed", output: "## Result\n\n3 files" },
  ];

  it("collapses the subagent's steps into the Agent group with a step count", () => {
    renderTranscript(agentWithChild);

    expect(screen.getByText("1 step")).toBeInTheDocument();
    // Collapsed by default: the child's summary isn't rendered yet.
    expect(screen.queryByText("**/*.ts")).not.toBeInTheDocument();
  });

  it("reveals the nested step and the Markdown report when the group is expanded", () => {
    renderTranscript(agentWithChild);

    fireEvent.click(screen.getByText('"count files"'));

    expect(screen.getByText("**/*.ts")).toBeInTheDocument();
    // The Agent's output is the subagent report — rendered as Markdown, so the
    // heading is a heading rather than a literal "## Result" line.
    expect(screen.getByRole("heading", { name: "Result" })).toBeInTheDocument();
  });

  it("keeps a step top-level when its parent is not in the transcript (old rows stay flat)", () => {
    renderTranscript([
      {
        seq: 1,
        type: "tool_use",
        tool: "Glob",
        toolCallId: "glob-1",
        input: { pattern: "**/*.ts" },
        meta: { parent_tool_call_id: "agent-gone" },
      },
    ]);

    expect(screen.getByText("**/*.ts")).toBeInTheDocument();
    expect(screen.queryByText("1 step")).not.toBeInTheDocument();
  });
});
