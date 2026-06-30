import { describe, it, expect } from "bun:test";
import {
  AcpProvider,
  resolveAcpExecutableForAgent,
  resolveAcpHealthCheckCommand,
  resolveAcpPermissionMode,
  resolveAvailableAcpPermissionMode,
  ClaudeAdapter,
} from "../../../src/acp/index.js";
import { CodexAdapter } from "../../../src/acp/index.js";
import { isAbsolute } from "node:path";

/**
 * codex resolution is machine-dependent: when no explicit/env executable is
 * given, the resolver discovers an installed codex-acp binary (e.g. under
 * ~/.npm-global/bin) and returns its absolute path; otherwise it returns the
 * provided fallback. Accept either so the test is hermetic across machines.
 */
function isCodexExecutable(resolved: string, fallback: string): boolean {
  return resolved === fallback || (isAbsolute(resolved) && resolved.endsWith("/codex-acp"));
}

describe("AcpProvider", () => {
  it("defaults Claude ACP sessions to bypassPermissions", () => {
    expect(resolveAcpPermissionMode("claude", null)).toBe("bypassPermissions");
    expect(resolveAcpPermissionMode("claude", undefined)).toBe("bypassPermissions");
    expect(resolveAcpPermissionMode("claude", "")).toBe("bypassPermissions");
  });

  it("preserves explicit ACP permission modes", () => {
    expect(resolveAcpPermissionMode("claude", "plan")).toBe("plan");
    expect(resolveAcpPermissionMode("claude", " bypassPermissions ")).toBe("bypassPermissions");
    expect(resolveAcpPermissionMode("claude", "bypass")).toBe("bypassPermissions");
  });

  it("does not invent a default mode for unknown ACP agents", () => {
    expect(resolveAcpPermissionMode("codex", null)).toBeNull();
  });

  it("passes through mode when agent advertises it", () => {
    expect(resolveAvailableAcpPermissionMode("default", {
      currentModeId: "default",
      availableModes: [{ id: "default", name: "Default" }],
    })).toBe("default");
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", {
      currentModeId: "bypassPermissions",
      availableModes: [{ id: "bypassPermissions", name: "Bypass" }, { id: "default", name: "Default" }],
    })).toBe("bypassPermissions");
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
    // codex with no explicit executable: fallback OR a discovered codex-acp binary.
    expect(isCodexExecutable(resolveAcpExecutableForAgent("codex", null, "codex-agent-acp"), "codex-agent-acp")).toBe(true);
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
    // codex with no explicit executable: fallback OR a discovered codex-acp binary.
    // codex-acp has no portable probe flag (npm boots a heavy app-server on
    // --help; the Rust build rejects --version), so the check is existence-only:
    // no args.
    const codexHealth = resolveAcpHealthCheckCommand("codex", null, "codex-acp");
    expect(codexHealth.args).toBeUndefined();
    expect(isCodexExecutable(codexHealth.command, "codex-acp")).toBe(true);
    // Explicit executable is always preserved verbatim.
    expect(resolveAcpHealthCheckCommand("codex", "/tmp/codex-acp", "codex-acp")).toEqual({
      command: "/tmp/codex-acp",
    });
    const claudeHealth = resolveAcpHealthCheckCommand("claude", null, "claude-agent-acp");
    expect(claudeHealth.command.endsWith("/bin/remi-claude-agent-acp")).toBe(true);
    expect(claudeHealth.args).toEqual(["--verify-patch"]);
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
