import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

/** One collab rawInput from the real C0 capture, by verb + ACP frame status. */
function collabRawInput(title: string, status: string): Record<string, unknown> {
  const frames = JSON.parse(
    readFileSync(
      resolve(process.cwd(), "../../../tests/fixtures/acp/codex-collab-notifications-1786010059380.json"),
      "utf-8",
    ),
  ) as Array<{ params?: { update?: Record<string, unknown> } }>;
  const frame = frames
    .map((f) => f.params?.update)
    .find((u) => u?.title === title && u?.status === status);
  if (!frame) throw new Error(`no ${title}/${status} frame in the collab fixture`);
  return frame.rawInput as Record<string, unknown>;
}

function renderTranscript(
  items: TimelineItem[],
  overrides: { task?: Partial<AgentTask>; isLive?: boolean } = {},
) {
  return renderWithI18n(
    <AgentTranscriptDialog
      open
      onOpenChange={() => {}}
      task={{ ...task, ...overrides.task }}
      items={items}
      agentName="Remi"
      isLive={overrides.isLive}
    />,
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

describe("transcript codex collab step", () => {
  // Real C0 frames: the terminal `wait` carries the subagent's answer in
  // agentsStates[threadId].message and no output at all.
  const waitFinal = collabRawInput("wait", "completed");
  const waitThreadId = "019fd67f-032c-7d80-9eca-e69c0ae2d4a6";

  function collabStep(input: Record<string, unknown>): TimelineItem[] {
    return [
      { seq: 1, type: "tool_use", tool: "wait", toolCallId: "call-w", status: "in_progress", input },
      { seq: 2, type: "tool_result", tool: "wait", toolCallId: "call-w", status: "completed" },
    ];
  }

  it("summarizes the step by agent counts, never by a thread id", () => {
    renderTranscript(collabStep(waitFinal));

    expect(screen.getByText("1 done")).toBeInTheDocument();
    expect(screen.queryByText(waitFinal.senderThreadId as string)).not.toBeInTheDocument();
  });

  it("renders state chips, the subagent's answer as Markdown, and the ceiling caption", () => {
    renderTranscript(collabStep(waitFinal));

    fireEvent.click(screen.getByText("1 done"));

    // Chip: short thread id + status, full id only in its tooltip.
    const chip = screen.getByTitle(waitThreadId);
    expect(chip).toHaveTextContent(`${waitThreadId.slice(0, 8)}completed`);
    // The answer is a Markdown block, not a JSON dump.
    expect(screen.getByText(/Snow crowns silent peaks/)).toBeInTheDocument();
    expect(screen.getByText("Subagent internal activity is not captured")).toBeInTheDocument();
    // Receiver ids appear only in the muted list at the bottom, and the keys the
    // structured pane already showed are gone from the raw JSON block.
    expect(screen.getByText(waitThreadId)).toBeInTheDocument();
    expect(screen.queryByText(/"agentsStates"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/"senderThreadId"/)).not.toBeInTheDocument();
  });

  it("renders a delegation prompt as Markdown and degrades when states are empty", () => {
    const spawn = collabRawInput("spawnAgent", "in_progress");
    renderTranscript([
      { seq: 1, type: "tool_use", tool: "Agent", toolCallId: "call-s", status: "in_progress", input: spawn },
    ]);

    fireEvent.click(screen.getByText(`"${spawn.prompt as string}"`));

    // The header summary carries the quoted prompt; this exact (unquoted) match
    // can only be the Markdown paragraph in the detail pane.
    expect(screen.getByText(spawn.prompt as string)).toBeInTheDocument();
    expect(screen.getByText("Subagent internal activity is not captured")).toBeInTheDocument();
  });
});

describe("transcript step abandoned by a finished task", () => {
  // MUL-20: codex dropped call_pe1em… (only a tool_use, no terminal frame) and
  // retried under a new id. The orphan spun forever next to a completed task.
  const orphan: TimelineItem[] = [
    { seq: 1, type: "tool_use", tool: "Bash", toolCallId: "call-orphan", status: "in_progress", input: { command: "echo hi" } },
  ];

  const stepRow = () => screen.getByText("$ echo hi").closest("div.group")!;

  it("shows an unfinished step instead of a spinner once the task is done", () => {
    renderTranscript(orphan, { task: { status: "completed" } });

    expect(screen.getByText("Not finished")).toBeInTheDocument();
    expect(stepRow().querySelector(".animate-spin")).toBeNull();
  });

  it("treats cancelled and failed tasks the same way", () => {
    for (const status of ["cancelled", "failed"] as const) {
      const { unmount } = renderTranscript(orphan, { task: { status } });
      expect(screen.getByText("Not finished")).toBeInTheDocument();
      expect(stepRow().querySelector(".animate-spin")).toBeNull();
      unmount();
    }
  });

  it("keeps the spinner while the task is still live", () => {
    renderTranscript(orphan, { task: { status: "running" }, isLive: true });

    expect(screen.queryByText("Not finished")).not.toBeInTheDocument();
    expect(stepRow().querySelector(".animate-spin")).not.toBeNull();
  });

  it("leaves finished steps of a finished task untouched", () => {
    renderTranscript(bashStep({ command: "echo hi" }), { task: { status: "completed" } });

    expect(screen.queryByText("Not finished")).not.toBeInTheDocument();
    expect(stepRow().querySelector(".animate-spin")).toBeNull();
  });
});

describe("transcript subagent narrative", () => {
  // claude-agent-acp >= 0.66 forwards the subagent's own prose (gated on the
  // `subagent-transcript` capability); it belongs inside the Agent group.
  const withProse: TimelineItem[] = [
    { seq: 1, type: "tool_use", tool: "Agent", toolCallId: "agent-1", input: { description: "audit config" } },
    { seq: 2, type: "thinking", content: "I should read the loader first", meta: { parent_tool_call_id: "agent-1" } },
    {
      seq: 3,
      type: "tool_use",
      tool: "Read",
      toolCallId: "read-1",
      input: { file_path: "/repo/src/config.ts" },
      meta: { parent_tool_call_id: "agent-1" },
    },
    { seq: 4, type: "text", content: "## Finding\n\nEnv vars win.", meta: { parent_tool_call_id: "agent-1" } },
    { seq: 5, type: "tool_result", tool: "Agent", toolCallId: "agent-1", status: "completed", output: "done" },
  ];

  it("counts prose and tool steps together in the group badge", () => {
    renderTranscript(withProse);

    expect(screen.getByText("3 steps")).toBeInTheDocument();
    // Collapsed by default — the narrative is not loose in the timeline.
    expect(screen.queryByText("I should read the loader first")).not.toBeInTheDocument();
  });

  it("renders the subagent's thinking and prose inside the expanded group", () => {
    renderTranscript(withProse);

    fireEvent.click(screen.getByText('"audit config"'));

    expect(screen.getByText("I should read the loader first")).toBeInTheDocument();
    expect(screen.getByText(".../src/config.ts")).toBeInTheDocument();
    // Prose renders as Markdown, so the heading is a heading.
    expect(screen.getByRole("heading", { name: "Finding" })).toBeInTheDocument();
  });

  it("does not mistake subagent prose for this agent's final answer", () => {
    // The header shows the agent's own reply; the subagent's last line is not it.
    renderTranscript([
      ...withProse,
      { seq: 6, type: "text", content: "Audit done: env vars win." },
    ]);

    // Header + its own timeline row both show it; the point is that it wins.
    expect(screen.getAllByText("Audit done: env vars win.").length).toBeGreaterThan(0);
    // The subagent heading only exists inside the (collapsed) group.
    expect(screen.queryByRole("heading", { name: "Finding" })).not.toBeInTheDocument();
  });
});
