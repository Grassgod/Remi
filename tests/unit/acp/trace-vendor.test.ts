import { describe, expect, it } from "bun:test";
import {
  classifyTool,
  codexActionFromTitle,
  commandTitle,
  compactionFacts,
  diffChanges,
  endsWithAbortMarker,
  isAsyncLaunch,
  launchMarker,
  isMcp,
  mcpServer,
  mergeToolFacts,
  messagePhase,
  parentToolUseId,
  terminalChunk,
  terminalExit,
  toolLabel,
} from "@acp/adapters/trace-vendor.js";

const facts = (...frames: Array<Record<string, unknown>>) =>
  frames.reduce<ReturnType<typeof mergeToolFacts> | null>((previous, frame) => mergeToolFacts(previous, frame), null)!;

describe("trace vendor reads", () => {
  it("reads the message phase from AIR, then Codex 1.x, then top level", () => {
    expect(messagePhase({ _meta: { jetbrains: { air: { phase: "final_answer" } } } })).toBe("final");
    expect(messagePhase({ _meta: { codex: { phase: "commentary" } } })).toBe("commentary");
    expect(messagePhase({ phase: "final_answer" })).toBe("final");
    expect(messagePhase({ _meta: { jetbrains: { air: { phase: "partial_answer" } } } })).toBe("unknown");
    expect(messagePhase({})).toBe("unknown");
  });

  it("reads parent attribution, terminal chunks and exits", () => {
    expect(parentToolUseId({ _meta: { claudeCode: { parentToolUseId: "toolu_a" } } })).toBe("toolu_a");
    expect(parentToolUseId({})).toBeNull();
    expect(terminalChunk({ _meta: { terminal_output: { data: "out" } } })).toBe("out");
    expect(terminalChunk({ _meta: { terminal_output_delta: { data: "delta" } } })).toBe("delta");
    expect(terminalExit({ _meta: { terminal_exit: { exit_code: 2 } } })).toBe(2);
    expect(terminalExit({ _meta: { terminal_exit: { exit_code: null } } })).toBeNull();
    expect(terminalExit({})).toBeUndefined();
  });

  it("parses the Codex single-action titles and nothing else", () => {
    expect(codexActionFromTitle("Read file '/r/a.ts'", ["/r/a.ts"])).toEqual({ type: "read", command: null, name: "a.ts", path: "/r/a.ts" });
    expect(codexActionFromTitle("List files")).toEqual({ type: "list_files", command: null, path: null });
    expect(codexActionFromTitle("List files in 'src'")).toEqual({ type: "list_files", command: null, path: "src" });
    expect(codexActionFromTitle("Search for 'a b' in src/x")).toEqual({ type: "search", command: null, query: "a b", path: "src/x" });
    expect(codexActionFromTitle("Search for 'needle'")).toEqual({ type: "search", command: null, query: "needle", path: null });
    expect(codexActionFromTitle("Search in 'docs'")).toEqual({ type: "search", command: null, query: null, path: "docs" });
    expect(codexActionFromTitle("bun test")).toBeNull();
    expect(codexActionFromTitle(null)).toBeNull();
  });

  it("recognises MCP calls of both bridges", () => {
    expect(isMcp({}, "mcp__github__search")).toBe(true);
    expect(isMcp({ _meta: { is_mcp_tool_call: true } }, null)).toBe(true);
    expect(isMcp({ title: "mcp.github.search_issues" }, null)).toBe(true);
    expect(isMcp({ title: "Read file" }, "Read")).toBe(false);
    expect(mcpServer({}, "mcp__github__search", null)).toBe("github");
    expect(mcpServer({ title: "mcp.linear.list" }, null, null)).toBe("linear");
    expect(mcpServer({}, null, { server: "fs" })).toBe("fs");
  });

  it("reads AIR compaction facts", () => {
    expect(compactionFacts({ _meta: { jetbrains: { air: { contextCompaction: { version: 1, trigger: "manual", preTokens: 10, postTokens: 2 } } } } }))
      .toEqual({ trigger: "manual", pre_tokens: 10, post_tokens: 2 });
    expect(compactionFacts({ _meta: { jetbrains: { air: { contextCompaction: { version: 1 } } } } })).toEqual({});
    expect(compactionFacts({})).toEqual({});
  });
});

describe("classifyTool", () => {
  it("classifies Claude tools by name", () => {
    const c = (name: string, rawInput: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      classifyTool("claude", facts({ _meta: { claudeCode: { toolName: name } }, rawInput, ...extra }));
    expect(c("Bash", { command: "ls -la" })).toMatchObject({ type: "command", source: "shell", command: "ls -la", actions: null });
    expect(classifyTool("claude", facts({ _meta: { claudeCode: { toolName: "Bash" } }, title: "git status" }))).toMatchObject({ command: "git status" });
    expect(classifyTool("claude", facts({ _meta: { claudeCode: { toolName: "Bash" } }, title: "Terminal" }))).toMatchObject({ command: null });
    // PowerShell shares the bridge's bash reporter (CA/tool-calls/reporters/index.js:13).
    expect(c("PowerShell", { command: "Get-ChildItem" })).toMatchObject({ type: "command", source: "shell", command: "Get-ChildItem", actions: null });
    expect(classifyTool("claude", facts({ _meta: { claudeCode: { toolName: "PowerShell" } }, title: "Get-Date" }))).toMatchObject({ type: "command", command: "Get-Date" });
    expect(c("Read", { file_path: "/r/x.ts" })).toMatchObject({ type: "command", source: "tool", actions: [{ type: "read", path: "/r/x.ts" }] });
    expect(c("Grep", { pattern: "foo", path: "src" })).toMatchObject({ actions: [{ type: "search", query: "foo", path: "src" }] });
    expect(c("LS", { path: "src" })).toMatchObject({ actions: [{ type: "list_files", path: "src" }] });
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(c(name).type).toBe("file_change");
    expect(c("WebSearch", { query: "q" })).toEqual({ type: "web_search", action: "search", query: "q", url: null });
    expect(c("WebFetch", { url: "https://x" })).toMatchObject({ type: "web_search", action: "fetch", url: "https://x" });
    expect(c("Agent", { prompt: "go" })).toEqual({ type: "subagent", prompt: "go", agentType: null, name: null, background: null, model: null, threadId: null });
    expect(c("Task", { description: "d" })).toEqual({ type: "subagent", prompt: "d", agentType: null, name: "d", background: null, model: null, threadId: null });
    expect(c("AskUserQuestion")).toEqual({ type: "suppress" });
    expect(c("mcp__github__search")).toEqual({ type: "tool", server: "github" });
    expect(c("ExitPlanMode")).toEqual({ type: "tool", server: null });
  });

  it("classifies Codex tools by kind, title and meta", () => {
    const c = (frame: Record<string, unknown>) => classifyTool("codex", facts(frame));
    expect(c({ kind: "execute", rawInput: { command: "ls", cwd: "/r" } })).toMatchObject({ type: "command", source: "shell", command: "ls", cwd: "/r" });
    expect(c({ kind: "execute", rawInput: { command: ["bash", "-lc", "ls"] } })).toMatchObject({ type: "command", command: "bash -lc ls" });
    expect(c({ kind: "execute", _meta: { terminal_info: { cwd: "/w", terminal_id: "t" } } })).toMatchObject({ type: "command", command: null, cwd: "/w" });
    expect(c({ kind: "execute", title: "lookup", rawInput: { arguments: {} } })).toEqual({ type: "tool", server: null });
    expect(c({ kind: "read", title: "Read file 'a.ts'", locations: [{ path: "/r/a.ts" }] }))
      .toMatchObject({ type: "command", command: null, actions: [{ type: "read", path: "/r/a.ts" }] });
    expect(c({ kind: "read", title: "List files in 'src'" })).toMatchObject({ actions: [{ type: "list_files", path: "src" }] });
    expect(c({ kind: "read", title: "View Image" })).toEqual({ type: "tool", server: null });
    expect(c({ kind: "search", title: "Web search: q", rawInput: { query: "q", action: { type: "search" } } }))
      .toEqual({ type: "web_search", action: "search", query: "q", url: null });
    expect(c({ kind: "search", title: "Open page: https://x", rawInput: { query: "", action: { type: "openPage", url: "https://x" } } }))
      .toMatchObject({ type: "web_search", action: "fetch", url: "https://x" });
    expect(c({ kind: "search", title: "Search for 'x' in src" })).toMatchObject({ type: "command", actions: [{ type: "search", query: "x", path: "src" }] });
    expect(c({ kind: "edit", title: "Editing files" }).type).toBe("file_change");
    expect(c({ kind: "execute", title: "mcp.github.search", _meta: { is_mcp_tool_call: true } })).toEqual({ type: "tool", server: "github" });
    expect(c({ title: "spawnAgent", rawInput: { prompt: "p" } })).toEqual({ type: "subagent", prompt: "p", agentType: null, name: null, background: null, model: null, threadId: null });
    expect(c({ title: "x", _meta: { jetbrains: { air: { subagent: true } } } })).toEqual({ type: "subagent", prompt: null, agentType: null, name: null, background: null, model: null, threadId: null });
    expect(c({ kind: "think", title: "Thinking" })).toEqual({ type: "tool", server: null });
  });

  // Frames as recorded from claude-agent-acp 0.89 (A, A-bg) and codex-acp 2.2.2 (A).
  it("reads the subagent facts of a Claude Agent call", () => {
    const frames = [
      { _meta: { claudeCode: { toolName: "Agent" }, jetbrains: { air: { version: 1, subagent: true } } }, name: "Agent", title: "Task", kind: "think" },
      { rawInput: { description: "Count files in directory", prompt: "List the files", subagent_type: "general-purpose", run_in_background: true } },
    ];
    // `run_in_background` is only a request: background is unknown until the hook says.
    expect(classifyTool("claude", facts(...frames))).toEqual({ type: "subagent", prompt: "List the files",
      agentType: "general-purpose", name: "Count files in directory", background: null, model: null, threadId: null });
    // The SDK backgrounds by default: the hook markers alone make it background.
    const launched = facts(frames[0]!, { rawInput: { description: "d", prompt: "p" } },
      { _meta: { claudeCode: { toolResponse: { status: "async_launched", isAsync: true } } } });
    expect(launched.asyncLaunch).toBe(true);
    expect(classifyTool("claude", launched)).toMatchObject({ background: true, agentType: null });
    // A foreground result's marker makes it foreground, whatever the input asked.
    const foreground = facts(...frames, { _meta: { claudeCode: { toolResponse: { status: "completed" } } } });
    expect(classifyTool("claude", foreground)).toMatchObject({ background: false });
    expect(launchMarker({ _meta: { claudeCode: { toolResponse: { elapsedTimeSeconds: 3 } } } })).toBeNull();
    expect(isAsyncLaunch({ _meta: { claudeCode: { toolResponse: { isAsync: true } } } })).toBe(true);
    expect(isAsyncLaunch({ _meta: { claudeCode: { toolResponse: { status: "async_launched" } } } })).toBe(true);
    expect(isAsyncLaunch({ _meta: { claudeCode: { toolResponse: { status: "completed" } } } })).toBe(false);
    // A progress beat names the type without deciding background; an explicit model is kept.
    const beat = facts(frames[0]!, { rawInput: { description: "d", prompt: "p", run_in_background: false, model: "haiku" } },
      { status: "in_progress", _meta: { claudeCode: { toolName: "Agent", toolResponse: { elapsedTimeSeconds: 3, subagentType: "Explore" } } } });
    expect(classifyTool("claude", beat)).toMatchObject({ agentType: "Explore", background: null, model: "haiku" });
    // Once an async launch is seen it stays background.
    expect(facts(frames[0]!, { _meta: { claudeCode: { toolResponse: { isAsync: true } } } },
      { _meta: { claudeCode: { toolResponse: { status: "completed" } } } }).asyncLaunch).toBe(true);
  });

  it("recognises Claude's abort marker at the end of a command's output", () => {
    expect(endsWithAbortMarker("building…\n[Command was aborted before completion]\n")).toBe(true);
    expect(endsWithAbortMarker("[Command was aborted before completion] then more")).toBe(false);
    expect(endsWithAbortMarker(null)).toBe(false);
  });

  it("reads the Codex subagent thread from activity and collab calls", () => {
    expect(classifyTool("codex", facts({ kind: "other", title: "Start subagent count_files", _meta: { jetbrains: { air: { version: 1, subagent: true } } },
      rawInput: { agentThreadId: "01a13da2-2fd7", agentPath: "/root/count_files", activityKind: "started" } })))
      .toEqual({ type: "subagent", prompt: null, agentType: null, name: "count_files", background: null, model: null, threadId: "01a13da2-2fd7" });
    expect(classifyTool("codex", facts({ kind: "other", title: "spawnAgent",
      rawInput: { prompt: "count", senderThreadId: "root", receiverThreadIds: ["child-1"], model: "gpt-6.1-sol" } })))
      .toMatchObject({ prompt: "count", threadId: "child-1", model: "gpt-6.1-sol" });
    expect(classifyTool("codex", facts({ kind: "other", title: "wait",
      rawInput: { prompt: null, senderThreadId: "root", receiverThreadIds: [], model: null } }))).toMatchObject({ threadId: null, model: null });
  });

  it("takes a Claude command's label from AIR commandTitle", () => {
    const bash = { _meta: { claudeCode: { toolName: "Bash" }, jetbrains: { air: { version: 1, commandTitle: "List all files including hidden" } } },
      name: "Bash", kind: "execute", rawInput: { command: "ls -A /w", description: "List all files including hidden" } };
    expect(commandTitle(bash)).toBe("List all files including hidden");
    expect(classifyTool("claude", facts(bash))).toMatchObject({ type: "command", command: "ls -A /w", title: "List all files including hidden" });
    // Without AIR the description still labels it; a call with neither has none.
    expect(classifyTool("claude", facts({ _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "ls", command_description: "List" } })))
      .toMatchObject({ title: "List" });
    expect(classifyTool("claude", facts({ _meta: { claudeCode: { toolName: "Bash" } }, rawInput: { command: "ls" } }))).toMatchObject({ title: null });
    expect(classifyTool("codex", facts({ kind: "execute", rawInput: { command: "ls" } }))).toMatchObject({ title: null });
  });

  it("labels a tool by the bridge's name, else by class", () => {
    expect(toolLabel(facts({ name: "exec_command" }), { type: "command", source: "shell", command: "ls", cwd: null, actions: null, title: null }, "Bash")).toBe("exec_command");
    expect(toolLabel(facts({ kind: "search" }), { type: "web_search", action: "fetch", query: null, url: null }, "Grep")).toBe("WebFetch");
    expect(toolLabel(facts({ title: "mcp.s.t", _meta: { is_mcp_tool_call: true } }), { type: "tool", server: "s" }, "Bash")).toBe("mcp.s.t");
    expect(toolLabel(facts({ kind: "execute", title: "ls -la" }), { type: "command", source: "shell", command: "ls -la", cwd: null, actions: null, title: null }, "Bash")).toBe("Bash");
  });
});

describe("diffChanges", () => {
  it("merges Codex hunks of one file and keeps the kind from _meta", () => {
    const changes = diffChanges({ content: [
      { type: "diff", path: "/r/a.ts", oldText: "a\n", newText: "b\n", _meta: { kind: "update" } },
      { type: "diff", path: "/r/a.ts", oldText: "c\n", newText: "d\n", _meta: { kind: "update" } },
      { type: "diff", path: "/r/gone.ts", oldText: "x\ny\n", newText: "", _meta: { kind: "delete" } },
    ] });
    expect(changes).toEqual([
      { path: "/r/a.ts", kind: "update", move_path: null, diff: "@@\n-a\n+b\n@@\n-c\n+d", added: 2, removed: 2 },
      { path: "/r/gone.ts", kind: "delete", move_path: null, diff: "@@\n-x\n-y", added: 0, removed: 2 },
    ]);
  });

  it("reads a Claude creation diff as an add, skips patch-only blocks, and is null without diffs", () => {
    expect(diffChanges({ content: [{ type: "diff", path: "/r/new.md", oldText: null, newText: "hi\n" }] }))
      .toEqual([{ path: "/r/new.md", kind: "add", move_path: null, diff: "@@\n+hi", added: 1, removed: 0 }]);
    expect(diffChanges({ content: [{ type: "diff", path: "/r/p", oldText: null, newText: "",
      _meta: { kind: "update", jetbrains: { air: { diffPatch: { version: 1 } } } } }] })).toBeNull();
    expect(diffChanges({ content: [{ type: "terminal", terminalId: "t" }] })).toBeNull();
    expect(diffChanges({})).toBeNull();
  });
});
