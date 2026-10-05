import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionLogEntry } from "@multiremi/core/replica";
import { MemorySessionReplica, rowHeightKey } from "@multiremi/core/replica";
import { reservedRowHeight } from "./use-row-heights";
import { envelopeType, eventLayoutEntry, eventSummary, INTERNAL_ID_PREFIXES, isInboxTurn } from "./event-summary";

describe("event summaries", () => {
  it("uses the first nonempty plain line, removes markdown and internal identities", () => {
    expect(eventSummary("\n# **Task** [docs](https://example.com) `cmt_env_123` (ises_ab) tsk_cd\nSecond line")).toBe("Task docs");
    expect(eventSummary("- _Fix_ ~~broken~~ `code` [@QA](mention://agent/agt_123)")).toBe("Fix broken code @QA");
    expect(eventSummary("1. Work\nMore")).toBe("Work");
    expect(eventSummary("```ts\nconst value = 1;\n```\nMore")).toBe("const value = 1;");
    expect(eventSummary("# sevt_ab cmt_cd chat_ef\nActual update")).toBe("Actual update");
    expect(eventSummary("# Receipt `rct_abc123` acknowledged")).toBe("Receipt acknowledged");
  });

  it("caps a long summary without adding another line", () => {
    expect(eventSummary("x".repeat(200))).toBe(`${"x".repeat(120)}…`);
    expect(eventSummary("First\nSecond", 3)).toBe("Fir…");
  });

  it("recognizes inbox prompts", () => {
    expect(isInboxTurn("# 读收件箱 ises_123:82 (cmt_env_456)")).toBe(true);
    expect(isInboxTurn("## A normal task")).toBe(false);
  });

  it("covers every server createId prefix and strips legacy identities", () => {
    const source = resolve(process.cwd(), "../../../packages/server/src");
    const prefixes = new Set<string>();
    for (const path of readdirSync(source, { recursive: true })) {
      if (typeof path !== "string" || !path.endsWith(".ts")) continue;
      const body = readFileSync(resolve(source, path), "utf8");
      for (const match of body.matchAll(/createId\(["']([a-z_]+)["']\)/g)) prefixes.add(match[1]!);
    }
    expect(prefixes.size).toBeGreaterThan(80);
    for (const prefix of [...prefixes, "dec", "mem", "usr", "hrq", "cses"]) {
      expect(INTERNAL_ID_PREFIXES).toContain(prefix);
      expect(eventSummary("# Update " + prefix + "_abc123")).toBe("Update");
    }
  });

  it("classifies report roles and prioritizes source prefixes over kind", () => {
    expect(envelopeType({ kind: "report", to: { role: "delegator" } })).toBe("delegation");
    expect(envelopeType({ kind: "report", to: { role: "parent_owner" } })).toBe("child");
    expect(envelopeType({ kind: "report", to: { role: "relay" } })).toBe("relay");
    expect(envelopeType({ kind: "report", to: { role: "issue_owner" } })).toBe("generic");
    expect(envelopeType({ kind: "report", dedupeKey: "dependency_failed:x", to: { role: "delegator" } })).toBe("dependency_failed");
    expect(envelopeType({ kind: "reply", to: { role: "delegator" } })).toBe("delegation_progress");
    expect(envelopeType({ kind: "child_status" })).toBe("child");
    expect(envelopeType({ kind: "dependency_failed" })).toBe("dependency_failed");
    expect(envelopeType(null)).toBe("generic");
  });

  it("never reserves full-body or old disclosure heights for the fixed row", () => {
    const row: SessionLogEntry = { session_id: "s", id: "r", seq: 1, revision: 1,
      kind: "turn", body_md: "# Task", body_html: "<h1>Task</h1>", render_version: "md-v1" };
    const replica = new MemorySessionReplica({ s: { entries: [row] } });
    const collapsed = eventLayoutEntry(row);
    replica.writeRowHeight("s", 1, rowHeightKey({ revision: 1, renderVersion: row.render_version, widthPx: 800 }), 900);
    replica.writeRowHeight("s", 1, rowHeightKey({ revision: 1, renderVersion: "md-v1:issue-event-v1:expanded", widthPx: 800 }), 700);
    expect(reservedRowHeight(replica, "s", collapsed, 800)).toBeNull();
    replica.writeRowHeight("s", 1, rowHeightKey({ revision: 1, renderVersion: collapsed.render_version, widthPx: 800 }), 32);
    expect(reservedRowHeight(replica, "s", collapsed, 800)).toBe(32);
    expect(row.render_version).toBe("md-v1");
  });
});
