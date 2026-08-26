import { describe, it, expect } from "bun:test";
import {
  AcpProvider,
  resolveAcpExecutableForAgent,
  resolveAcpHealthCheckCommand,
  resolveAcpPermissionMode,
  resolveAvailableAcpPermissionMode,
  ClaudeAdapter,
} from "@acp/index.js";
import { CodexAdapter } from "@acp/index.js";
import { resolveConfigOptionChange } from "@acp/provider.js";
import type { AgentAdapter, SessionConfigOption } from "@shared/contracts/acp-protocol.js";
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

  // Codex used to have no default, so an unconfigured codex chat stayed in
  // codex's own initial mode and prompted for every tool call. The literal id is
  // claude-flavored; CodexAdapter.mapPermissionMode turns it into
  // `agent-full-access`, so both agents now default the same way.
  it("defaults Codex ACP sessions to bypassPermissions too", () => {
    expect(resolveAcpPermissionMode("codex", null)).toBe("bypassPermissions");
    expect(resolveAvailableAcpPermissionMode(
      resolveAcpPermissionMode("codex", null),
      { currentModeId: "agent", availableModes: [{ id: "agent", name: "Agent" }, { id: "agent-full-access", name: "Full" }] },
      new CodexAdapter(),
    )).toBe("agent-full-access");
  });

  it("does not invent a default mode for unknown ACP agents", () => {
    expect(resolveAcpPermissionMode("gemini", null)).toBeNull();
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

  // codex-acp advertises read-only/agent/agent-full-access and rejects any
  // other id on session/set_mode with -32602, which used to kill every codex
  // session at startup (the resolver passed unadvertised modes through).
  it("maps claude-flavored modes onto codex-acp's advertised modes", () => {
    const codexModes = {
      currentModeId: "agent",
      availableModes: [
        { id: "read-only", name: "Read-only" },
        { id: "agent", name: "Agent" },
        { id: "agent-full-access", name: "Agent (full access)" },
      ],
    };
    const codex = new CodexAdapter();
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", codexModes, codex)).toBe("agent-full-access");
    expect(resolveAvailableAcpPermissionMode("dontAsk", codexModes, codex)).toBe("agent-full-access");
    expect(resolveAvailableAcpPermissionMode("acceptEdits", codexModes, codex)).toBe("agent");
    expect(resolveAvailableAcpPermissionMode("plan", codexModes, codex)).toBe("read-only");

    // Without the adapter (or with claude, which advertises our ids directly)
    // there is no translation, so an unadvertised id skips set_mode.
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", codexModes)).toBe(null);
    const claude: AgentAdapter = new ClaudeAdapter();
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", codexModes, claude)).toBe(null);
  });

  it("skips set_mode when the mode has no advertised equivalent", () => {
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", {
      currentModeId: "agent",
      availableModes: [{ id: "agent", name: "Agent" }],
    }, new CodexAdapter())).toBe(null);
  });

  it("passes the mode through when the agent reports no mode list", () => {
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", undefined)).toBe("bypassPermissions");
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", { currentModeId: "x", availableModes: [] })).toBe("bypassPermissions");
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

  it("exposes assistant text streamed for the active chat prompt", () => {
    const provider = new AcpProvider({ agentType: "claude" });
    expect(provider.getStreamedText("missing-chat")).toBe("");
    provider["_pool"].set("chat-1", {
      promptState: { text: "Decision context" },
    } as never);
    expect(provider.getStreamedText("chat-1")).toBe("Decision context");
  });

  it("keeps claude compaction statuses out of the final response text", async () => {
    const provider = new AcpProvider({ agentType: "claude" });
    const client = {
      _options: { onSessionUpdate: (_notification: unknown) => {} },
      prompt: async () => {
        for (const text of ["Final answer.", "Compacting...", "\n\nCompacting completed."]) {
          client._options.onSessionUpdate({
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
          });
        }
        return { stopReason: "end_turn" };
      },
      cancel: async () => {},
    };
    const entry = {
      client,
      acpSessionId: "session-1",
      lastUsed: Date.now(),
      promptState: { text: "" },
    };
    (provider as any)._ensureSession = async () => entry;

    const streamed: unknown[] = [];
    for await (const update of provider.sendStream("answer", { chatId: "chat-1" })) {
      streamed.push(update);
    }

    expect(streamed).toHaveLength(3);
    expect(provider.getLastResponse()?.text).toBe("Final answer.");
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

  // codex-acp dereferences exactly three client-supplied `_meta` paths —
  // `terminal_output` (dist/index.js:22755), `additionalRoots` (:27064) and the
  // auth/clientInfo keys — and `_meta.codex` is not among them. Model goes
  // through session/set_config_option, mode through session/set_mode, extra
  // roots through the top-level `additionalDirectories` param.
  it("sends no session meta to codex at all", () => {
    const adapter = new CodexAdapter();
    expect(adapter.buildSessionMeta({ model: "gpt-5.5" })).toBeUndefined();
    expect(adapter.buildSessionMeta({ additionalDirectories: ["/w"] })).toBeUndefined();
    expect(adapter.buildSessionMeta({})).toBeUndefined();
  });

  it("warns instead of silently dropping codex-incompatible session options", () => {
    const adapter = new CodexAdapter();
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      adapter.buildSessionMeta({ allowedTools: ["Bash"], systemPrompt: "be nice" });
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => w.includes("allowedTools"))).toBe(true);
    expect(warnings.some((w) => w.includes("systemPrompt"))).toBe(true);
  });

  it("ignores speculative _meta tool names codex-acp never emits", () => {
    const adapter = new CodexAdapter();
    // `_meta.codex` on a tool call only ever carries permission params
    // (dist/index.js:24369) — never a tool name. kind/rawInput are the contract.
    expect(adapter.resolveToolName({
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "Reading file",
      kind: "read",
      _meta: { codex: { name: "shell" } } as never,
    })).toBe("Read");
  });

  it("maps our mode names to codex ids through the adapter hook", () => {
    const adapter = new CodexAdapter();
    expect(adapter.mapPermissionMode("bypassPermissions")).toEqual(["agent-full-access"]);
    expect(adapter.mapPermissionMode("plan")).toEqual(["read-only"]);
    expect(adapter.mapPermissionMode("nonsense")).toEqual([]);
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

describe("Claude ACP adapter session meta", () => {
  // The bridge spreads `_meta.claudeCode.options` at dist/acp-agent.js:4433 and
  // then sets an explicit `permissionMode` key at :4454 from its own settings,
  // so our value was always overwritten. `additionalDirectories` moved to the
  // official top-level session/new param the bridge prefers (:4549).
  it("drops the permission mode and additionalDirectories the bridge overwrites/duplicates", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.buildSessionMeta({
      model: "claude-sonnet-4-6",
      allowedTools: ["Bash"],
      permissionMode: "bypassPermissions",
      additionalDirectories: ["/extra"],
    })).toEqual({ claudeCode: { options: { model: "claude-sonnet-4-6", allowedTools: ["Bash"] } } });
    expect(adapter.buildSessionMeta({ permissionMode: "plan" })).toBeUndefined();
  });

  // dist/acp-agent.js:4357-4374: a string REPLACES the claude_code preset, an
  // object is merged as `{...value, type:"preset", preset:"claude_code"}`.
  it("appends the system prompt instead of replacing the claude_code preset", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.buildSessionMeta({ systemPrompt: "You are Remi." })).toEqual({
      systemPrompt: { append: "You are Remi." },
    });
    expect(adapter.buildSessionMeta({ systemPrompt: "   " })).toBeUndefined();
  });

  // ALLOW_BYPASS = !IS_ROOT || IS_SANDBOX (dist/acp-agent.js:287): running as
  // root without IS_SANDBOX the bridge never advertises bypassPermissions, and
  // without a fallback set_mode was skipped and the session silently ran in
  // whatever mode the bridge chose.
  it("falls back to the closest advertised mode when bypassPermissions is unavailable", () => {
    const claude: AgentAdapter = new ClaudeAdapter();
    const rootModes = {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Manual" },
        { id: "acceptEdits", name: "Accept Edits" },
        { id: "plan", name: "Plan Mode" },
        { id: "dontAsk", name: "Don't Ask" },
      ],
    };
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", rootModes, claude)).toBe("acceptEdits");
    // `auto` only exists on models reporting supportsAutoMode (:4911-4917).
    expect(resolveAvailableAcpPermissionMode("auto", rootModes, claude)).toBe("default");
    // When the bridge does advertise it, no translation happens.
    expect(resolveAvailableAcpPermissionMode("bypassPermissions", {
      currentModeId: "default",
      availableModes: [...rootModes.availableModes, { id: "bypassPermissions", name: "Bypass" }],
    }, claude)).toBe("bypassPermissions");
  });
});

// `category` is what makes one code path work for both bridges: claude uses ids
// `model`/`effort` (dist/acp-agent.js:5110, 5142) and codex `model`/
// `reasoning_effort` (dist/index.js:27151-27152), but both tag them `model`
// (acp-agent.js:5113 / index.js:27177) and `thought_level` (:5145 / :27188).
describe("resolveConfigOptionChange", () => {
  const claudeOptions: SessionConfigOption[] = [
    {
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: "claude-sonnet-4-6",
      options: [{ value: "claude-sonnet-4-6", name: "Sonnet" }, { value: "claude-opus-4-6", name: "Opus" }],
    },
    {
      id: "effort", name: "Effort", category: "thought_level", type: "select",
      currentValue: "default",
      options: [{ value: "default", name: "Default" }, { value: "high", name: "High" }],
    },
  ];
  const codexOptions: SessionConfigOption[] = [
    {
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: "gpt-5.4",
      options: [{ value: "gpt-5.4", name: "GPT-5.4" }, { value: "gpt-5.5", name: "GPT-5.5" }],
    },
    {
      id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
      currentValue: "medium",
      options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "xhigh", name: "Extra high" }],
    },
  ];

  it("resolves each agent's own config id from the advertised category", () => {
    expect(resolveConfigOptionChange(claudeOptions, "model", "claude-opus-4-6")).toEqual({
      configId: "model", value: "claude-opus-4-6",
    });
    expect(resolveConfigOptionChange(claudeOptions, "thought_level", "high")).toEqual({
      configId: "effort", value: "high",
    });
    expect(resolveConfigOptionChange(codexOptions, "thought_level", "xhigh")).toEqual({
      configId: "reasoning_effort", value: "xhigh",
    });
  });

  it("skips values the agent does not offer instead of letting it reject the call", () => {
    // Both bridges throw on an unknown option id or value (acp-agent.js:3476,
    // 3525; codex index.js:29328, 29370, 29379) — a skipped call keeps the session.
    expect(resolveConfigOptionChange(codexOptions, "model", "claude-opus-4-6")).toBeNull();
    expect(resolveConfigOptionChange(codexOptions, "thought_level", "ludicrous")).toBeNull();
    expect(resolveConfigOptionChange(undefined, "model", "gpt-5.5")).toBeNull();
    expect(resolveConfigOptionChange([], "thought_level", "high")).toBeNull();
  });

  it("does not re-send a value the agent already reports as current", () => {
    expect(resolveConfigOptionChange(codexOptions, "model", "gpt-5.4")).toBeNull();
    expect(resolveConfigOptionChange(claudeOptions, "thought_level", "default")).toBeNull();
  });

  it("looks inside grouped select options", () => {
    const grouped: SessionConfigOption[] = [{
      id: "model", name: "Model", category: "model", type: "select",
      currentValue: "a",
      options: [{ group: "fast", name: "Fast", options: [{ value: "b", name: "B" }] }],
    }];
    expect(resolveConfigOptionChange(grouped, "model", "b")).toEqual({ configId: "model", value: "b" });
    expect(resolveConfigOptionChange(grouped, "model", "c")).toBeNull();
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
