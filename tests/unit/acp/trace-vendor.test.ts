import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CODEX_COLLAB_TOOLS,
  antigravityToolName,
  autonomousOrigin,
  classifyTool,
  codexActionFromTitle,
  commandTitle,
  compactionFacts,
  diffChanges,
  endsWithAbortMarker,
  frameSession,
  isAsyncLaunch,
  isNativeAgentHook,
  launchMarker,
  isMcp,
  isWorkspaceTrustPrompt,
  mcpServer,
  mergeToolFacts,
  messagePhase,
  nativeAgentFacts,
  nativeAgentId,
  nativeAgentItemId,
  nativeAgentPrompt,
  normalizeToolInput,
  parentToolUseId,
  permissionAsQuestion,
  requestUsageOwner,
  serviceMessage,
  serviceMessageFailure,
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
    // PR 5 §3.6: the other collaboration calls act on agents; they are tool rows.
    expect(classifyTool("codex", facts({ kind: "other", title: "wait",
      rawInput: { prompt: null, senderThreadId: "root", receiverThreadIds: [], model: null } }))).toEqual({ type: "tool", server: null });
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

// ── Antigravity (antigravity-acp 1.4.0, PR 4 §5) ────────────────────────────

const agyFacts = (...frames: Array<Record<string, unknown>>) =>
  frames.reduce<ReturnType<typeof mergeToolFacts> | null>((previous, frame) => mergeToolFacts(previous, frame, "antigravity"), null)!;
const agyFixture = (name: string): Array<Record<string, unknown>> =>
  (JSON.parse(readFileSync(new URL(`../../fixtures/acp/${name}`, import.meta.url), "utf8")) as Array<{ params: { update: Record<string, unknown> } }>)
    .map((row) => row.params.update);

describe("Antigravity vendor reads", () => {
  it("normalizes PascalCase, snake_case and JSON-string rawInput to canonical keys", () => {
    expect(normalizeToolInput({ CommandLine: "ls -la", Cwd: "/w", WaitMsBeforeAsync: 5000 })).toEqual({ command: "ls -la", cwd: "/w", WaitMsBeforeAsync: 5000 });
    expect(normalizeToolInput({ command_line: "ls -la", working_dir: "/w" })).toEqual({ command: "ls -la", cwd: "/w" });
    expect(normalizeToolInput('{"AbsolutePath":"/w/a.md","toolSummary":"Read"}')).toEqual({ path: "/w/a.md", toolSummary: "Read" });
    expect(normalizeToolInput({ TargetFile: "/w/b.md", CodeContent: "x" })).toEqual({ path: "/w/b.md", CodeContent: "x" });
    expect(normalizeToolInput({ DirectoryPath: "/w" })).toEqual({ path: "/w" });
    expect(normalizeToolInput({ Query: "alpha", SearchPath: "/w" })).toEqual({ query: "alpha", path: "/w" });
    expect(normalizeToolInput({ Pattern: "*.ts", SearchDirectory: "/w" })).toEqual({ query: "*.ts", path: "/w" });
    expect(normalizeToolInput({ Url: "https://x" })).toEqual({ url: "https://x" });
    // The first spelling present wins; a null alias is skipped.
    expect(normalizeToolInput({ CommandLine: null, command: "pwd" })).toEqual({ command: "pwd" });
    expect(normalizeToolInput("not json")).toEqual({ value: "not json" });
    expect(normalizeToolInput("")).toBeNull();
    expect(normalizeToolInput([1])).toBeNull();
    expect(normalizeToolInput({})).toEqual({});
  });

  it("names tools from MCP meta, the execute kind, or the Run / Running title", () => {
    expect(antigravityToolName({ title: "github_search_issues", kind: "other", _meta: { mcp: { tool: "search_issues", server: "github" } } })).toBe("search_issues");
    expect(antigravityToolName({ kind: "execute", title: "Running tests" })).toBe("run_command");
    expect(antigravityToolName({ kind: "read", title: "Run view_file?" })).toBe("view_file");
    expect(antigravityToolName({ kind: "read", title: "Running view_file" })).toBe("view_file");
    expect(antigravityToolName({ title: "Which colour?" })).toBeNull();
    expect(antigravityToolName({ status: "completed" })).toBeNull();
  });

  it("merges the frames of one call despite their key spellings", () => {
    const [, start, live, done] = agyFixture("antigravity-140-turn-notifications.json");
    const merged = agyFacts(start!, live!, done!);
    expect(merged).toMatchObject({ id: "0446f287f8f345bebe093a06340941f3", name: "run_command", kind: "execute",
      input: { command: "ls -la", cwd: "/tmp/agy-live/work", WaitMsBeforeAsync: 5000 } });
    expect(Object.keys(merged.input!)).not.toContain("command_line");
    // Other agents keep their raw input.
    expect(mergeToolFacts(null, start!, "codex").input).toMatchObject({ CommandLine: "ls -la" });
  });

  it("classifies the §5 tool table", () => {
    const c = (frame: Record<string, unknown>) => classifyTool("antigravity", agyFacts(frame));
    expect(c({ kind: "execute", title: "ls -la", rawInput: { CommandLine: "ls -la", Cwd: "/w" } }))
      .toEqual({ type: "command", source: "shell", command: "ls -la", cwd: "/w", actions: null, title: null });
    // Before the input streams the title is the command.
    expect(c({ kind: "execute", title: "git status" })).toMatchObject({ type: "command", command: "git status", cwd: null });
    expect(c({ kind: "execute", title: "ls", rawInput: '{"CommandLine":"ls","toolSummary":"List files"}' })).toMatchObject({ title: "List files" });
    expect(c({ kind: "read", title: "Running view_file", rawInput: { AbsolutePath: "/w/a.md" } }))
      .toMatchObject({ type: "command", source: "tool", actions: [{ type: "read", path: "/w/a.md", name: "a.md" }] });
    expect(c({ kind: "read", title: "Run read_file?", locations: [{ path: "/w/b.md" }] })).toMatchObject({ actions: [{ type: "read", path: "/w/b.md" }] });
    expect(c({ kind: "search", title: "Running grep_search", rawInput: { Query: "alpha", SearchPath: "/w" } }))
      .toMatchObject({ type: "command", actions: [{ type: "search", query: "alpha", path: "/w" }] });
    expect(c({ kind: "search", title: "Running find_by_name", rawInput: { Pattern: "*.md", SearchDirectory: "/w" } }))
      .toMatchObject({ actions: [{ type: "search", query: "*.md", path: "/w" }] });
    expect(c({ kind: "search", title: "Running list_dir", rawInput: { DirectoryPath: "/w" } }))
      .toMatchObject({ type: "command", actions: [{ type: "list_files", path: "/w" }] });
    for (const tool of ["write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file", "create_file"]) {
      expect(c({ kind: "edit", title: `Running ${tool}` })).toEqual({ type: "file_change" });
    }
    expect(c({ kind: "search", title: "Running search_web", rawInput: { query: "acp" } })).toEqual({ type: "web_search", action: "search", query: "acp", url: null });
    expect(c({ kind: "fetch", title: "Running read_url_content", rawInput: { Url: "https://x" } }))
      .toEqual({ type: "web_search", action: "fetch", query: null, url: "https://x" });
    expect(c({ kind: "other", title: "github_search_issues", rawInput: { q: "x" }, _meta: { mcp: { tool: "search_issues", server: "github" }, is_mcp_tool_call: true } }))
      .toEqual({ type: "tool", server: "github" });
    expect(c({ kind: "other", title: "Running browser_subagent", rawInput: { Task: "t" } })).toEqual({ type: "tool", server: null });
    // The ask_user stand-in is the question item, never a tool item.
    expect(c({ toolCallId: "interaction_ab12cd34", title: "Which colour?", rawInput: {}, status: "pending" })).toEqual({ type: "suppress" });
    expect(c({ toolCallId: "interaction_ab12cd34", title: "Run thing?", rawInput: { x: 1 } })).toEqual({ type: "tool", server: null });
  });

  it("labels Antigravity tools by their own names", () => {
    const facts = agyFacts({ kind: "read", title: "Running view_file", rawInput: { AbsolutePath: "/w/a.md" } });
    expect(toolLabel(facts, classifyTool("antigravity", facts), "view_file")).toBe("view_file");
  });

  it("reads Antigravity diffs: modify is an update, add is a creation", () => {
    expect(diffChanges({ content: [{ type: "diff", path: "/w/notes.txt", oldText: "beta", newText: "BETA", _meta: { kind: "modify" } }] }))
      .toEqual([{ path: "/w/notes.txt", kind: "update", move_path: null, diff: "@@\n-beta\n+BETA", added: 1, removed: 1 }]);
    expect(diffChanges({ content: [{ type: "diff", path: "/w/new.md", oldText: null, newText: "hi\n", _meta: { kind: "add" } }] }))
      .toEqual([{ path: "/w/new.md", kind: "add", move_path: null, diff: "@@\n+hi", added: 1, removed: 0 }]);
  });
});

describe("Antigravity permission requests", () => {
  const question = {
    sessionId: "s", toolCall: { toolCallId: "interaction_ab12cd34", title: "Which colour?", rawInput: {}, status: "pending" },
    options: [{ optionId: "red", name: "Red", kind: "allow_once" }, { optionId: "blue", name: "Blue", kind: "allow_once" }],
  };
  const trust = {
    sessionId: "s", toolCall: { toolCallId: "interaction_ef567890", title: "Do you trust the authors of this workspace to execute automated agent hooks?", rawInput: {} },
    options: [{ optionId: "trust", name: "Trust Workspace", kind: "allow_once" }, { optionId: "deny", name: "Don't Trust", kind: "reject_once" }],
  };
  const approval = {
    sessionId: "s", toolCall: { toolCallId: "t-ls", title: "ls -la", kind: "execute", rawInput: { CommandLine: "ls -la" } },
    options: [{ optionId: "allow_always", name: "Allow Always", kind: "allow_always" }, { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" }],
  };

  it("recognizes the model's single-choice question", () => {
    expect(permissionAsQuestion(question)).toEqual({ question: "Which colour?", options: [{ optionId: "red", label: "Red" }, { optionId: "blue", label: "Blue" }] });
    expect(permissionAsQuestion(approval)).toBeNull();
    expect(permissionAsQuestion(trust)).toBeNull();
    expect(permissionAsQuestion({ ...question, toolCall: { ...question.toolCall, kind: "other" } })).toBeNull();
    expect(permissionAsQuestion({ ...question, toolCall: { ...question.toolCall, toolCallId: "t-1" } })).toBeNull();
    expect(permissionAsQuestion({ ...question, toolCall: { ...question.toolCall, rawInput: { a: 1 } } })).toBeNull();
    expect(permissionAsQuestion({ ...question, options: [...question.options, { optionId: "deny", name: "No", kind: "reject_once" }] })).toBeNull();
    expect(permissionAsQuestion({ ...question, options: [] })).toBeNull();
  });

  it("recognizes the workspace-trust prompt by its exact option ids", () => {
    expect(isWorkspaceTrustPrompt(trust)).toBe(true);
    expect(isWorkspaceTrustPrompt(question)).toBe(false);
    expect(isWorkspaceTrustPrompt(approval)).toBe(false);
    expect(isWorkspaceTrustPrompt({ ...trust, options: [...trust.options, { optionId: "x", name: "x", kind: "allow_once" }] })).toBe(false);
  });
});

describe("Antigravity service messages", () => {
  it("classifies execution, connection and model-replacement text", () => {
    expect(serviceMessage("Agent execution error: 503 Service Unavailable")).toEqual({ type: "failure", source: "execution", details: "503 Service Unavailable" });
    expect(serviceMessage("Agent connection was lost and could not be re-established: closed")).toEqual({ type: "failure", source: "connection", details: "closed" });
    expect(serviceMessage("gemini-2.5-pro is no longer available. Using gemini-2.5-flash.\n\nHi"))
      .toEqual({ type: "model_replaced", previous: "gemini-2.5-pro", replacement: "gemini-2.5-flash", rest: "Hi" });
    expect(serviceMessage("The request was cancelled by the client.")).toBeNull();
    expect(serviceMessage("I found an Agent execution error: in the logs")).toBeNull();
  });

  it("categorizes the failure by the gateway status the shim saw", () => {
    const failure = { type: "failure" as const, source: "execution" as const, details: "401 Unauthorized" };
    expect(serviceMessageFailure(failure, "f1", 401)).toEqual({ id: "f1", revision: 1, severity: "error", category: "authentication",
      errorKind: "authentication_failed", title: "Antigravity gateway rejected the credentials", details: "401 Unauthorized" });
    expect(serviceMessageFailure(failure, "f2", 503)).toMatchObject({ category: "unknown", title: "Antigravity execution error" });
    expect(serviceMessageFailure(failure, "f2", 503)).not.toHaveProperty("errorKind");
    expect(serviceMessageFailure({ ...failure, source: "connection" }, "f3", null)).toMatchObject({ category: "connection" });
  });
});

describe("native subagent reads (PR 5 §3)", () => {
  it("reads the provider's child-session stamp; a root frame has none", () => {
    expect(frameSession({ sessionUpdate: "tool_call", _meta: { remiSessionId: "a0000000000000001" } })).toBe("a0000000000000001");
    expect(frameSession({ sessionUpdate: "tool_call", _meta: { claudeCode: { parentToolUseId: "toolu_01" } } })).toBeNull();
    expect(frameSession({ sessionUpdate: "tool_call", _meta: { remiSessionId: "" } })).toBeNull();
  });

  it("strips the generation suffix of a resumed agent", () => {
    expect(nativeAgentId("a0000000000000001:generation:2")).toBe("a0000000000000001");
    expect(nativeAgentId("00000000-0000-7000-8000-000000000001:generation:12")).toBe("00000000-0000-7000-8000-000000000001");
    expect(nativeAgentId("a0000000000000001")).toBe("a0000000000000001");
  });

  it("reads the result origin of a model cycle (claude-agent-acp 0.90 `_claude/origin`)", () => {
    expect(autonomousOrigin({ sessionUpdate: "usage_update", _meta: { "_claude/origin": { kind: "task-notification", runId: "run_01" } } }))
      .toBe("task-notification");
    expect(autonomousOrigin({ sessionUpdate: "usage_update", _meta: { "_claude/origin": { kind: "human" } } })).toBe("human");
    expect(autonomousOrigin({ sessionUpdate: "usage_update", _meta: { "_claude/model": "claude-opus-5-5" } })).toBeNull();
  });

  it("reads the bridge patch's facts and the item id of any generation", () => {
    expect(nativeAgentFacts({ _meta: { remi: { backgrounded: true, subagentType: "general-purpose" } } }))
      .toEqual({ background: true, agentType: "general-purpose" });
    expect(nativeAgentFacts({ _meta: { remi: { backgrounded: null, subagentType: null } } })).toEqual({ background: null, agentType: null });
    expect(nativeAgentFacts({})).toEqual({ background: null, agentType: null });
    expect(nativeAgentItemId("a0000000000000001:generation:3")).toBe("sa:a0000000000000001");
  });

  it("reads who made a billed request and its model", () => {
    expect(requestUsageOwner({ _meta: { remiTokenUsage: { parentToolUseId: "toolu_01", providerSessionId: "s", model: "claude-opus-5-5" } } }))
      .toEqual({ parentToolUseId: "toolu_01", providerSessionId: "s", model: "claude-opus-5-5" });
    expect(requestUsageOwner({ _meta: { remiTokenUsage: { model: "<synthetic>" } } })).toEqual({ parentToolUseId: null, providerSessionId: null, model: null });
    expect(requestUsageOwner({ _meta: {} })).toBeNull();
  });

  it("takes the prompt, else a real task, never Codex's stand-in", () => {
    expect(nativeAgentPrompt({ prompt: "List the files", task: "List the files" })).toBe("List the files");
    expect(nativeAgentPrompt({ task: "Count files" })).toBe("Count files");
    expect(nativeAgentPrompt({ task: "Delegated task for Count files" })).toBeNull();
    expect(nativeAgentPrompt({ task: "Delegated task" })).toBeNull();
    expect(nativeAgentPrompt({})).toBeNull();
  });

  it("recognises Claude's orphan Agent hook update (0.89 shape)", () => {
    const hook = (toolResponse: unknown) => ({ sessionUpdate: "tool_call_update", toolCallId: "toolu_01",
      _meta: { claudeCode: { toolName: "Agent", toolResponse } } });
    expect(isNativeAgentHook(hook({ status: "async_launched", isAsync: true }))).toBe(true);
    expect(isNativeAgentHook(hook({ status: "completed" }))).toBe(true);
    // A progress beat carries no marker; another tool is not an Agent call; a tool_call is not the hook.
    expect(isNativeAgentHook(hook({ elapsedTimeSeconds: 3 }))).toBe(false);
    expect(isNativeAgentHook({ ...hook({ status: "completed" }), _meta: { claudeCode: { toolName: "Bash", toolResponse: { status: "completed" } } } }))
      .toBe(false);
    expect(isNativeAgentHook({ ...hook({ status: "completed" }), sessionUpdate: "tool_call" })).toBe(false);
  });

  it("classifies every Codex collaboration call but spawnAgent as a tool named by its title (§3.6)", () => {
    expect([...CODEX_COLLAB_TOOLS].sort()).toEqual(["closeAgent", "followupTask", "interruptAgent", "listAgents", "resumeAgent",
      "sendInput", "sendMessage", "spawnAgent", "wait"]);
    for (const title of CODEX_COLLAB_TOOLS) {
      const call = facts({ kind: "other", title, rawInput: { prompt: "go on", senderThreadId: "root", receiverThreadIds: ["child-1"] } });
      const cls = classifyTool("codex", call);
      if (title === "spawnAgent") {
        expect(cls).toMatchObject({ type: "subagent", threadId: "child-1", prompt: "go on" });
      } else {
        expect(cls).toEqual({ type: "tool", server: null });
        expect(toolLabel(call, cls, "unknown")).toBe(title);
      }
    }
    // The AIR activity calls stay subagents (the fallback without native sessions).
    expect(classifyTool("codex", facts({ kind: "other", title: "Interact with subagent count_files",
      _meta: { jetbrains: { air: { version: 1, subagent: true } } }, rawInput: { agentThreadId: "t", agentPath: "/root/count_files" } })))
      .toMatchObject({ type: "subagent", name: "count_files" });
  });
});
