import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
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
  it("publishes late claude input while the call is running without repeating it on the result", () => {
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

    // The refining update carries the real args before the call finishes, so a
    // second tool_use refreshes the live step under the same call id.
    const refined = map(event(CLAUDE_BASH_REFINE));
    expect(refined).toHaveLength(1);
    expect(refined[0]).toMatchObject({
      type: "tool_use",
      toolCallId: use.toolCallId,
      status: "pending",
      tool: "Bash",
      input: {
        command: "echo hello_from_acp_test",
        description: "Echo test string",
        terminal_id: "term_42",
      },
      meta: { title: "echo hello_from_acp_test", kind: "execute" },
    });
    // The toolResponse-only frame carries neither output nor status either.
    expect(map(event(CLAUDE_BASH_TOOL_RESPONSE))).toEqual([]);

    const finished = map(event(CLAUDE_BASH_COMPLETED));
    expect(finished).toHaveLength(1);
    const result = finished[0]!;
    expect(result.type).toBe("tool_result");
    expect(result.toolCallId).toBe(use.toolCallId);
    expect(result.status).toBe("completed");
    expect(result.output).toBe(JSON.stringify("hello_from_acp_test"));
    // The running refresh already published this exact input, so the terminal
    // frame does not repeat it.
    expect(result.input).toBeUndefined();
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
    expect(finished[0]?.tool).toBe("Bash");
    // The use already showed the args, so the result doesn't repeat them.
    expect(finished[0]?.input).toBeUndefined();
    expect(finished[0]?.output).toBe(JSON.stringify({ formatted_output: "hello_from_acp_test\n", exit_code: 0 }));
  });

  it("lets a later refinement overwrite an earlier value instead of keeping the first", () => {
    const map = createEventMapper(createAdapter("claude"));

    map(event(CLAUDE_BASH_INITIAL));
    map(event({ ...CLAUDE_BASH_REFINE, rawInput: { command: "echo first", description: "first" } }));
    const refined = map(event({ ...CLAUDE_BASH_REFINE, rawInput: { command: "echo second" } }));
    const finished = map(event(CLAUDE_BASH_COMPLETED));

    expect(refined).toHaveLength(1);
    expect(finished).toHaveLength(1);
    // Last writer wins per key; keys no later event mentions survive.
    expect(refined[0]?.input).toMatchObject({
      command: "echo second",
      description: "first",
      terminal_id: "term_42",
    });
    expect(finished[0]?.input).toBeUndefined();
  });
});

// ─── Subagent attribution ───────────────────────────────────────────────────

const claudeTool = (
  sessionUpdate: "tool_call" | "tool_call_update",
  toolCallId: string,
  toolName: string,
  extra: Record<string, unknown> = {},
): ProviderEvent =>
  event({ sessionUpdate, toolCallId, _meta: { claudeCode: { toolName } }, ...extra });

const spawnAgent = (id: string) =>
  claudeTool("tool_call", id, "Agent", { status: "pending", rawInput: { description: "look around" } });

const finishAgent = (id: string) =>
  claudeTool("tool_call_update", id, "Agent", { status: "completed", rawOutput: "report" });

describe("daemon mapper subagent attribution", () => {
  it("attributes an inner call to the single open Agent on both the use and the result", () => {
    const map = createEventMapper(createAdapter("claude"));
    map(spawnAgent("agent_1"));

    const use = map(claudeTool("tool_call", "glob_1", "Glob", { status: "pending", rawInput: { pattern: "**/*.ts" } }));
    expect(use).toHaveLength(1);
    expect(use[0]?.meta?.parent_tool_call_id).toBe("agent_1");

    const result = map(claudeTool("tool_call_update", "glob_1", "Glob", { status: "completed", rawOutput: "3 files" }));
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("tool_result");
    expect(result[0]?.meta?.parent_tool_call_id).toBe("agent_1");
  });

  it("leaves an inner call flat when two Agents are open (parallel subagents)", () => {
    const map = createEventMapper(createAdapter("claude"));
    map(spawnAgent("agent_1"));
    map(spawnAgent("agent_2"));

    const use = map(claudeTool("tool_call", "glob_1", "Glob", { status: "pending", rawInput: { pattern: "*.ts" } }));
    expect(use[0]?.meta?.parent_tool_call_id).toBeUndefined();
  });

  it("leaves a call flat once the Agent reached a terminal status", () => {
    const map = createEventMapper(createAdapter("claude"));
    map(spawnAgent("agent_1"));
    map(finishAgent("agent_1"));

    const use = map(claudeTool("tool_call", "read_1", "Read", { status: "pending", rawInput: { file_path: "/a.ts" } }));
    expect(use[0]?.meta?.parent_tool_call_id).toBeUndefined();
  });

  it("never attributes a call that itself spawns an agent", () => {
    const map = createEventMapper(createAdapter("claude"));
    map(spawnAgent("agent_1"));

    const use = map(spawnAgent("agent_2"));
    expect(use[0]?.meta?.parent_tool_call_id).toBeUndefined();
  });

  it("decides attribution at the first event only", () => {
    const map = createEventMapper(createAdapter("claude"));
    // The Glob starts with no Agent open, so it stays flat forever — a later
    // event arriving while an Agent runs must not retro-attribute it.
    map(claudeTool("tool_call", "glob_1", "Glob", { status: "pending", rawInput: { pattern: "*.ts" } }));
    map(spawnAgent("agent_1"));

    const result = map(claudeTool("tool_call_update", "glob_1", "Glob", { status: "completed", rawOutput: "x" }));
    expect(result[0]?.type).toBe("tool_result");
    expect(result[0]?.meta?.parent_tool_call_id).toBeUndefined();
  });

  it("never attributes under the codex adapter, where a collab spawn does not block the caller", () => {
    const map = createEventMapper(createAdapter("codex"));

    // C0 fixture shape (tests/fixtures/acp/codex-collab-notifications-1786010059380.json):
    // codex-acp forwards a collab delegation as kind "other" / title "spawnAgent",
    // which the adapter normalizes to `Agent` — but unlike claude's Agent tool it
    // leaves the caller free to keep running its own tools.
    const spawn = map(event({
      sessionUpdate: "tool_call",
      toolCallId: "call_Cd4AlVGoR1OrcHqOcmpjR2mT",
      kind: "other",
      title: "spawnAgent",
      status: "in_progress",
      rawInput: {
        prompt: "Write exactly one original English-language haiku about the sea.",
        senderThreadId: "019fd67e-c843-7071-b5d6-66f42f33234c",
        receiverThreadIds: [],
        agentsStates: {},
        status: "inProgress",
      },
    }));
    // The gate, not a naming accident, is what keeps this flat.
    expect(spawn[0]?.tool).toBe("Agent");

    const use = map(event({
      sessionUpdate: "tool_call",
      toolCallId: "call_1H8nfQQ8OK2ITwHsXAfX5XU2",
      status: "in_progress",
      kind: "execute",
      title: "echo hello",
      rawInput: { command: "echo hello" },
    }));
    expect(use[0]?.meta?.parent_tool_call_id).toBeUndefined();

    const result = map(event({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1H8nfQQ8OK2ITwHsXAfX5XU2",
      status: "completed",
      rawOutput: { formatted_output: "hello\n", exit_code: 0 },
    }));
    expect(result[0]?.meta?.parent_tool_call_id).toBeUndefined();
  });

  it("nests the subagent's Glob under the Agent step in the recorded spawn fixture", () => {
    const frames = JSON.parse(
      readFileSync(new URL("../../fixtures/acp/agent-spawn-notifications-1777954686821.json", import.meta.url), "utf-8"),
    ) as Array<{ params?: { update?: Record<string, unknown> } }>;

    const map = createEventMapper(createAdapter("claude"));
    const emitted = frames.flatMap((frame) =>
      frame.params?.update ? map(event(frame.params.update)) : [],
    );

    const agentUse = emitted.find((m) => m.type === "tool_use" && m.tool === "Agent");
    const globMessages = emitted.filter((m) => m.tool === "Glob");
    expect(agentUse?.toolCallId).toBeTruthy();
    expect(globMessages.length).toBeGreaterThan(0);
    for (const message of globMessages) {
      expect(message.meta?.parent_tool_call_id).toBe(agentUse!.toolCallId!);
    }
    // The Agent step itself stays top-level.
    for (const message of emitted.filter((m) => m.tool === "Agent")) {
      expect(message.meta?.parent_tool_call_id).toBeUndefined();
    }
  });
});

// ─── Input refresh on the result ────────────────────────────────────────────

function replayFixture(name: string, agentType: string) {
  const frames = JSON.parse(
    readFileSync(new URL(`../../fixtures/acp/${name}`, import.meta.url), "utf-8"),
  ) as Array<{ params?: { update?: Record<string, unknown> } }>;
  const map = createEventMapper(createAdapter(agentType));
  return frames.flatMap((frame) => (frame.params?.update ? map(event(frame.params.update)) : []));
}

describe("daemon mapper input refresh", () => {
  it("carries the subagent's answer to the result in the recorded collab fixture", () => {
    // codex collab enriches an already-emitted input: the terminal `wait` frame
    // is the only place agentsStates[*].message (the subagent's verbatim answer)
    // ever appears, and no collab frame carries output at all.
    const emitted = replayFixture("codex-collab-notifications-1786010059380.json", "codex");

    const waitResults = emitted.filter((m) => m.type === "tool_result" && m.tool === "wait");
    expect(waitResults).toHaveLength(2);
    const answers = waitResults.flatMap((m) => {
      const states = (m.input?.agentsStates ?? {}) as Record<string, { message?: string }>;
      return Object.values(states).map((s) => s.message);
    });
    expect(answers).toEqual([
      "Snow crowns silent peaks\nClouds drift through the granite dawn\nPines breathe in valleys",
      "Salt winds comb the waves\nMoonlight drifts on deep water\nShells dream beneath foam",
    ]);

    // The spawn frames enrich too: the receiver list is empty on the initial
    // frame and only fills in when the call completes.
    const spawnUse = emitted.find((m) => m.type === "tool_use" && m.tool === "Agent");
    const spawnResult = emitted.find((m) => m.type === "tool_result" && m.tool === "Agent");
    expect(spawnUse?.input?.receiverThreadIds).toEqual([]);
    expect(spawnResult?.input?.receiverThreadIds).toEqual(["019fd67e-f5d8-7041-87ee-6f1d8d52280f"]);
  });

  it("still omits the input from a result whose input never changed", () => {
    const emitted = replayFixture("codex-bash-exec-notifications-1778495289225.json", "codex");

    const use = emitted.find((m) => m.type === "tool_use");
    const result = emitted.find((m) => m.type === "tool_result");
    expect(use?.input).toMatchObject({ command: "echo hello_from_acp_test" });
    // The initial frame already carried the args and nothing refined them.
    expect(result?.input).toBeUndefined();
  });
});

// ─── Bridge-forwarded attribution (claude-agent-acp >= 0.66) ────────────────

describe("daemon mapper real subagent attribution", () => {
  it("prefers the bridge's parentToolUseId over the time-window heuristic", () => {
    const map = createEventMapper(createAdapter("claude"));
    // Two Agents open: the heuristic refuses to guess, but the bridge told us.
    map(spawnAgent("agent_1"));
    map(spawnAgent("agent_2"));

    const use = map(event({
      sessionUpdate: "tool_call",
      toolCallId: "glob_1",
      _meta: { claudeCode: { toolName: "Glob", parentToolUseId: "agent_2" } },
      status: "pending",
      rawInput: { pattern: "*.ts" },
    }));
    expect(use[0]?.meta?.parent_tool_call_id).toBe("agent_2");

    const result = map(event({
      sessionUpdate: "tool_call_update",
      toolCallId: "glob_1",
      _meta: { claudeCode: { toolName: "Glob", parentToolUseId: "agent_2" } },
      status: "completed",
      rawOutput: "3 files",
    }));
    expect(result[0]?.meta?.parent_tool_call_id).toBe("agent_2");
  });

  it("keeps a real parent even where the heuristic would never fire (codex)", () => {
    const map = createEventMapper(createAdapter("codex"));

    const use = map(event({
      sessionUpdate: "tool_call",
      toolCallId: "call_child",
      _meta: { claudeCode: { parentToolUseId: "call_parent" } },
      status: "in_progress",
      kind: "execute",
      title: "echo hi",
      rawInput: { command: "echo hi" },
    }));
    expect(use[0]?.meta?.parent_tool_call_id).toBe("call_parent");
  });

  it("stamps the parent on the subagent's prose", () => {
    const map = createEventMapper(createAdapter("claude"));

    const thought = map(event({
      sessionUpdate: "agent_thought_chunk",
      _meta: { claudeCode: { parentToolUseId: "agent_1" } },
      content: { type: "text", text: "checking the loader" },
    }));
    expect(thought[0]).toMatchObject({ type: "thinking", meta: { parent_tool_call_id: "agent_1" } });

    const text = map(event({
      sessionUpdate: "agent_message_chunk",
      _meta: { claudeCode: { parentToolUseId: "agent_1" } },
      content: { type: "text", text: "env vars win" },
    }));
    expect(text[0]).toMatchObject({ type: "text", meta: { parent_tool_call_id: "agent_1" } });

    // The main agent's own prose stays unattributed, exactly as before.
    const main = map(event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }));
    expect(main[0]?.meta).toBeUndefined();
  });

  it("replays the claude subagent fixture into one nested group", () => {
    const emitted = replayFixture("claude-subagent-transcript-notifications-1786500000000.json", "claude");
    const agentUse = emitted.find((m) => m.type === "tool_use" && m.tool === "Agent");
    const parent = agentUse!.toolCallId!;

    // Every subagent-originated message — prose and tools alike — points at the
    // Agent call; the Agent step and the main agent's reply stay top-level.
    const attributed = emitted.filter((m) => m.meta?.parent_tool_call_id === parent);
    expect(attributed.map((m) => m.type)).toEqual([
      "thinking", "tool_use", "tool_result", "text",
    ]);
    const unattributed = emitted.filter((m) => !m.meta?.parent_tool_call_id);
    expect(unattributed.every((m) => m.tool === "Agent" || m.type === "text")).toBe(true);
  });

  it("maps codex subagent activity into paired steps", () => {
    const emitted = replayFixture("codex-subagent-activity-notifications-1786500000001.json", "codex");
    const start = emitted.filter((m) => m.toolCallId === "call_SubAgentStart01");
    expect(start.map((m) => m.type)).toEqual(["tool_use", "tool_result"]);
    expect(start[0]?.input).toMatchObject({
      agentThreadId: "01996f0c-1d2e-7a01-9f77-2b5c9f0a1c34",
      agentPath: "agents/reviewer",
      activityKind: "start",
    });
    expect(start[0]?.meta).toMatchObject({ title: "Start subagent reviewer", kind: "other" });

    // History replay: an already-completed initial frame still pairs.
    const replayed = emitted.filter((m) => m.toolCallId === "call_SubAgentReplay02");
    expect(replayed.map((m) => m.type)).toEqual(["tool_use", "tool_result"]);
  });
});
