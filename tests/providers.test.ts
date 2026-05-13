import { describe, it, expect } from "bun:test";
import { ClaudeCLIProvider } from "../src/providers/claude-cli/provider.js";
import { AcpProvider, resolveAcpExecutableForAgent, resolveAcpHealthCheckCommand, resolveAcpPermissionMode, resolveAvailableAcpPermissionMode } from "../src/providers/acp/provider.js";
import { ClaudeAdapter } from "../src/providers/acp/adapters/claude.js";
import { CodexAdapter } from "../src/providers/acp/adapters/codex.js";
import type { ToolUseRequest } from "../src/providers/claude-cli/protocol.js";
import type { ToolDefinition } from "../src/providers/base.js";

describe("ClaudeCLIProvider", () => {
  it("has correct name", () => {
    const provider = new ClaudeCLIProvider();
    expect(provider.name).toBe("claude_cli");
  });
});

describe("AcpProvider", () => {
  it("defaults Claude ACP sessions to auto permission mode", () => {
    expect(resolveAcpPermissionMode("claude", null)).toBe("auto");
    expect(resolveAcpPermissionMode("claude", undefined)).toBe("auto");
    expect(resolveAcpPermissionMode("claude", "")).toBe("auto");
  });

  it("preserves explicit ACP permission modes", () => {
    expect(resolveAcpPermissionMode("claude", "plan")).toBe("plan");
    expect(resolveAcpPermissionMode("claude", " bypassPermissions ")).toBe("bypassPermissions");
    expect(resolveAcpPermissionMode("claude", "bypass")).toBe("bypassPermissions");
  });

  it("does not invent a default mode for unknown ACP agents", () => {
    expect(resolveAcpPermissionMode("codex", null)).toBeNull();
  });

  it("falls back from Claude auto when the agent does not advertise it", () => {
    expect(resolveAvailableAcpPermissionMode("auto", {
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    })).toBe("default");
    expect(resolveAvailableAcpPermissionMode("auto", {
      currentModeId: "auto",
      availableModes: [{ id: "auto", name: "Auto" }, { id: "default", name: "Default" }],
    })).toBe("auto");
  });

  it("uses Remi's Claude ACP wrapper by default when available", () => {
    const previous = process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE;
    delete process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE;
    try {
      const resolved = resolveAcpExecutableForAgent("claude", null, "claude-agent-acp");
      expect(resolved.endsWith("/bin/remi-claude-agent-acp")).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE;
      else process.env.REMI_CLAUDE_AGENT_ACP_EXECUTABLE = previous;
    }
  });

  it("preserves explicit ACP executables", () => {
    expect(resolveAcpExecutableForAgent("claude", "/tmp/custom-agent", "claude-agent-acp")).toBe("/tmp/custom-agent");
    expect(resolveAcpExecutableForAgent("codex", null, "codex-agent-acp")).toBe("codex-agent-acp");
  });

  it("uses the Codex ACP executable environment override", () => {
    const previous = process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE;
    process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE = "/tmp/codex-acp";
    try {
      expect(resolveAcpExecutableForAgent("codex", null, "codex-acp")).toBe("/tmp/codex-acp");
    } finally {
      if (previous === undefined) delete process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE;
      else process.env.REMI_CODEX_AGENT_ACP_EXECUTABLE = previous;
    }
  });

  it("checks Codex ACP health via the Codex ACP executable", () => {
    expect(resolveAcpHealthCheckCommand("codex", null, "codex-acp")).toEqual({
      command: "codex-acp",
      args: ["--version"],
    });
    expect(resolveAcpHealthCheckCommand("codex", "/tmp/codex-acp", "codex-acp")).toEqual({
      command: "/tmp/codex-acp",
      args: ["--version"],
    });
    expect(resolveAcpHealthCheckCommand("claude", null, "claude-agent-acp")).toEqual({
      command: "claude",
      args: ["--version"],
    });
  });

  it("constructs an ACP Codex provider", () => {
    const provider = new AcpProvider({ agentType: "codex" });
    expect(provider.name).toBe("acp:codex");
    expect(provider.adapter.defaultExecutable()).toBe("codex-acp");
  });

  it("routes permission requests to the handler for the ACP session's chat", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    provider.setPermissionHandler(async () => ({ outcome: "selected", optionId: "global" }));
    provider.setPermissionHandler(async () => ({ outcome: "selected", optionId: "chat" }), "chat-1");
    provider["_sessionToChatId"].set("session-1", "chat-1");

    const result = await provider["_handlePermission"]({
      sessionId: "session-1",
      toolCall: { sessionUpdate: "tool_call_update", toolCallId: "tool-1" },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });

    expect(result).toEqual({ outcome: "selected", optionId: "chat" });
  });

  it("cancels permission requests when no handler is registered", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    const result = await provider["_handlePermission"]({
      sessionId: "session-1",
      toolCall: { sessionUpdate: "tool_call_update", toolCallId: "tool-1" },
      options: [
        { kind: "allow_once", name: "Allow", optionId: "allow" },
        { kind: "reject_once", name: "Reject", optionId: "reject" },
      ],
    });

    expect(result).toEqual({ outcome: "cancelled" });
  });
});

describe("Codex ACP adapter", () => {
  it("maps execute events to Bash and reconstructs command input", () => {
    const adapter = new CodexAdapter();
    const update = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "t1",
      kind: "execute" as const,
      title: "pwd",
      rawInput: JSON.stringify({ cmd: "pwd" }),
    };

    expect(adapter.resolveToolName(update)).toBe("Bash");
    expect(adapter.extractToolInput(update)).toEqual({ cmd: "pwd", command: "pwd" });
  });

  it("uses locations and diff content to reconstruct file input", () => {
    const adapter = new CodexAdapter();
    const update = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "t1",
      kind: "edit" as const,
      title: "Patch file",
      status: "in_progress" as const,
      locations: [{ path: "/tmp/example.ts", line: 7 }],
      content: [{ type: "diff" as const, path: "/tmp/example.ts", oldText: "old", newText: "new" }],
    };

    expect(adapter.resolveToolName(update)).toBe("Edit");
    expect(adapter.extractToolInput(update)).toEqual({
      file_path: "/tmp/example.ts",
      offset: 7,
      old_string: "old",
      new_string: "new",
    });
  });

  it("extracts AskUserQuestion data from rawInput", () => {
    const adapter = new CodexAdapter();
    const data = adapter.extractAskUserQuestion({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "AskUserQuestion",
      rawInput: JSON.stringify({
        questions: [{
          question: "Which framework?",
          header: "Framework",
          options: [{ label: "React", description: "Recommended" }, { label: "Vue" }],
          multiSelect: false,
        }],
      }),
    });

    expect(data).not.toBeNull();
    expect(data?.questions[0].question).toBe("Which framework?");
    expect(data?.questions[0].options).toHaveLength(2);
  });

  it("returns null for non-AskUserQuestion events", () => {
    const adapter = new CodexAdapter();
    expect(adapter.extractAskUserQuestion({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      kind: "execute",
      title: "pwd",
    })).toBeNull();
  });

  it("recognizes ExitPlanMode from tool name", () => {
    const adapter = new CodexAdapter();
    expect(adapter.isExitPlanMode({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "ExitPlanMode",
    })).toBe(true);
  });

  it("recognizes ExitPlanMode from switch_mode kind with plan title", () => {
    const adapter = new CodexAdapter();
    expect(adapter.isExitPlanMode({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      kind: "switch_mode",
      title: "Ready to code?",
    })).toBe(true);
  });

  it("does not treat regular switch_mode as ExitPlanMode", () => {
    const adapter = new CodexAdapter();
    expect(adapter.isExitPlanMode({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      kind: "switch_mode",
      title: "Switch to auto mode",
    })).toBe(false);
  });

  it("builds Codex session meta with model and approval mode", () => {
    const adapter = new CodexAdapter();
    const meta = adapter.buildSessionMeta({ model: "o3", permissionMode: "auto" });
    expect(meta).toEqual({
      codex: { options: { model: "o3", approval_mode: "auto" } },
    });
  });

  it("returns undefined session meta when no options provided", () => {
    const adapter = new CodexAdapter();
    expect(adapter.buildSessionMeta({})).toBeUndefined();
  });

  it("extracts result previews from raw output and terminal metadata", () => {
    const adapter = new CodexAdapter();
    const preview = adapter.extractResultPreview({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "pwd",
      kind: "execute",
      status: "completed",
      rawOutput: { exitCode: 0 },
      content: [{ type: "terminal", terminalId: "term-1" }],
      _meta: { terminal_output: { terminal_id: "term-1", data: "/data00/home/hehuajie/project/remi\n" } },
    });

    expect(preview).toContain("\"exitCode\":0");
    expect(preview).toContain("/data00/home/hehuajie/project/remi");
  });
});

describe("Claude ACP adapter", () => {
  it("extracts AskUserQuestion data from string rawInput", () => {
    const adapter = new ClaudeAdapter();
    const data = adapter.extractAskUserQuestion({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "AskUserQuestion",
      rawInput: JSON.stringify({
        questions: [{
          question: "Which DB?",
          header: "Database",
          options: [{ label: "PostgreSQL", description: "Recommended" }],
          multiSelect: false,
        }],
      }),
    });

    expect(data?.questions[0].question).toBe("Which DB?");
    expect(data?.questions[0].options[0].label).toBe("PostgreSQL");
  });

  it("recognizes ExitPlanMode by resolved tool name", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.isExitPlanMode({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      title: "ExitPlanMode",
    })).toBe(true);
  });

  it("recognizes Claude plan approval request instead of parsing Ready as Read", () => {
    const adapter = new ClaudeAdapter();
    const update = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "t1",
      title: "Ready to code?",
      kind: "switch_mode" as const,
      rawInput: { plan: "Test plan" },
    };

    expect(adapter.resolveToolName(update)).toBe("ExitPlanMode");
    expect(adapter.isExitPlanMode(update)).toBe(true);
  });
});

describe("ToolRegistration", () => {
  it("registers tool", () => {
    const provider = new ClaudeCLIProvider();
    const tool: ToolDefinition = {
      name: "test_tool",
      description: "A test tool",
      parameters: { input: { type: "string" } },
      handler: (input: unknown) => `Got: ${input}`,
    };
    provider.registerTool(tool);
    expect(provider["_tools"].has("test_tool")).toBe(true);
  });

  it("registers tools from dict", () => {
    const provider = new ClaudeCLIProvider();

    function readMemory(): string {
      return "memory content";
    }
    (readMemory as { __doc__?: string }).__doc__ = "Read the memory.";

    function writeMemory(content: string): string {
      return `Wrote: ${content}`;
    }

    provider.registerToolsFromDict({
      read_memory: readMemory,
      write_memory: writeMemory,
    });

    expect(provider["_tools"].has("read_memory")).toBe(true);
    expect(provider["_tools"].has("write_memory")).toBe(true);
    expect(provider["_tools"].get("read_memory")!.description).toBe("Read the memory.");
  });
});

describe("Hooks", () => {
  function makeProvider(): ClaudeCLIProvider {
    const p = new ClaudeCLIProvider();
    p.registerTool({
      name: "test_tool",
      description: "test",
      parameters: {},
      handler: () => "result",
    });
    return p;
  }

  it("pre hook allows", async () => {
    const provider = makeProvider();
    const hookCalled: string[] = [];
    provider.addPreToolHook((name) => {
      hookCalled.push(name);
    });

    const result = await provider._handleToolCall({
      kind: "tool_use",
      toolUseId: "t1",
      name: "test_tool",
      input: {},
    });
    expect(result).toBe("result");
    expect(hookCalled).toEqual(["test_tool"]);
  });

  it("pre hook blocks", async () => {
    const provider = makeProvider();
    provider.addPreToolHook(() => false);

    const result = await provider._handleToolCall({
      kind: "tool_use",
      toolUseId: "t1",
      name: "test_tool",
      input: {},
    });
    expect(result.toLowerCase()).toContain("blocked");
  });

  it("post hook called", async () => {
    const provider = makeProvider();
    const hookResults: Array<[string, string]> = [];
    provider.addPostToolHook((name, _inp, res) => {
      hookResults.push([name, res]);
    });

    await provider._handleToolCall({
      kind: "tool_use",
      toolUseId: "t1",
      name: "test_tool",
      input: {},
    });
    expect(hookResults).toEqual([["test_tool", "result"]]);
  });

  it("unknown tool returns null", async () => {
    const provider = makeProvider();
    const result = await provider._handleToolCall({
      kind: "tool_use",
      toolUseId: "t1",
      name: "nonexistent",
      input: {},
    });
    expect(result).toBeNull();
  });

  it("handles tool handler exception", async () => {
    const provider = new ClaudeCLIProvider();
    provider.registerTool({
      name: "bad_tool",
      description: "fails",
      parameters: {},
      handler: () => {
        throw new Error("boom");
      },
    });
    const result = await provider._handleToolCall({
      kind: "tool_use",
      toolUseId: "t1",
      name: "bad_tool",
      input: {},
    });
    expect(result).toContain("Tool error");
  });
});
