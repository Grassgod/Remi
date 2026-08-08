import { describe, expect, it } from "bun:test";
import { canonicalToolName, titleToToolName, KNOWN_TOOL_NAMES } from "@acp/adapters/tool-name.js";
import { ClaudeAdapter } from "@acp/adapters/claude-code/index.js";
import { CodexAdapter } from "@acp/adapters/codex/index.js";
import type { ToolCallUpdate } from "@shared/contracts/acp-protocol.js";

function toolCall(title: string, extra: Partial<ToolCallUpdate> = {}): ToolCallUpdate {
  return { sessionUpdate: "tool_call", toolCallId: "t1", title, ...extra } as ToolCallUpdate;
}

describe("canonicalToolName", () => {
  it("collapses separators and casing before matching aliases", () => {
    expect(canonicalToolName("apply_patch")).toBe("Edit");
    expect(canonicalToolName("Apply Patch")).toBe("Edit");
    expect(canonicalToolName("apply-patch")).toBe("Edit");
    expect(canonicalToolName("file_search")).toBe("Grep");
    expect(canonicalToolName("spawnAgent")).toBe("Agent");
  });

  it("returns the name unchanged when no alias matches", () => {
    expect(canonicalToolName("Task")).toBe("Task");
    expect(canonicalToolName("mcp__foo__bar")).toBe("mcp__foo__bar");
  });

  it("returns null for a name with no letters, so callers pick the fallback", () => {
    expect(canonicalToolName("")).toBeNull();
    expect(canonicalToolName("  ")).toBeNull();
    expect(canonicalToolName("_-_")).toBeNull();
  });

  it("only produces names the adapters consider canonical", () => {
    for (const alias of ["shell", "readfile", "createfile", "rg", "openurl", "searchweb", "reasoning", "askuser", "readytocode", "enterplanmode", "glob"]) {
      expect(KNOWN_TOOL_NAMES.has(canonicalToolName(alias)!)).toBe(true);
    }
  });
});

describe("titleToToolName", () => {
  it("prefers an exact tool name over the substring heuristics", () => {
    // "TodoWrite" contains "write"; the exact pass must win.
    expect(titleToToolName("TodoWrite")).toBe("TodoWrite");
    expect(titleToToolName("ExitPlanMode")).toBe("ExitPlanMode");
    expect(titleToToolName("EnterPlanMode")).toBe("EnterPlanMode");
  });

  it("guesses from sentence-shaped titles", () => {
    expect(titleToToolName("bash -c ls")).toBe("Bash");
    expect(titleToToolName("read file.ts")).toBe("Read");
    expect(titleToToolName("create file.ts")).toBe("Write");
    expect(titleToToolName("diff view")).toBe("Edit");
    expect(titleToToolName("glob **/*.ts")).toBe("Glob");
    expect(titleToToolName("search foo")).toBe("Grep");
    expect(titleToToolName("Web-Search remi")).toBe("WebSearch");
    expect(titleToToolName("fetch url")).toBe("WebFetch");
    expect(titleToToolName("Start subagent reviewer")).toBe("Agent");
    expect(titleToToolName("think hard")).toBe("Think");
    expect(titleToToolName("Plan the refactor")).toBe("TodoWrite");
  });

  it("falls back to the raw title, or 'unknown' when there is none", () => {
    expect(titleToToolName("Deploy the fleet")).toBe("Deploy the fleet");
    expect(titleToToolName("")).toBe("unknown");
  });
});

describe("both adapters share one table", () => {
  const claude = new ClaudeAdapter();
  const codex = new CodexAdapter();

  it("resolves title-only tool calls identically", () => {
    for (const title of ["glob **/*.ts", "shell command", "patch file", "Start subagent reviewer", "search foo", "Plan"]) {
      const update = toolCall(title);
      expect(claude.resolveToolName(update), title).toBe(codex.resolveToolName(update));
    }
  });

  it("keeps each adapter's own name source ahead of the shared table", () => {
    // claude reads _meta.claudeCode.toolName ...
    expect(claude.resolveToolName(toolCall("write a summary", { _meta: { claudeCode: { toolName: "Task" } } } as Partial<ToolCallUpdate>))).toBe("Task");
    // ... codex reads rawInput.toolName.
    expect(codex.resolveToolName(toolCall("write a summary", { rawInput: { toolName: "apply_patch" } } as Partial<ToolCallUpdate>))).toBe("Edit");
  });
});
