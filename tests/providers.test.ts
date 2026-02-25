import { describe, it, expect } from "bun:test";
import { ClaudeCLIProvider } from "../src/providers/claude-cli/provider.js";
import type { ToolUseRequest } from "../src/providers/claude-cli/protocol.js";
import type { ToolDefinition } from "../src/providers/base.js";

describe("ClaudeCLIProvider", () => {
  it("has correct name", () => {
    const provider = new ClaudeCLIProvider();
    expect(provider.name).toBe("claude_cli");
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

  it("unknown tool", async () => {
    const provider = makeProvider();
    const result = await provider._handleToolCall({
      kind: "tool_use",
      toolUseId: "t1",
      name: "nonexistent",
      input: {},
    });
    expect(result).toContain("Unknown tool");
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
