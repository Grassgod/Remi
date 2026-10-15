import { afterAll, describe, it, expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  AcpProvider,
  AcpSessionFailureError,
  UnsupportedAcpEffortError,
  UnsupportedAcpModelError,
  elicitationToQuestions,
  type ElicitationCreateParams,
  type GatewayShimChannel,
  type GatewayShimEvent,
  type GatewayShimHost,
  type ProviderEvent,
  type UsageUpdate,
  resolveAcpExecutableForAgent,
  resolveAcpHealthCheckCommand,
  resolveAcpPermissionMode,
  resolveAvailableAcpPermissionMode,
  ClaudeAdapter,
} from "@acp/index.js";
import { CodexAdapter } from "@acp/index.js";
import { ANTIGRAVITY_FOREGROUND_NOTE } from "@acp/adapters/antigravity.js";
import { resolveConfigOptionChange } from "@acp/provider.js";
import { readExecutionModel } from "@shared/agent-execution.js";
import type { AgentAdapter, SessionConfigOption } from "@shared/contracts/acp-protocol.js";
import { isAbsolute, join } from "node:path";

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
  it("publishes the acknowledged model before text, on initial and resumed turns", async () => {
    const provider = new AcpProvider({ agentType: "claude", model: "requested-but-not-selected" });
    const configOptions: SessionConfigOption[] = [{
      id: "model", name: "Model", category: "model", type: "select", currentValue: "claude-opus-5",
      options: [{ value: "claude-opus-5", name: "Claude Opus 5" }],
    }];
    const client = {
      _options: { onSessionUpdate: (_notification: unknown) => {} },
      prompt: async () => {
        client._options.onSessionUpdate({ sessionId: "session-1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } } });
        client._options.onSessionUpdate({ sessionId: "session-1",
          update: { sessionUpdate: "usage_update", used: 82000, size: 200000 } });
        return { stopReason: "end_turn", usage: { inputTokens: 880000, outputTokens: 3000 } };
      },
      cancel: async () => {},
    };
    const entry = { client, configOptions, acpSessionId: "session-1", lastUsed: Date.now() };
    (provider as any)._ensureSession = async () => entry;
    for (let turn = 0; turn < 2; turn++) {
      const events = [];
      for await (const event of provider.sendStream("hello", { chatId: "chat1" })) events.push(event);
      expect(events[0]?.sessionUpdate).toBe("config_option_update");
      expect(readExecutionModel(events[0] as unknown as Record<string, unknown>))
        .toEqual({ model: "claude-opus-5", modelName: "Claude Opus 5" });
      expect(JSON.stringify(events[0])).not.toContain("requested-but-not-selected");
      expect(provider.getLastResponse()?.metadata?.contextUsage).toEqual({ used: 82000, size: 200000 });
      expect(provider.getLastResponse()?.inputTokens).toBe(880000);
    }
  });

  it("publishes a model-only session catalog when config options are absent", async () => {
    const provider = new AcpProvider({ agentType: "codex" });
    const client = { _options: { onSessionUpdate: () => {} }, prompt: async () => ({ stopReason: "end_turn" }) };
    (provider as any)._ensureSession = async () => ({ client, acpSessionId: "s", models: { currentModelId: "gpt-5.5[xhigh]" } });
    const events = [];
    for await (const event of provider.sendStream("hello")) events.push(event);
    expect(events[0]).toEqual({ sessionUpdate: "config_option_update", id: "model", value: "gpt-5.5[xhigh]" });
  });

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
      expect(resolved.endsWith(join("bin", "remi-claude-agent-acp"))).toBe(true);
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
    expect(claudeHealth.command.endsWith(join("bin", "remi-claude-agent-acp"))).toBe(true);
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

  it("keeps compaction out of the final response text: it arrives as compaction_update, not message text", async () => {
    // Remi advertises `session.compaction`, so claude-agent-acp 0.89 reports the
    // compaction lifecycle as its own updates (dist/context-compaction.js:3-6).
    const provider = new AcpProvider({ agentType: "claude" });
    const client = {
      _options: { onSessionUpdate: (_notification: unknown) => {} },
      prompt: async () => {
        const updates = [
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Final answer." } },
          { sessionUpdate: "compaction_update", compactionId: "cmp_1", status: "in_progress" },
          { sessionUpdate: "compaction_update", compactionId: "cmp_1", status: "completed" },
        ];
        for (const update of updates) client._options.onSessionUpdate({ sessionId: "session-1", update });
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

// ── Antigravity (PR 4 §2.2): access-config-gated provider behaviour ─────────

interface FakeShimChannel extends GatewayShimChannel {
  readonly label: string;
  closed: boolean;
  /** Prompts the provider opened the model-call gate for. */
  activePrompts: number;
  /** Observations to deliver when the provider cuts the calls still in flight. */
  pendingOnAbort: GatewayShimEvent[];
  abortCalls: number;
  emit(event: GatewayShimEvent): void;
  /** Observations to deliver when the provider waits for the prompt's requests to settle. */
  pendingOnSettle: GatewayShimEvent[];
  settledCalls: number;
}

function fakeShim() {
  const channels: FakeShimChannel[] = [];
  const host: GatewayShimHost = {
    open(label) {
      const listeners = new Set<(event: GatewayShimEvent) => void>();
      const channel: FakeShimChannel = {
        label, closed: false, pendingOnSettle: [], settledCalls: 0, activePrompts: 0, pendingOnAbort: [], abortCalls: 0,
        beginPrompt() {
          channel.activePrompts++;
          let ended = false;
          return () => { if (!ended) { ended = true; channel.activePrompts--; } };
        },
        abortInflight() {
          channel.abortCalls++;
          for (const event of channel.pendingOnAbort.splice(0)) channel.emit(event);
        },
        baseUrl: `http://127.0.0.1:9/r_test${channels.length + 1}`,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        emit(event) { for (const listener of listeners) listener(event); },
        async settled() {
          channel.settledCalls++;
          for (const event of channel.pendingOnSettle.splice(0)) channel.emit(event);
        },
        close() { channel.closed = true; listeners.clear(); },
      };
      channels.push(channel);
      return channel;
    },
  };
  return { host, channels };
}

const AGY_MODELS = [
  { value: "gemini-2.5-flash", name: "gemini-2.5-flash" },
  { value: "gemini-2.5-pro", name: "gemini-2.5-pro" },
];

/**
 * A stdio ACP agent shaped like antigravity-acp 1.4.0: gateway configOptions
 * with no thought_level, default/auto_edit/yolo modes, native `usage_update`
 * whose `used` double-counts the cache, `interaction_` questions and the
 * workspace-trust prompt as permission requests, service text as a chunk.
 */
const agentDirs: string[] = [];
afterAll(() => { for (const dir of agentDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fakeAntigravityAgent() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agy-provider-")));
  agentDirs.push(dir);
  const log = join(dir, "log.jsonl");
  const script = join(dir, "agent.mjs");
  writeFileSync(script, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const LOG = ${JSON.stringify(log)};
const MODELS = ${JSON.stringify(AGY_MODELS)};
const record = (entry) => appendFileSync(LOG, JSON.stringify(entry) + "\\n");
record({ kind: "env", GEMINI_HOME: process.env.GEMINI_HOME ?? null, AGY_LLM_GATEWAY_URL: process.env.AGY_LLM_GATEWAY_URL ?? null,
  AGY_LLM_GATEWAY_API_KEY: process.env.AGY_LLM_GATEWAY_API_KEY ?? null, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
  AGY_ACP_ENABLE_GATEWAY_AUTH: process.env.AGY_ACP_ENABLE_GATEWAY_AUTH ?? null, AGY_ACP_DEFAULT_MODEL: process.env.AGY_ACP_DEFAULT_MODEL ?? null });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
let current = MODELS[0].value;
let nextId = 1000;
const waiting = new Map();
let pendingPrompt = null;
const configOptions = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: current, options: MODELS }];
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const ask = (params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method: "session/request_permission", params }); });
async function prompt(id, params) {
  const sid = params.sessionId;
  const text = params.prompt.map((block) => block.text ?? "").join("");
  if (text === "usage") {
    update(sid, { sessionUpdate: "usage_update", used: 241282, size: 1048576 });
    chunk(sid, "Done.");
  } else if (text === "question") {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "interaction_ab12cd34", title: "Which colour?", rawInput: {}, status: "pending" });
    const answer = await ask({ sessionId: sid, toolCall: { toolCallId: "interaction_ab12cd34", title: "Which colour?", rawInput: {}, status: "pending" },
      options: [{ optionId: "opt_red", name: "Red", kind: "allow_once" }, { optionId: "opt_blue", name: "Blue", kind: "allow_once" }] });
    chunk(sid, "chose:" + (answer.outcome.optionId ?? answer.outcome.outcome));
  } else if (text === "trust") {
    const answer = await ask({ sessionId: sid, toolCall: { toolCallId: "interaction_ef567890", title: "Do you trust the authors of this workspace to execute automated agent hooks?", rawInput: {}, status: "pending" },
      options: [{ optionId: "trust", name: "Trust Workspace", kind: "allow_once" }, { optionId: "deny", name: "Don't Trust", kind: "reject_once" }] });
    chunk(sid, "trust:" + (answer.outcome.optionId ?? answer.outcome.outcome));
  } else if (text === "approval") {
    const answer = await ask({ sessionId: sid, toolCall: { toolCallId: "t-ls", title: "ls -la", kind: "execute", rawInput: { CommandLine: "ls -la" }, status: "pending" },
      options: [{ optionId: "allow_always", name: "Allow Always", kind: "allow_always" }, { optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] });
    chunk(sid, "approval:" + (answer.outcome.optionId ?? answer.outcome.outcome));
  } else if (text === "service") {
    chunk(sid, "Agent execution error: 401 Unauthorized: invalid API key");
  } else if (text === "replaced") {
    current = MODELS[0].value;
    update(sid, { sessionUpdate: "config_option_update", configOptions: configOptions() });
    chunk(sid, "gemini-2.5-pro is no longer available. Using gemini-2.5-flash.\\n\\n");
    chunk(sid, "Hello");
  } else if (text === "hang") {
    pendingPrompt = id;
    return;
  } else if (text === "background") {
    // The model backgrounds a command and moves on; the turn then waits on it forever.
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t-bg", title: "sleep 600", kind: "execute", status: "pending",
      rawInput: { CommandLine: "sleep 600", WaitMsBeforeAsync: 0 } });
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-bg", status: "in_progress" });
    chunk(sid, "Started it in the background.");
    pendingPrompt = id;
    return;
  } else if (text === "idle") {
    // A resumed turn that answers, then never ends.
    chunk(sid, "OK");
    pendingPrompt = id;
    return;
  } else if (text === "foreground") {
    update(sid, { sessionUpdate: "tool_call", toolCallId: "t-fg", title: "make build", kind: "execute", status: "pending", rawInput: { CommandLine: "make build" } });
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-fg", status: "in_progress" });
    await new Promise((resolve) => setTimeout(resolve, 900));
    update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t-fg", status: "completed", rawOutput: { exitCode: 0 } });
    chunk(sid, "built");
  } else if (text === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 900));
    chunk(sid, "thought");
  } else if (text === "cancel-words") {
    chunk(sid, "The request was cancelled by the client.");
  }
  send({ id, result: { stopReason: "end_turn" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id != null && !message.method) { waiting.get(message.id)?.(message.result); waiting.delete(message.id); return; }
  record({ kind: "request", method: message.method, params: message.params });
  const ok = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize": return ok({ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.4.0" },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} }, _meta: { antigravity: { systemPrompt: { append: true } } } } });
    case "session/new":
    case "session/resume":
      return ok({ sessionId: message.params.sessionId ?? "agy-session-1", configOptions: configOptions(),
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "auto_edit", name: "Auto Edit" }, { id: "yolo", name: "YOLO" }] } });
    case "session/set_mode": return ok({});
    case "session/set_config_option": current = message.params.value; return ok({ configOptions: configOptions() });
    case "session/prompt": return void prompt(message.id, message.params);
    case "session/cancel":
      if (pendingPrompt !== null) {
        // Server 1.4.0 acknowledges a cancel with this text before the cancelled reply.
        chunk(message.params.sessionId, "The request was cancelled by the client.");
        send({ id: pendingPrompt, result: { stopReason: "cancelled" } });
        pendingPrompt = null;
      }
      return;
    default: return send({ id: message.id, error: { code: -32601, message: "Method not found: " + message.method } });
  }
});
`);
  const entries = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  return {
    dir,
    script,
    requests: (method: string) => entries().filter((entry) => entry.kind === "request" && entry.method === method),
    env: () => entries().find((entry) => entry.kind === "env"),
  };
}

function antigravityProvider(agent: ReturnType<typeof fakeAntigravityAgent>, overrides: Partial<NonNullable<ConstructorParameters<typeof AcpProvider>[0]>> = {}) {
  const shim = fakeShim();
  const home = join(agent.dir, "home");
  mkdirSync(home, { recursive: true });
  const provider = new AcpProvider({
    agentType: "antigravity", executable: process.execPath, args: [agent.script], cwd: agent.dir, providerHome: home,
    gatewayShim: shim.host, model: "gemini-2.5-pro", env: { GEMINI_API_KEY: "AIza-inherited-personal-key" }, ...overrides,
  });
  return { provider, shim, home };
}

async function collect(stream: AsyncGenerator<ProviderEvent>, onFirst?: () => void): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) {
    if (!events.length) onFirst?.();
    events.push(event);
  }
  return events;
}

const PROBE_USAGE = { promptTokenCount: 138_617, cachedContentTokenCount: 101_304, candidatesTokenCount: 1_361, totalTokenCount: 139_978 };
function request(seq: number, overrides: Partial<Extract<GatewayShimEvent, { type: "request" }>["obs"]> = {}): GatewayShimEvent {
  return { type: "request", obs: { seq, requestedModel: "gemini-2.5-pro", status: 200, aborted: false, responseId: `resp-${seq}`,
    modelVersion: "gemini-2.5-pro-002", usageMetadata: PROBE_USAGE, ...overrides } };
}

describe("AcpProvider with the Antigravity access config", () => {
  it("spawns with the access env, the shim URL and the system prompt, and closes the shim channel with the process", async () => {
    const agent = fakeAntigravityAgent();
    const { provider, shim, home } = antigravityProvider(agent);
    try {
      await collect(provider.sendStream("usage", { chatId: "c1", systemPrompt: "You are Remi." }));
      expect(agent.env()).toEqual({
        kind: "env", GEMINI_HOME: home, AGY_LLM_GATEWAY_URL: shim.channels[0]!.baseUrl, AGY_LLM_GATEWAY_API_KEY: "remi-shim",
        GEMINI_API_KEY: "", AGY_ACP_ENABLE_GATEWAY_AUTH: "1", AGY_ACP_DEFAULT_MODEL: "gemini-2.5-pro",
      });
      const [created] = agent.requests("session/new");
      // The session cwd comes first, so shell commands run there (R5).
      expect(created.params._meta).toEqual({ antigravity: { systemPrompt: { append: `The working directory of this session is ${agent.dir}. `
        + `Run every shell command in that directory (set it as the command's working directory) unless the task names another directory.\n${ANTIGRAVITY_FOREGROUND_NOTE}\n\nYou are Remi.` } } });
      expect(agent.requests("session/set_mode").map((r) => r.params.modeId)).toEqual(["yolo"]);
      expect(agent.requests("session/set_config_option").map((r) => r.params)).toEqual([
        { sessionId: "agy-session-1", configId: "model", value: "gemini-2.5-pro" }]);
      expect(shim.channels).toHaveLength(1);
      expect(shim.channels[0]!.closed).toBe(false);
    } finally {
      await provider.close();
    }
    expect(shim.channels[0]!.closed).toBe(true);
  });

  it("bills shim observations, never the native usage_update, and settles before the response", async () => {
    const agent = fakeAntigravityAgent();
    const { provider, shim } = antigravityProvider(agent);
    try {
      const events = await collect(provider.sendStream("usage", { chatId: "c1" }), () => {
        const channel = shim.channels[0]!;
        channel.emit(request(1));
        // The last request's usage only arrives once the provider waits for it.
        channel.pendingOnSettle.push(request(2, { requestedModel: "gemini-2.5-flash-lite",
          usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, thoughtsTokenCount: 30, totalTokenCount: 550 } }));
      });
      const usage = events.filter((event) => event.sessionUpdate === "usage_update") as UsageUpdate[];
      expect(usage.some((event) => event.used === 241282)).toBe(false);
      expect(usage.map((event) => [event.used, event.size])).toEqual([[139_978, 1_048_576], [0, 0]]);
      expect(usage.flatMap((event) => (event._meta?.remiUsageUnits as Array<{ providerRequestId?: string }>).map((unit) => unit.providerRequestId)))
        .toContain("resp-1");
      expect(shim.channels[0]!.settledCalls).toBe(1);
      const response = provider.getLastResponse()!;
      const units = (response.metadata?.usageUnits as Array<Record<string, unknown>>).filter((unit) => unit.source !== "context_snapshot");
      expect(units.map((unit) => [unit.providerRequestId, unit.identityKind, unit.inputTokens, unit.cacheReadTokens, unit.outputTokens])).toEqual([
        ["resp-1", "request", 37_313, 101_304, 1_361],
        ["resp-2", "request", 500, 0, 50],
      ]);
      // Context is the session model's last request (cached included), never a browser/subagent call.
      expect(response.metadata?.contextUsage).toEqual({ used: 139_978, size: 1_048_576 });
      expect(response.totalTokens).toBe(139_978 + 550);
    } finally {
      await provider.close();
    }
  });

  it("asks the model's single-choice question through the elicitation handler, not the approval path", async () => {
    const agent = fakeAntigravityAgent();
    const { provider } = antigravityProvider(agent);
    const elicitations: ElicitationCreateParams[] = [];
    provider.setPermissionHandler(async () => { throw new Error("a question is not a tool approval"); }, "c1");
    provider.setElicitationHandler(async (params) => {
      elicitations.push(params);
      return { action: "accept", content: { answer: "Blue" } };
    }, "c1");
    try {
      await collect(provider.sendStream("question", { chatId: "c1" }));
      expect(provider.getLastResponse()?.text).toBe("chose:opt_blue");
      expect(elicitations).toEqual([{
        mode: "form", sessionId: "agy-session-1", toolCallId: "interaction_ab12cd34", message: "Which colour?",
        requestedSchema: { type: "object", required: ["answer"], properties: { answer: { type: "string",
          oneOf: [{ const: "Red", title: "Red" }, { const: "Blue", title: "Blue" }] } } },
      }]);
      expect(elicitationToQuestions(elicitations[0]!)?.[0]?.question).toEqual({
        question: "Which colour?", header: undefined, options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false });

      provider.setElicitationHandler(async () => ({ action: "decline" }), "c1");
      await collect(provider.sendStream("question", { chatId: "c1" }));
      expect(provider.getLastResponse()?.text).toBe("chose:cancelled");
    } finally {
      await provider.close();
    }
  });

  it("denies the workspace-trust prompt itself and leaves tool approvals to the handler", async () => {
    const agent = fakeAntigravityAgent();
    const { provider } = antigravityProvider(agent);
    const approvals: string[] = [];
    provider.setPermissionHandler(async (params) => {
      approvals.push(params.toolCall.toolCallId);
      return { outcome: "selected", optionId: "allow" };
    }, "c1");
    try {
      await collect(provider.sendStream("trust", { chatId: "c1" }));
      expect(provider.getLastResponse()?.text).toBe("trust:deny");
      await collect(provider.sendStream("approval", { chatId: "c1" }));
      expect(provider.getLastResponse()?.text).toBe("approval:allow");
      expect(approvals).toEqual(["t-ls"]);
    } finally {
      await provider.close();
    }
  });

  it("turns a service-message chunk into a typed failure, categorized by the shim's last status", async () => {
    const agent = fakeAntigravityAgent();
    const { provider, shim } = antigravityProvider(agent);
    try {
      const events: ProviderEvent[] = [];
      const error = await (async () => {
        for await (const event of provider.sendStream("service", { chatId: "c1" })) {
          if (!events.length) shim.channels[0]!.emit(request(1, { status: 401, usageMetadata: null, responseId: null }));
          events.push(event);
        }
      })().catch((e) => e);
      expect(error).toBeInstanceOf(AcpSessionFailureError);
      expect((error as AcpSessionFailureError).failure).toMatchObject({ category: "authentication", errorKind: "authentication_failed",
        severity: "error", details: "401 Unauthorized: invalid API key" });
      // Failures are typed, so the daemon's legacy last-message heuristics stay off.
      expect(provider.typedSessionFailures).toBe(true);
      expect(events.some((event) => event.sessionUpdate === "agent_message_chunk")).toBe(false);
      expect(events.some((event) => event.sessionUpdate === "session_info_update")).toBe(true);
      expect(provider.getLastResponse()?.text).toBe("");
      // A rejected request without counters is not billed.
      expect((provider.getLastResponse()?.metadata?.usageUnits as unknown[]).length).toBe(0);
    } finally {
      await provider.close();
    }
  });

  it("reports a replaced model as a warning notice and keeps the reply text", async () => {
    const agent = fakeAntigravityAgent();
    const { provider } = antigravityProvider(agent);
    try {
      const events = await collect(provider.sendStream("replaced", { chatId: "c1" }));
      expect(events.find((event) => event.sessionUpdate === "notice")).toEqual({ sessionUpdate: "notice", severity: "warning",
        title: "Model replaced", description: "gemini-2.5-pro is no longer available; the agent switched to gemini-2.5-flash." });
      expect(provider.getLastResponse()?.text).toBe("Hello");
    } finally {
      await provider.close();
    }
  });

  it("cancels the prompt and fails the turn when the shim breaker opens, then replaces the process", async () => {
    const agent = fakeAntigravityAgent();
    const { provider, shim } = antigravityProvider(agent);
    try {
      const error = await collect(provider.sendStream("hang", { chatId: "c1" }), () => {
        shim.channels[0]!.emit({ type: "fatal", reason: "auth", status: 401, message: "gateway rejected the key" });
      }).catch((e) => e);
      expect(error).toBeInstanceOf(AcpSessionFailureError);
      expect((error as AcpSessionFailureError).failure).toMatchObject({ category: "authentication", title: "The model gateway rejected the credentials" });
      expect(agent.requests("session/cancel")).toHaveLength(1);
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await collect(provider.sendStream("usage", { chatId: "c1" }));
      } finally {
        warn.mockRestore();
      }
      // The fatal channel's process is discarded; the next turn gets a new token.
      expect(shim.channels.map((channel) => channel.closed)).toEqual([true, false]);
    } finally {
      await provider.close();
    }
  });

  it("fails at session setup when the breaker opened while session/new listed models", async () => {
    const agent = fakeAntigravityAgent();
    const inner = fakeShim();
    // The fatal event arrives as soon as the provider subscribes, before any prompt listener exists.
    const host: GatewayShimHost = { open(label) {
      const channel = inner.host.open(label) as FakeShimChannel;
      const subscribe = channel.subscribe;
      channel.subscribe = (listener) => {
        const off = subscribe(listener);
        listener({ type: "fatal", reason: "auth", status: 401, message: "gateway rejected the key" });
        return off;
      };
      return channel;
    } };
    const { provider } = antigravityProvider(agent, { gatewayShim: host });
    try {
      const error = await collect(provider.sendStream("hang", { chatId: "c1" })).catch((e) => e);
      expect(error).toBeInstanceOf(AcpSessionFailureError);
      expect((error as AcpSessionFailureError).failure).toMatchObject({ category: "authentication", errorKind: "authentication_failed" });
      // Nothing went to the dead token: no prompt, and the process and its channel are gone.
      expect(agent.requests("session/prompt")).toHaveLength(0);
      expect(inner.channels.map((channel) => channel.closed)).toEqual([true]);
    } finally {
      await provider.close();
    }
  });

  it("reports a failed model listing instead of the unsupported model the server's fallback list implies", async () => {
    const agent = fakeAntigravityAgent();
    const inner = fakeShim();
    const host: GatewayShimHost = { open(label) {
      const channel = inner.host.open(label) as FakeShimChannel;
      const subscribe = channel.subscribe;
      channel.subscribe = (listener) => {
        const off = subscribe(listener);
        listener({ type: "listing", status: 503, failure: { reason: "unreachable", status: 503, message: "the model gateway failed (HTTP 503)" } });
        return off;
      };
      return channel;
    } };
    const { provider } = antigravityProvider(agent, { gatewayShim: host, model: "gemini-9-not-listed" });
    try {
      const error = await collect(provider.sendStream("usage", { chatId: "c1" })).catch((e) => e);
      expect(error).toBeInstanceOf(AcpSessionFailureError);
      expect((error as AcpSessionFailureError).failure).toMatchObject({ category: "connection", errorKind: "server_error",
        title: "The model gateway is unreachable", details: "the model gateway failed (HTTP 503)" });
      // Discovery refuses the fallback list the same way.
      await expect(provider.discoverModelCapabilities()).rejects.toThrow("The model gateway is unreachable");
    } finally {
      await provider.close();
    }
  });

  it("opens the shim's model-call gate only for a prompt and bills calls still open at its end as cut short", async () => {
    const agent = fakeAntigravityAgent();
    const { provider, shim } = antigravityProvider(agent);
    try {
      let activeDuring = -1;
      await collect(provider.sendStream("usage", { chatId: "c1" }), () => {
        const channel = shim.channels[0]!;
        activeDuring = channel.activePrompts;
        // A call that is still open when the agent ends the turn.
        channel.emit({ type: "request_started", requestedModel: "gemini-2.5-pro" });
        channel.pendingOnAbort.push(request(7, { aborted: true, responseId: "resp-open", usageMetadata: { promptTokenCount: 50, totalTokenCount: 50 } }));
      });
      expect(activeDuring).toBe(1);
      expect(shim.channels[0]!.activePrompts).toBe(0);
      expect(shim.channels[0]!.abortCalls).toBe(1);
      const units = (provider.getLastResponse()?.metadata?.usageUnits ?? []) as Array<Record<string, unknown>>;
      expect(units.filter((unit) => unit.scope === "request")).toMatchObject([{ providerRequestId: "resp-open", accuracy: "partial", inputTokens: 50 }]);
    } finally {
      await provider.close();
    }
  });

  it("drops the server's cancel acknowledgement only after Remi's own cancel", async () => {
    const agent = fakeAntigravityAgent();
    const { provider } = antigravityProvider(agent);
    try {
      const abort = new AbortController();
      const cancelled: ProviderEvent[] = [];
      await expect((async () => {
        for await (const event of provider.sendStream("hang", { chatId: "c1", signal: abort.signal })) {
          cancelled.push(event);
          if (cancelled.length === 1) setTimeout(() => abort.abort(), 20);
        }
      })()).rejects.toThrow("Cancelled");
      expect(agent.requests("session/cancel")).toHaveLength(1);
      expect(JSON.stringify(cancelled)).not.toContain("The request was cancelled by the client.");
      // The same words outside a cancel are the model's and stay.
      await collect(provider.sendStream("cancel-words", { chatId: "c1" }));
      expect(provider.getLastResponse()?.text).toBe("The request was cancelled by the client.");
    } finally {
      await provider.close();
    }
  });

  it("answers a steer with unsupported and sends nothing, so the daemon cancels and re-prompts", async () => {
    const agent = fakeAntigravityAgent();
    const { provider } = antigravityProvider(agent);
    try {
      const abort = new AbortController();
      let steer: unknown = null;
      await expect((async () => {
        for await (const event of provider.sendStream("hang", { chatId: "c1", signal: abort.signal })) {
          if (event.sessionUpdate === "config_option_update" && steer === null) {
            steer = "pending";
            steer = await provider.steer("Use English", { chatId: "c1" });
            abort.abort();
          }
        }
      })()).rejects.toThrow("Cancelled");
      expect(steer).toEqual({ outcome: "unsupported" });
      expect(agent.requests("session/cancel")).toHaveLength(1);
      expect(agent.requests("_session/steering")).toHaveLength(0);
    } finally {
      await provider.close();
    }
  });

  describe("stall watchdog", () => {
    const STALL_MS = 200;

    it("fails a turn left open by a background command as a timeout and cancels it", async () => {
      const agent = fakeAntigravityAgent();
      const { provider, shim } = antigravityProvider(agent, { turnStallTimeoutMs: STALL_MS });
      try {
        const started = performance.now();
        // The model spoke after the tool went async: it moved on, so the open tool no longer explains the silence.
        const error = await collect(provider.sendStream("background", { chatId: "c1" }), () => {
          shim.channels[0]!.emit({ type: "request_started", requestedModel: "gemini-2.5-pro" });
          shim.channels[0]!.emit(request(1));
        }).catch((e) => e);
        expect(error).toBeInstanceOf(AcpSessionFailureError);
        expect((error as AcpSessionFailureError).failure).toMatchObject({ category: "timeout", errorKind: "turn_stalled",
          title: "The antigravity turn timed out after 200 ms without progress" });
        expect((error as AcpSessionFailureError).hint).toMatchObject({ category: "timeout", errorKind: "turn_stalled" });
        expect(agent.requests("session/cancel")).toHaveLength(1);
        expect(performance.now() - started).toBeLessThan(5_000);
      } finally {
        await provider.close();
      }
    });

    it("fails a turn that answered but never ended", async () => {
      const agent = fakeAntigravityAgent();
      const { provider } = antigravityProvider(agent, { turnStallTimeoutMs: STALL_MS });
      try {
        const error = await collect(provider.sendStream("idle", { chatId: "c1" })).catch((e) => e);
        expect((error as AcpSessionFailureError).failure).toMatchObject({ errorKind: "turn_stalled" });
        expect(agent.requests("session/cancel")).toHaveLength(1);
      } finally {
        await provider.close();
      }
    });

    it("never trips on a long foreground command, a model call in flight or a pending permission answer", async () => {
      const agent = fakeAntigravityAgent();
      const { provider, shim } = antigravityProvider(agent, { turnStallTimeoutMs: STALL_MS });
      try {
        // 900 ms foreground command, 4.5× the bound: the model is waiting on the tool.
        await collect(provider.sendStream("foreground", { chatId: "c1" }));
        expect(provider.getLastResponse()?.text).toBe("built");
        // A model call in flight for 900 ms.
        await collect(provider.sendStream("slow", { chatId: "c1" }), () => {
          shim.channels[0]!.emit({ type: "request_started", requestedModel: "gemini-2.5-pro" });
        });
        expect(provider.getLastResponse()?.text).toBe("thought");
        shim.channels[0]!.emit(request(1));
        // A person takes 800 ms to answer a permission prompt.
        provider.setPermissionHandler(async (params) => {
          await Bun.sleep(800);
          return { outcome: "selected", optionId: params.options.find((o) => o.kind === "allow_once")!.optionId };
        });
        await collect(provider.sendStream("approval", { chatId: "c1" }));
        expect(provider.getLastResponse()?.text).toBe("approval:allow");
        expect(agent.requests("session/cancel")).toHaveLength(0);
      } finally {
        await provider.close();
      }
    });
  });

  it("selects models strictly, rejects effort, and requires a model", async () => {
    const agent = fakeAntigravityAgent();
    const { provider } = antigravityProvider(agent, { model: null });
    try {
      await expect(collect(provider.sendStream("usage", { chatId: "c1" }))).rejects.toThrow("[antigravity_model_required]");
      await expect(collect(provider.sendStream("usage", { chatId: "c1", model: "gemini-1.0-retired" }))).rejects.toBeInstanceOf(UnsupportedAcpModelError);
      await expect(collect(provider.sendStream("usage", { chatId: "c1", model: "gemini-2.5-pro", effort: "high" })))
        .rejects.toBeInstanceOf(UnsupportedAcpEffortError);
      await collect(provider.sendStream("usage", { chatId: "c1", model: "gemini-2.5-pro" }));
      expect(provider.getLastResponse()?.text).toBe("Done.");
    } finally {
      await provider.close();
    }
  });

  it("discovers models once, with effort unsupported and no per-model walk", async () => {
    const agent = fakeAntigravityAgent();
    const { provider } = antigravityProvider(agent, { model: null });
    try {
      expect(await provider.discoverModelCapabilities()).toEqual([
        { id: "gemini-2.5-flash", label: "gemini-2.5-flash", default: true, effort: { status: "unsupported", supportedLevels: [] } },
        { id: "gemini-2.5-pro", label: "gemini-2.5-pro", default: false, effort: { status: "unsupported", supportedLevels: [] } },
      ]);
      expect(agent.requests("session/set_config_option")).toEqual([]);
    } finally {
      await provider.close();
    }
  });

  it("refuses to start without a gateway, a session home, or with the retired agy executable", async () => {
    const agent = fakeAntigravityAgent();
    const cases: Array<[Partial<NonNullable<ConstructorParameters<typeof AcpProvider>[0]>>, string]> = [
      [{ gatewayShim: undefined }, "[antigravity_gateway_unconfigured]"],
      [{ providerHome: undefined }, "[antigravity_home_required]"],
      [{ executable: "/usr/local/bin/agy", args: [] }, "points at the retired agy CLI; clear it"],
    ];
    for (const [overrides, message] of cases) {
      const { provider } = antigravityProvider(agent, overrides);
      try {
        await expect(collect(provider.sendStream("usage", { chatId: "c1" }))).rejects.toThrow(message);
      } finally {
        await provider.close();
      }
    }
    expect(agent.requests("initialize")).toEqual([]);
    // A probe subprocess passes a plain shim URL instead of the in-process host.
    const { provider } = antigravityProvider(agent, { gatewayShim: undefined, gatewayUrl: "http://127.0.0.1:9/r_probe" });
    try {
      await collect(provider.sendStream("usage", { chatId: "c1" }));
      expect(agent.env().AGY_LLM_GATEWAY_URL).toBe("http://127.0.0.1:9/r_probe");
    } finally {
      await provider.close();
    }
  });

  it("ignores custom args without an executable override and reports a missing pinned install", async () => {
    const provider = new AcpProvider({ agentType: "antigravity", args: ["--model", "x"], providerHome: "/tmp/h", gatewayUrl: "http://127.0.0.1:9/r_x",
      model: "gemini-2.5-pro" });
    try {
      await expect(collect(provider.sendStream("usage", { chatId: "c1" }))).rejects.toThrow("[antigravity_not_installed]");
      expect(await provider.healthCheck()).toBe(false);
    } finally {
      await provider.close();
    }
  });
});
