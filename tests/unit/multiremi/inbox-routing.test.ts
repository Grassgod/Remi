import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INBOX_ROUTING, inboxRouteFor } from "@multiremi/store/inbox-routing.js";

describe("inbox routing", () => {
  it("routes one representative event for each boundary rule", () => {
    expect(inboxRouteFor("issue_assigned")).toBe("inbox_action");
    expect(inboxRouteFor("comment_created", { issueStatus: "in_review", actorType: "member" }))
      .toBe("workbench_only");
    expect(inboxRouteFor("autopilot_run_completed")).toBe("inbox_ledger");
    expect(inboxRouteFor("unregistered_event")).toBe("activity_only");
  });

  it("routes comment broadcasts by workbench visibility and actor type", () => {
    expect(inboxRouteFor("comment_created", { issueStatus: "in_progress", actorType: "member" }))
      .toBe("workbench_only");
    expect(inboxRouteFor("comment_created", { issueStatus: "blocked", actorType: "agent" }))
      .toBe("workbench_only");
    expect(inboxRouteFor("comment_created", { issueStatus: "backlog", actorType: "member" }))
      .toBe("inbox_action");
    expect(inboxRouteFor("comment_created", { issueStatus: "done", actorType: "agent" }))
      .toBe("activity_only");
  });

  it("registers every createInboxItem call site type", () => {
    const sourceRoot = resolve(import.meta.dir, "../../../packages/server/src");
    const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: sourceRoot, absolute: true })];
    const calls: Array<{ file: string; type: string }> = [];
    let invocationCount = 0;

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      invocationCount += [...source.matchAll(/\.createInboxItem\s*\(/g)].length;
      for (const match of source.matchAll(/\.createInboxItem\s*\(\s*\{([\s\S]*?)\n\s*\}\);/g)) {
        const type = match[1]?.match(/\btype:\s*"([^"]+)"/)?.[1];
        expect(type, `${file} has a createInboxItem call without a literal type`).toBeDefined();
        if (type) calls.push({ file, type });
      }
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(invocationCount);
    for (const call of calls) {
      expect(INBOX_ROUTING, `${call.file}: ${call.type} is missing from INBOX_ROUTING`)
        .toHaveProperty(call.type);
    }
  });
});
