import { describe, expect, it } from "vitest";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TimelineItem } from "./build-timeline";
import {
  formatEventTime,
  formatProvider,
  formatStepDuration,
  getEventColor,
  getEventLabel,
  getEventSummary,
  isSubagentStep,
  omitKeys,
  shortThreadId,
  usageSnapshotFromTask,
} from "./event-format";

function item(over: Partial<TimelineItem> & Pick<TimelineItem, "type">): TimelineItem {
  return { seq: 1, ...over };
}

describe("getEventColor", () => {
  it("maps each event kind to its lane colour", () => {
    expect(getEventColor(item({ type: "text" }))).toBe("agent");
    expect(getEventColor(item({ type: "thinking" }))).toBe("thinking");
    expect(getEventColor(item({ type: "tool_use" }))).toBe("tool");
    expect(getEventColor(item({ type: "tool_result" }))).toBe("result");
    expect(getEventColor(item({ type: "steer" }))).toBe("steer");
    expect(getEventColor(item({ type: "error" }))).toBe("error");
  });

  it("falls back to the neutral lane for kinds it has never seen", () => {
    expect(getEventColor(item({ type: "permission_request" }))).toBe("result");
  });
});

describe("getEventLabel", () => {
  it("prefers the tool name over the generic label", () => {
    expect(getEventLabel(item({ type: "tool_use", tool: "Bash" }))).toBe("Bash");
    expect(getEventLabel(item({ type: "tool_use" }))).toBe("Tool");
    expect(getEventLabel(item({ type: "tool_result" }))).toBe("Result");
  });

  it("renders an unknown kind as spaced words rather than 'Event'", () => {
    expect(getEventLabel(item({ type: "plan_update" as TimelineItem["type"] }))).toBe("plan update");
  });

  it("distinguishes a user steer from a force-answer request", () => {
    expect(getEventLabel(item({ type: "steer", meta: { steer_kind: "steer" } })))
      .toBe("User steer");
    expect(getEventLabel(item({ type: "steer", meta: { steer_kind: "force_answer" } })))
      .toBe("Deliver now");
  });
});

describe("getEventSummary", () => {
  it("uses the first non-empty line of agent text", () => {
    expect(getEventSummary(item({ type: "text", content: "\n\n  hello there\nsecond" })))
      .toBe("  hello there");
  });

  it("shortens a deep file path from a tool input", () => {
    expect(
      getEventSummary(item({ type: "tool_use", input: { file_path: "/a/b/c/d/e.ts" } })),
    ).toBe(".../d/e.ts");
  });

  it("leaves a shallow path alone", () => {
    expect(getEventSummary(item({ type: "tool_use", input: { path: "a/b.ts" } }))).toBe("a/b.ts");
  });

  it("truncates a long command", () => {
    const cmd = "x".repeat(200);
    const summary = getEventSummary(item({ type: "tool_use", input: { command: cmd } }));
    expect(summary).toHaveLength(123);
    expect(summary.endsWith("...")).toBe(true);
  });

  it("falls back to any short string field", () => {
    expect(getEventSummary(item({ type: "tool_use", input: { whatever: "ok" } }))).toBe("ok");
  });

  it("returns empty for a tool_use with no input at all", () => {
    expect(getEventSummary(item({ type: "tool_use" }))).toBe("");
  });

  it("appends the option count to a permission request", () => {
    expect(
      getEventSummary(
        item({
          type: "permission_request",
          content: "Permission requested: Bash",
          input: { options: [{}, {}] },
        }),
      ),
    ).toBe("Permission requested: Bash (2)");
  });

  it("joins the chosen option and status on a response", () => {
    expect(
      getEventSummary(
        item({ type: "permission_response", input: { option_id: "allow", status: "answered" } }),
      ),
    ).toBe("allow · answered");
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

  it("shows only the head of a thread uuid", () => {
    expect(shortThreadId("0123456789abcdef")).toBe("01234567");
  });

  it("drops the keys a detail pane renders itself", () => {
    expect(omitKeys({ a: 1, b: 2, c: 3 }, ["b"])).toEqual({ a: 1, c: 3 });
  });

  it("recognizes the two subagent-delegating tools", () => {
    expect(isSubagentStep("Agent")).toBe(true);
    expect(isSubagentStep("Task")).toBe(true);
    expect(isSubagentStep("Bash")).toBe(false);
    expect(isSubagentStep(undefined)).toBe(false);
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
