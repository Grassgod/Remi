import { describe, expect, it } from "bun:test";
import { createAdapter } from "@acp/index.js";
import { createEventMapper } from "@multiremi/worker/acp-event-mapper.js";
import { taskMessageToTraceEvent, type TraceEvent } from "@multiremi/contracts/trace.js";
import { countToolCalls, summarizeTrace } from "@shared/trace-derive.js";
import { FeishuCotTimeline } from "@connectors/feishu/cot-timeline.js";

// Non-sensitive wire frames reproduced with claude-agent-acp 0.85.0's
// ToolCallFieldTracker / ChangedMetaFilter: only changed fields are repeated.
const sparseShell = [
  { sessionUpdate: "tool_call", toolCallId: "shell", name: "Bash", title: "Terminal", kind: "execute", status: "pending",
    _meta: { claudeCode: { toolName: "Bash" }, terminal_info: { terminal_id: "shell" } },
    content: [{ type: "terminal", terminalId: "shell" }] },
  { sessionUpdate: "tool_call_update", toolCallId: "shell", title: "git grep needle src | head -20",
    _meta: { jetbrains: { air: { version: 1, commandTitle: "Search the repository" } } } },
  { sessionUpdate: "tool_call_update", toolCallId: "shell",
    rawInput: { command: "git grep needle src | head -20", description: "Search the repository" } },
  { sessionUpdate: "tool_call_update", toolCallId: "shell",
    _meta: { terminal_output: { terminal_id: "shell", data: "MATCHED\n" } } },
  { sessionUpdate: "tool_call_update", toolCallId: "shell", status: "completed",
    _meta: { terminal_exit: { terminal_id: "shell", exit_code: 0, signal: null } } },
];

describe("ACP sparse trace normalization", () => {
  it("upgrades a title guess to a real name, then prevents sparse titles from changing it", () => {
    const map = createEventMapper(createAdapter("claude"));
    expect(map({ sessionUpdate: "tool_call", toolCallId: "late-name", title: "Search `needle`" } as never)[0]?.tool).toBe("Grep");
    expect(map({ sessionUpdate: "tool_call_update", toolCallId: "late-name", _meta: { claudeCode: { toolName: "Bash" } },
      rawInput: { command: "git grep needle" } } as never)[0]?.tool).toBe("Bash");
    expect(map({ sessionUpdate: "tool_call_update", toolCallId: "late-name", title: "Search `other`", status: "completed" } as never)[0]?.tool).toBe("Bash");
  });

  it("preserves identical legitimate stdout chunks and deduplicates only full terminal snapshots", () => {
    const map = createEventMapper(createAdapter("codex"));
    map({ sessionUpdate: "tool_call", toolCallId: "chunks", kind: "execute", title: "Terminal" } as never);
    const chunk = (data: string) => ({ sessionUpdate: "tool_call_update", toolCallId: "chunks",
      _meta: { terminal_output: { terminal_id: "chunks", data } } });
    expect(map(chunk("first\n") as never)[0]?.output).toBe("first\n");
    expect(map(chunk("first\n") as never)[0]?.output).toBe("first\nfirst\n");
    expect(map(chunk("second\n") as never)[0]?.output).toBe("first\nfirst\nsecond\n");
    const completed = { sessionUpdate: "tool_call_update", toolCallId: "chunks", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "first\nfirst\nsecond\n" } }] };
    expect(map(completed as never)[0]?.output).toBe("first\nfirst\nsecond\n");
    expect(map(completed as never)).toEqual([]);
  });

  it("keeps real shell identity, refines its args, persists output and counts one invocation", () => {
    const map = createEventMapper(createAdapter("claude"));
    const messages = sparseShell.flatMap(frame => map(frame as never));
    expect(new Set(messages.map(message => message.tool))).toEqual(new Set(["Bash"]));
    expect(messages.find(message => message.input?.command)).toMatchObject({ input: {
      command: "git grep needle src | head -20", description: "Search the repository",
    } });
    expect(messages.find(message => message.output)?.output).toBe("MATCHED\n");
    expect(messages.at(-1)).toMatchObject({ type: "tool_result", tool: "Bash", status: "completed" });
    const events: TraceEvent[] = messages.map((message, index) => ({
      ...taskMessageToTraceEvent(message, "2026-10-05T00:00:00Z"), seq: index + 1,
    } as TraceEvent));
    expect(countToolCalls(events)).toBe(1);
    expect(summarizeTrace(events, events.length).tool_call_count).toBe(1);
    const timeline = new FeishuCotTimeline("fixture");
    events.forEach(event => timeline.accept(event));
    expect(timeline.toolCount).toBe(1);
    expect(timeline.drain(true).samples.find(([type]) => type === "TOOL_CALL_START")?.[1])
      .toMatchObject({ toolCallName: "Bash", title: "Search the repository" });
  });

  it.each(["claude", "codex"] as const)("preserves nested ACP content and metadata-only terminal output for %s", provider => {
    const map = createEventMapper(createAdapter(provider));
    map({ sessionUpdate: "tool_call", toolCallId: "read", kind: "read", title: "Read",
      _meta: { claudeCode: { toolName: "Read" } }, rawInput: { file_path: "example.ts" } } as never);
    expect(map({ sessionUpdate: "tool_call_update", toolCallId: "read", status: "completed",
      content: [{ type: "content", content: { type: "text", text: "public fixture result" } }] } as never)[0]?.output)
      .toBe("public fixture result");
    map({ sessionUpdate: "tool_call", toolCallId: "shell", kind: "execute", title: "Terminal" } as never);
    const outputFrame = { sessionUpdate: "tool_call_update", toolCallId: "shell",
      _meta: { terminal_output: { terminal_id: "shell", data: "public output\n" } } };
    expect(map(outputFrame as never)[0]).toMatchObject({ tool: "Bash", output: "public output\n" });
    expect(map(outputFrame as never)[0]?.output).toBe("public output\npublic output\n");
    expect(map({ sessionUpdate: "tool_call_update", toolCallId: "shell", status: "cancelled" } as never)[0])
      .toMatchObject({ type: "tool_result", tool: "Bash", status: "cancelled" });
  });
});
