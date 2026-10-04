import { describe, expect, it } from "vitest";
import type { SessionLogEntry } from "@multiremi/core/replica";
import { MemorySessionReplica, rowHeightKey } from "@multiremi/core/replica";
import { reservedRowHeight } from "./use-row-heights";
import { chatIssueUpdate, delegationReporter, eventLayoutEntry, eventSummary, isInboxTurn } from "./event-summary";

describe("event summaries", () => {
  it("uses the first nonempty plain line, removes markdown and internal identities", () => {
    expect(eventSummary("\n# **Task** [docs](https://example.com) `cmt_env_123` (ises_ab) tsk_cd\nSecond line")).toBe("Task docs");
    expect(eventSummary("- _Fix_ ~~broken~~ `code` [@QA](mention://agent/agt_123)")).toBe("Fix broken code @QA");
    expect(eventSummary("1. Work\nMore")).toBe("Work");
    expect(eventSummary("```ts\nconst value = 1;\n```\nMore")).toBe("const value = 1;");
    expect(eventSummary("# sevt_ab cmt_cd chat_ef\nActual update")).toBe("Actual update");
  });

  it("caps a long summary without adding another line", () => {
    expect(eventSummary("x".repeat(200))).toBe(`${"x".repeat(120)}…`);
    expect(eventSummary("First\nSecond", 3)).toBe("Fir…");
  });

  it("recognizes inbox prompts and sanitizes delegation names", () => {
    expect(isInboxTurn("# 读收件箱 ises_123:82 (cmt_env_456)")).toBe(true);
    expect(isInboxTurn("## A normal task")).toBe(false);
    expect(delegationReporter("QA completed a task you delegated.\nRead the latest updates")).toBe("QA");
    expect(delegationReporter("QA could not complete a task you delegated.")).toBe("QA");
    expect(delegationReporter("A task you delegated to QA was cancelled.")).toBe("QA");
    expect(delegationReporter("agt_123 completed a task you delegated.")).toBe("");
  });

  it("gets Chat outcomes and links from envelope metadata with a legacy body fallback", () => {
    const body = "MUL-501 有新日志：会话 ises_123，seq (0, 10]；本次轮次 tsk_123 状态 failed";
    expect(chatIssueUpdate(body, { envelope: { outcome: "done", source: { issueId: "iss_501" } } }))
      .toEqual({ key: "MUL-501", issueId: "iss_501", outcome: "completed" });
    expect(chatIssueUpdate(body, { envelope: { source: { issueId: 123 } } }))
      .toEqual({ key: "MUL-501", issueId: "", outcome: "failed" });
    expect(chatIssueUpdate("Ordinary message", null)).toBeNull();
  });

  it("never reserves full-body or expanded heights for a collapsed row", () => {
    const row: SessionLogEntry = { session_id: "s", id: "r", seq: 1, revision: 1,
      kind: "turn", body_md: "# Task", body_html: "<h1>Task</h1>", render_version: "md-v1" };
    const replica = new MemorySessionReplica({ s: { entries: [row] } });
    const collapsed = eventLayoutEntry(row, "issue");
    const expanded = eventLayoutEntry(row, "issue", true);
    replica.writeRowHeight("s", 1, rowHeightKey({ revision: 1, renderVersion: row.render_version, widthPx: 800 }), 900);
    replica.writeRowHeight("s", 1, rowHeightKey({ revision: 1, renderVersion: expanded.render_version, widthPx: 800 }), 700);
    expect(reservedRowHeight(replica, "s", collapsed, 800)).toBeNull();
    expect(reservedRowHeight(replica, "s", expanded, 800)).toBe(700);
    expect(row.render_version).toBe("md-v1");
  });
});
