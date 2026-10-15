import { describe, expect, it } from "vitest";
import type { AgentTask } from "@multiremi/core/types/agent";
import {
  at, change, command, compaction, fileChange, message, notice, permission, plan, read, reasoning, search, subagent, tool,
  unknown, userMessage, webSearch,
} from "../../test/trace-fixtures";
import {
  formatEventTime,
  formatProvider,
  formatStepDuration,
  getItemColor,
  getItemLabel,
  getItemSummary,
  itemDurationMs,
  itemFilterKey,
  usageSnapshotFromTask,
} from "./event-format";

describe("getItemColor", () => {
  it("maps each item kind to its lane colour", () => {
    expect(getItemColor(message("m", "hi"))).toBe("agent");
    expect(getItemColor(reasoning("r", "hm"))).toBe("thinking");
    expect(getItemColor(command("c", [read("a.ts")]))).toBe("tool");
    expect(getItemColor(command("c", [unknown("x")], { status: "failed" }))).toBe("error");
    expect(getItemColor(userMessage("u", "steer"))).toBe("steer");
    expect(getItemColor(notice("n", "boom", "error"))).toBe("error");
    expect(getItemColor(plan([]))).toBe("result");
  });
});

describe("getItemLabel", () => {
  it("prefers the tool name for tool items", () => {
    expect(getItemLabel(command("c", [read("a.ts")]))).toBe("Bash");
    expect(getItemLabel(tool("t", "mcp__linear__search"))).toBe("mcp__linear__search");
    expect(getItemLabel(message("m", "x", "final"))).toBe("Final");
    expect(getItemLabel(compaction("cmp"))).toBe("Compaction");
  });

  it("distinguishes a user steer from a force-answer request", () => {
    const steer = { ...userMessage("s", "go"), origin: "steer" as const, steer: { steer_id: "s", kind: "steer", injected: true, author_type: null, author_id: null } };
    expect(getItemLabel(steer)).toBe("User steer");
    expect(getItemLabel({ ...steer, steer: { ...steer.steer, kind: "force_answer" } })).toBe("Deliver now");
  });
});

describe("getItemSummary", () => {
  it("uses the first non-empty line of text", () => {
    expect(getItemSummary(message("m", "\n\nfirst\nsecond"))).toBe("first");
  });

  it("summarizes commands by their text, else by the parsed action", () => {
    expect(getItemSummary(command("c", [unknown("bun test")]))).toBe("bun test");
    expect(getItemSummary(command("c", [read("/repo/src/a/b.ts")], { command: null }))).toBe("cat /repo/src/a/b.ts");
    expect(getItemSummary({ ...command("c", [search("todo")]), command: null, actions: [{ type: "search", command: null, query: "todo", path: null }] })).toBe("todo");
    expect(getItemSummary(command("c", [unknown("x".repeat(200))])).endsWith("...")).toBe(true);
  });

  it("summarizes files, searches, tools, subagents, plans and permissions", () => {
    expect(getItemSummary(fileChange("f", [change("/repo/src/a/b.ts"), change("c.ts")]))).toBe(".../a/b.ts, c.ts");
    expect(getItemSummary(webSearch("w", "acp"))).toBe("acp");
    expect(getItemSummary(tool("t", "x", { input: { file_path: "/a/b/c/d.ts" } }))).toBe(".../c/d.ts");
    expect(getItemSummary(subagent("s", "Explore"))).toBe("Explore");
    expect(getItemSummary(plan([{ content: "a", status: "completed", priority: null }, { content: "b", status: "pending", priority: null }]))).toBe("1/2 · a · b");
    expect(getItemSummary(permission("p", "Bash"))).toBe("Bash · selected");
  });
});

describe("item filters and timing", () => {
  it("filters tool items by tool and the rest by type", () => {
    expect(itemFilterKey(command("c", [read("a.ts")]))).toBe("tool:Bash");
    expect(itemFilterKey(message("m", "hi"))).toBe("agent_message");
  });

  it("prefers the daemon's duration, else the item's own span", () => {
    expect(itemDurationMs(command("c", [read("a.ts")], { duration_ms: 1234 }))).toBe(1234);
    expect(itemDurationMs(reasoning("r", "x", { started_at: at(0), completed_at: at(3) }))).toBe(3000);
    expect(itemDurationMs(message("m", "x"))).toBeNull();
  });
});

describe("small formatters", () => {
  it("names the known providers and passes the rest through", () => {
    expect(formatProvider("CLAUDE")).toBe("Claude Code");
    expect(formatProvider("claude-code")).toBe("Claude Code");
    expect(formatProvider("codex")).toBe("Codex");
    expect(formatProvider("gemini")).toBe("gemini");
  });

  it("switches step duration from ms to s at one second", () => {
    expect(formatStepDuration(999)).toBe("999ms");
    expect(formatStepDuration(1500)).toBe("1.5s");
  });

  it("returns an empty string for an unparseable timestamp", () => {
    expect(formatEventTime("not-a-date")).toBe("");
    expect(formatEventTime("2026-01-01T10:00:00Z")).not.toBe("");
  });
});

describe("usageSnapshotFromTask", () => {
  it("sums every provider entry and keeps the last model", () => {
    const task = {
      usage: [
        { model: "sonnet", inputTokens: 10, outputTokens: 5 },
        { model: "opus", inputTokens: 1, totalTokens: 7 },
      ],
    } as AgentTask;

    expect(usageSnapshotFromTask(task)).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 7,
      model: "opus",
    });
  });

  it("returns null when the task carries no usage at all", () => {
    expect(usageSnapshotFromTask({} as AgentTask)).toBeNull();
    expect(usageSnapshotFromTask({ usage: [] } as unknown as AgentTask)).toBeNull();
  });

  it("returns null when every counter is zero — nothing worth showing", () => {
    const task = { usage: [{ inputTokens: 0, outputTokens: 0 }] } as AgentTask;
    expect(usageSnapshotFromTask(task)).toBeNull();
  });
});
