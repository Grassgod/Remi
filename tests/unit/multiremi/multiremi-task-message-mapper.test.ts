import { describe, expect, it } from "bun:test";
import { createAdapter } from "@acp/index.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import { createEventMapper } from "@multiremi/daemon.js";

const event = (raw: Record<string, unknown>): ProviderEvent => raw as unknown as ProviderEvent;

/**
 * Real claude bridge shape (tests/fixtures/acp/bash-exec-notifications-1777958696235.json,
 * with the terminal content block current bridges attach): the initial
 * `tool_call` carries an empty rawInput and only a terminal id, and the real
 * command lands in the refining `tool_call_update`.
 */
const CLAUDE_BASH_INITIAL = {
  sessionUpdate: "tool_call",
  toolCallId: "toolu_01CvKucHXqsYLjC4BDsVQdxs",
  _meta: { claudeCode: { toolName: "Bash" } },
  rawInput: {},
  status: "pending",
  title: "Terminal",
  kind: "execute",
  content: [{ type: "terminal", terminalId: "term_42" }],
};

const CLAUDE_BASH_REFINE = {
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_01CvKucHXqsYLjC4BDsVQdxs",
  _meta: { claudeCode: { toolName: "Bash" } },
  rawInput: { command: "echo hello_from_acp_test", description: "Echo test string" },
  title: "echo hello_from_acp_test",
  kind: "execute",
  content: [{ type: "content", content: { type: "text", text: "Echo test string" } }],
};

const CLAUDE_BASH_TOOL_RESPONSE = {
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_01CvKucHXqsYLjC4BDsVQdxs",
  _meta: {
    claudeCode: {
      toolName: "Bash",
      toolResponse: { stdout: "hello_from_acp_test", stderr: "", interrupted: false },
    },
  },
};

const CLAUDE_BASH_COMPLETED = {
  sessionUpdate: "tool_call_update",
  toolCallId: "toolu_01CvKucHXqsYLjC4BDsVQdxs",
  _meta: { claudeCode: { toolName: "Bash" } },
  status: "completed",
  rawOutput: "hello_from_acp_test",
  content: [{ type: "content", content: { type: "text", text: "```console\nhello_from_acp_test\n```" } }],
};

describe("daemon task-message mapper", () => {
  it("keeps the claude terminal placeholder out of the tool_use and lands the real command on the result", () => {
    const map = createEventMapper(createAdapter("claude"));

    const initial = map(event(CLAUDE_BASH_INITIAL));
    expect(initial).toHaveLength(1);
    const use = initial[0]!;
    expect(use.type).toBe("tool_use");
    expect(use.tool).toBe("Bash");
    expect(use.status).toBe("pending");
    // The adapter can only resolve `{terminal_id}` here — that placeholder is
    // not the command, so it must not be emitted as the call's input (it would
    // pin the frontend's step card and the real command would never render).
    expect(use.input).toBeUndefined();
    expect(use.meta).toMatchObject({ title: "Terminal", kind: "execute", terminal_id: "term_42" });

    // The refining update carries the args but no output and no terminal
    // status, so it emits nothing on its own.
    expect(map(event(CLAUDE_BASH_REFINE))).toEqual([]);
    // The toolResponse-only frame carries neither output nor status either.
    expect(map(event(CLAUDE_BASH_TOOL_RESPONSE))).toEqual([]);

    const finished = map(event(CLAUDE_BASH_COMPLETED));
    expect(finished).toHaveLength(1);
    const result = finished[0]!;
    expect(result.type).toBe("tool_result");
    expect(result.toolCallId).toBe(use.toolCallId);
    expect(result.status).toBe("completed");
    expect(result.output).toBe(JSON.stringify("hello_from_acp_test"));
    // The merged input reaches the UI through the result (the use had none).
    expect(result.input).toMatchObject({
      command: "echo hello_from_acp_test",
      description: "Echo test string",
      terminal_id: "term_42",
    });
    expect(typeof result.meta?.duration_ms).toBe("number");

    // Fingerprint idempotency: a repeat of the same terminal frame stays silent.
    expect(map(event(CLAUDE_BASH_COMPLETED))).toEqual([]);
  });

  it("keeps a codex-shaped initial tool_call carrying its full input on the tool_use", () => {
    const map = createEventMapper(createAdapter("codex"));

    const initial = map(event({
      sessionUpdate: "tool_call",
      toolCallId: "call_1H8nfQQ8OK2ITwHsXAfX5XU2",
      status: "in_progress",
      kind: "execute",
      title: "echo hello_from_acp_test",
      content: [{ type: "terminal", terminalId: "call_1H8nfQQ8OK2ITwHsXAfX5XU2" }],
      rawInput: { command: "echo hello_from_acp_test", cwd: "/tmp/repo" },
    }));
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ type: "tool_use", tool: "Bash", status: "in_progress" });
    expect(initial[0]?.input).toMatchObject({ command: "echo hello_from_acp_test", cwd: "/tmp/repo" });

    const finished = map(event({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1H8nfQQ8OK2ITwHsXAfX5XU2",
      status: "completed",
      rawOutput: { formatted_output: "hello_from_acp_test\n", exit_code: 0 },
    }));
    expect(finished).toHaveLength(1);
    expect(finished[0]?.type).toBe("tool_result");
    // The use already showed the args, so the result doesn't repeat them.
    expect(finished[0]?.input).toBeUndefined();
    expect(finished[0]?.output).toBe(JSON.stringify({ formatted_output: "hello_from_acp_test\n", exit_code: 0 }));
  });

  it("lets a later refinement overwrite an earlier value instead of keeping the first", () => {
    const map = createEventMapper(createAdapter("claude"));

    map(event(CLAUDE_BASH_INITIAL));
    map(event({ ...CLAUDE_BASH_REFINE, rawInput: { command: "echo first", description: "first" } }));
    map(event({ ...CLAUDE_BASH_REFINE, rawInput: { command: "echo second" } }));
    const finished = map(event(CLAUDE_BASH_COMPLETED));

    expect(finished).toHaveLength(1);
    // Last writer wins per key; keys no later event mentions survive.
    expect(finished[0]?.input).toMatchObject({
      command: "echo second",
      description: "first",
      terminal_id: "term_42",
    });
  });
});
