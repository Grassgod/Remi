import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TraceItem, TraceTurn } from "@multiremi/contracts/trace";
import type { AgentTask } from "@multiremi/core/types/agent";
import { renderWithI18n } from "../../test/i18n";
import {
  command, message, plan, read, reasoning, subagent, traceTurn, unknown, userMessage,
} from "../../test/trace-fixtures";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import type { TurnTraceReadInfo } from "./use-task-trace";

const getTurnInput = vi.hoisted(() => vi.fn());
const copyText = vi.hoisted(() => vi.fn());
vi.mock("@multiremi/ui/lib/clipboard", () => ({ copyText }));
vi.mock("@multiremi/core/api", () => ({
  api: {
    getTurnInput,
    getAgent: vi.fn(),
    listRuntimes: vi.fn(),
  },
}));

beforeEach(() => {
  getTurnInput.mockReset();
  copyText.mockReset();
  copyText.mockResolvedValue(true);
});

/** A `getTurnInput` result: the recorded prompt, or `sent_prompt: null` with the joined messages. */
function turnInput(prompt: string, extra: { sent_prompt?: string | null; instructions?: string | null } = {}) {
  return {
    from_seq: 2, to_seq: 5, messages: [], legacy_prompt: null,
    sent_attempt_id: extra.sent_prompt === null ? null : "task-1",
    sent_prompt: extra.sent_prompt === undefined ? prompt : extra.sent_prompt,
    instructions: extra.instructions ?? null,
    prompt,
  };
}

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

function renderTranscript(
  items: TraceItem[],
  overrides: {
    task?: Partial<AgentTask>; isLive?: boolean; initialView?: "execution" | "prompt"; promptFallback?: React.ReactNode;
    turn?: TraceTurn | null; traceRead?: TurnTraceReadInfo | null; onTraceRetry?: () => void; traceClosed?: boolean;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderWithI18n(
    <QueryClientProvider client={queryClient}>
      <AgentTranscriptDialog
        open
        onOpenChange={() => {}}
        task={{ ...task, ...overrides.task }}
        items={items}
        agentName="Remi"
        isLive={overrides.isLive}
        initialView={overrides.initialView}
        promptFallback={overrides.promptFallback}
        turn={overrides.turn}
        traceRead={overrides.traceRead}
        onTraceRetry={overrides.onTraceRetry}
        traceClosed={overrides.traceClosed}
      />
    </QueryClientProvider>,
  );
}

describe("transcript pending task state", () => {
  it("opens directly on Input Prompt when requested without an intermediate execution view", async () => {
    getTurnInput.mockResolvedValue(turnInput("Assignment instructions"));
    renderTranscript([], { initialView: "prompt" });
    expect(screen.getByRole("button", { name: "Input Prompt" })).toHaveAttribute("aria-pressed", "true");
    expect(getTurnInput).toHaveBeenCalledWith("task-1");
  });
  it("shows the task execution model beside its usage, including the fallback cause", () => {
    renderTranscript([], { task: {
      usage: [{ model: "primary", inputTokens: 240, outputTokens: 80 }],
      executionModel: "deepseek-flash", executionThinkingLevel: "high", fallbackSwitched: true,
      switchReason: "gateway_resource:agent_error.provider_no_available_account;provider_session_reset",
    } });
    expect(screen.getByText("deepseek-flash")).toBeInTheDocument();
    expect(screen.queryByText("primary")).toBeNull();
    expect(screen.getByText(/No available gateway account/)).toBeInTheDocument();
    expect(screen.getByText(/1 switch/)).toBeInTheDocument();
  });
  it("keeps legacy task usage separate from execution model identity", () => {
    renderTranscript([], { task: { usage: [{ model: "observed-backup", inputTokens: 7 }] } });
    expect(screen.queryByText("observed-backup")).toBeNull();
  });
  it("shows a queued task as waiting for a runtime, even if a caller marks the dialog live", () => {
    renderTranscript([], { task: { status: "queued" }, isLive: true });

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(screen.getByText("Waiting for an available runtime...")).toBeInTheDocument();
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for events...")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });
});

describe("task input prompt", () => {
  const steer = (id: string, text: string, injected = true) => ({
    ...userMessage(id, text), origin: "steer" as const, message_ids: [id],
    steer: { steer_id: id, kind: "steer", injected, author_type: "user", author_id: null,
      result: { via: injected ? "native" as const : "none" as const, native_outcome: injected ? "injected" as const : null, error: null } },
  });

  it("shows supplied assignment content only when the audited input is not recorded", async () => {
    getTurnInput.mockRejectedValue(Object.assign(new Error("prompt not recorded"), { status: 404 }));
    renderTranscript([], { initialView: "prompt", promptFallback: <p>Original assignment instructions</p> });
    expect(screen.queryByText("Original assignment instructions")).toBeNull();
    expect(await screen.findByText("Original assignment instructions")).toBeInTheDocument();
    expect(screen.queryByText(/older runtime/)).toBeNull();
  });

  it("treats a turn with nothing to show as not recorded", async () => {
    getTurnInput.mockResolvedValue(turnInput("", { sent_prompt: null }));
    renderTranscript([], { initialView: "prompt", promptFallback: <p>Original assignment instructions</p> });
    expect(await screen.findByText("Original assignment instructions")).toBeInTheDocument();
    expect(screen.queryByText("Sent to the agent this turn")).toBeNull();
  });

  it("prefers the audited input over the assignment fallback, without a raw seq range", async () => {
    getTurnInput.mockResolvedValue(turnInput("Audited execution instructions"));
    renderTranscript([], { initialView: "prompt", promptFallback: <p>Original assignment instructions</p> });
    expect(await screen.findByText("Audited execution instructions")).toBeInTheDocument();
    expect(screen.getByText("Sent to the agent this turn")).toBeInTheDocument();
    expect(screen.queryByText("(2, 5]")).toBeNull();
    expect(screen.queryByText(/SHA-256:/)).toBeNull();
    expect(screen.queryByText(/did not record the exact text/)).toBeNull();
    expect(screen.queryByText("Original assignment instructions")).toBeNull();
  });

  it.each([Object.assign(new Error("unavailable"), { status: 503 }), new Error("Network failure")])("keeps load errors instead of replacing them with an assignment", async (error) => {
    getTurnInput.mockRejectedValue(error);
    renderTranscript([], { initialView: "prompt", promptFallback: <p>Original assignment instructions</p> });
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText("Original assignment instructions")).toBeNull();
  });

  it("loads this attempt's exact prompt on demand and copies it", async () => {
    getTurnInput.mockResolvedValue(turnInput("Fix the review note.\n\n(Reply to comment msg_1)"));
    renderTranscript([], { task: { id: "attempt-2", turn_id: "turn-1" } });

    expect(getTurnInput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Input Prompt" }));

    await waitFor(() => expect(getTurnInput).toHaveBeenCalledWith("turn-1", "attempt-2"));
    expect(await screen.findByText(/Fix the review note\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    expect(copyText).toHaveBeenCalledWith("Fix the review note.\n\n(Reply to comment msg_1)");
  });

  it("asks for this attempt's input after a retry, the first attempt included", async () => {
    // The first attempt has the turn's id; without naming it the turn answers with its current, retried attempt.
    getTurnInput.mockResolvedValue(turnInput("First attempt"));
    const first = renderTranscript([], { task: { id: "turn-1", turn_id: "turn-1", status: "failed" }, initialView: "prompt" });
    await waitFor(() => expect(getTurnInput).toHaveBeenCalledWith("turn-1", "turn-1"));
    first.unmount();
    getTurnInput.mockReset();
    getTurnInput.mockResolvedValue(turnInput("Second attempt"));
    renderTranscript([], { task: { id: "attempt-2", turn_id: "turn-1", status: "completed" }, initialView: "prompt" });
    await waitFor(() => expect(getTurnInput).toHaveBeenCalledWith("turn-1", "attempt-2"));
  });

  it("asks for the turn alone when the task names no turn", async () => {
    getTurnInput.mockResolvedValue(turnInput("Queued request"));
    renderTranscript([], { task: { id: "turn-1", status: "queued" }, initialView: "prompt" });
    await waitFor(() => expect(getTurnInput).toHaveBeenCalledWith("turn-1"));
  });

  it("says when the exact text was not recorded and the turn's messages are shown", async () => {
    getTurnInput.mockResolvedValue(turnInput("First\n\nSecond", { sent_prompt: null }));
    renderTranscript([], { initialView: "prompt" });
    expect(await screen.findByText(/did not record the exact text it sent/)).toBeInTheDocument();
    expect(screen.getByText(/First/)).toBeInTheDocument();
  });

  it("shows the steers the agent received after the prompt, skipping one never delivered", async () => {
    getTurnInput.mockResolvedValue(turnInput("Initial request"));
    renderTranscript([
      userMessage("um_input", "Initial request"),
      steer("st_1", "Also update the docs"),
      steer("st_late", "Too late", false),
      command("cmd_1", [unknown("bun test")]),
      steer("st_2", "Skip the flaky test"),
    ], { initialView: "prompt" });

    const steers = await screen.findByRole("region", { name: "Sent during the turn" });
    expect([...steers.querySelectorAll('[data-prompt-part="steer"]')].map((node) => node.textContent))
      .toEqual(["Also update the docs", "Skip the flaky test"]);
    expect(screen.queryByText("Too late")).toBeNull();
  });

  it("renders Chat input in the text font and other input in monospace", async () => {
    getTurnInput.mockResolvedValue(turnInput("Hello there"));
    const { unmount } = renderTranscript([steer("st_1", "One more thing")], { task: { chat_session_id: "chat_1" }, initialView: "prompt" });
    const chatPrompt = await screen.findByText("Hello there");
    expect(chatPrompt.tagName).toBe("DIV");
    expect(chatPrompt).toHaveClass("text-sm", "whitespace-pre-wrap");
    expect(chatPrompt).not.toHaveClass("font-mono");
    expect(screen.getByText("One more thing")).not.toHaveClass("font-mono");
    unmount();

    renderTranscript([], { initialView: "prompt" });
    const issuePrompt = await screen.findByText("Hello there");
    expect(issuePrompt.tagName).toBe("PRE");
    expect(issuePrompt).toHaveClass("font-mono");
  });

  it("keeps the session instructions collapsed until asked", async () => {
    getTurnInput.mockResolvedValue(turnInput("Request", { instructions: "# Remi notes\n\nUse the remi CLI." }));
    renderTranscript([], { initialView: "prompt" });

    const toggle = await screen.findByRole("button", { name: "Session instructions" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Use the remi CLI/)).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Use the remi CLI/)).toBeInTheDocument();
    expect(screen.getByText(/Remi's part of this session's AGENTS\.md/)).toBeInTheDocument();
  });

  it("offers no session instructions when the attempt recorded none", async () => {
    getTurnInput.mockResolvedValue(turnInput("Request"));
    renderTranscript([], { initialView: "prompt" });
    expect(await screen.findByText("Request")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session instructions" })).toBeNull();
  });

  it("shows the trace status only on the execution tab", async () => {
    getTurnInput.mockResolvedValue(turnInput("Request"));
    renderTranscript([], { initialView: "prompt", traceRead: { state: "ok", format: "v2" }, onTraceRetry: () => {} });
    expect(await screen.findByText("Request")).toBeInTheDocument();
    expect(screen.queryByText("Live updates")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Execution" }));
    expect(screen.getByText("Live updates")).toBeInTheDocument();
  });

  it("shows a clear legacy empty state when no prompt was recorded", async () => {
    getTurnInput.mockRejectedValue(Object.assign(new Error("prompt not recorded"), { status: 404 }));
    renderTranscript([]);
    fireEvent.click(screen.getByRole("button", { name: "Input Prompt" }));

    expect(await screen.findByText(/No input prompt was recorded/)).toBeInTheDocument();
  });

  it("does not mislabel a transient load failure as a legacy task", async () => {
    getTurnInput.mockRejectedValue(Object.assign(new Error("unavailable"), { status: 503 }));
    renderTranscript([]);
    fireEvent.click(screen.getByRole("button", { name: "Input Prompt" }));

    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText(/older runtime/)).not.toBeInTheDocument();
  });
});

describe("transcript command item", () => {
  it("summarizes a command by its text and shows output and exit code in its detail", () => {
    renderTranscript([command("cmd_1", [unknown("bun test")], { status: "failed", exit_code: 1, output: "1 failed" })]);
    fireEvent.click(screen.getByText("bun test"));
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    expect(document.querySelector("[data-command-status]")).toHaveTextContent("Exit code 1");
  });

  it("redacts secrets in commands and output before they reach the DOM", () => {
    renderTranscript([command("cmd_1", [unknown("echo hi")], { command: "curl -H 'Authorization: Bearer abcdefghijklmnop'", output: "ghp_" + "x".repeat(36) })]);
    expect(document.body.textContent).not.toContain("abcdefghijklmnop");
    fireEvent.click(screen.getByText(/curl/));
    expect(document.body.textContent).not.toContain("ghp_");
  });
});

describe("transcript item abandoned by a finished task", () => {
  // MUL-20: an orphaned call that never got a terminal frame spun forever.
  const orphan = [command("cmd_orphan", [unknown("echo hi")], { status: "in_progress", completed_at: null, exit_code: null })];
  const row = () => document.querySelector('[data-transcript-item="cmd_orphan"]')!;

  it("shows an unfinished item instead of a spinner once the task is done", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      const { unmount } = renderTranscript(orphan, { task: { status } });
      expect(screen.getByText("Not finished")).toBeInTheDocument();
      expect(row().querySelector(".animate-spin")).toBeNull();
      unmount();
    }
  });

  it("keeps the spinner while the task is still live", () => {
    renderTranscript(orphan, { task: { status: "running" }, isLive: true });
    expect(screen.queryByText("Not finished")).not.toBeInTheDocument();
    expect(row().querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("transcript steer delivery", () => {
  const steer = (id: string, result: { via: "native" | "reprompt" | "none"; native_outcome: null | "injected"; error: null }) => ({
    ...userMessage(id, `steer ${id}`), origin: "steer" as const, message_ids: [id],
    steer: { steer_id: id, kind: "steer", injected: result.via !== "none", author_type: "user", author_id: null, result },
  });

  it("labels only a steer recorded without delivery", () => {
    renderTranscript([
      steer("st_native", { via: "native", native_outcome: "injected", error: null }),
      steer("st_late", { via: "none", native_outcome: null, error: null }),
    ]);
    expect(screen.getAllByText("Not delivered")).toHaveLength(1);
    const late = document.querySelector('[data-transcript-item="st_late"]')!;
    expect(late.textContent).toContain("Not delivered");
  });
});

describe("transcript subagent items", () => {
  const items = [
    subagent("agent_1", "audit config", { output: "## Finding\n\nEnv vars win." }),
    reasoning("rsn:c", "I should read the loader first", { parent_id: "agent_1" }),
    command("cmd_c", [read("/repo/src/config.ts")], { parent_id: "agent_1" }),
    message("msg:final", "Audit done: env vars win.", "final"),
  ];

  it("nests a subagent's own items under it, collapsed", () => {
    renderTranscript(items);
    expect(screen.getByText("2 steps")).toBeInTheDocument();
    expect(screen.queryByText("I should read the loader first")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("audit config"));
    expect(screen.getAllByText("I should read the loader first").length).toBeGreaterThan(0);
    expect(screen.getByText("cat /repo/src/config.ts")).toBeInTheDocument();
    // The report renders as Markdown, so the heading is a heading.
    expect(screen.getByRole("heading", { name: "Finding" })).toBeInTheDocument();
  });

  it("takes the final answer from the final item, never from a subagent", () => {
    renderTranscript([...items, message("msg:c", "child final", "final", { parent_id: "agent_1" })]);
    expect(screen.getByText("Final answer")).toBeInTheDocument();
    expect(screen.getAllByText("Audit done: env vars win.").length).toBeGreaterThan(0);
    expect(screen.queryByText("child final")).not.toBeInTheDocument();
  });
});

describe("transcript header from the turn", () => {
  it("reads the plan item, context usage, model and the tool count from the trace", () => {
    renderTranscript([
      plan([{ content: "Read the loader", status: "completed", priority: null }, { content: "Fix it", status: "pending", priority: null }]),
      command("cmd_1", [read("a.ts")]),
    ], { turn: traceTurn({ status: "completed", model: "gpt-5.5", context_usage: { used: 12_000, size: 200_000 },
      stats: { item_count: 2, tool_call_count: 7, process_item_count: 2, type_histogram: [] } }) });
    // The plan section's header, besides the plan item's own row.
    expect(screen.getAllByText("Plan").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Read the loader").length).toBeGreaterThan(0);
    expect(screen.getByText("7 tool calls")).toBeInTheDocument();
    expect(screen.getByText(/Context 12/)).toBeInTheDocument();
    expect(screen.getByText("gpt-5.5")).toBeInTheDocument();
  });

  it("shows nothing and no label for a legacy trace", () => {
    renderTranscript([], { turn: null, traceRead: { state: "ok", format: "legacy" }, onTraceRetry: () => {} });
    expect(screen.queryByText("No execution data recorded.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Execution finished/)).not.toBeInTheDocument();
  });
});
