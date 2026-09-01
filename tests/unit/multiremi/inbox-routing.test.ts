import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INBOX_ROUTE_BY_TYPE } from "@multiremi/contracts";
import { MESSAGING_INBOX_TYPES } from "@multiremi/messaging/outcomes.js";
import { INBOX_ROUTING, inboxRouteFor } from "@multiremi/store/inbox-routing.js";

/**
 * Files that choose their Inbox type from a table instead of writing a literal
 * at the call site. Each one exports the full set of types it can write, which
 * the test below checks exactly — a stronger guarantee than the regex scan,
 * which simply cannot see through the indirection.
 */
const TABLE_DRIVEN_TYPES: Record<string, readonly string[]> = {
  "messaging/outcomes.ts": MESSAGING_INBOX_TYPES,
};

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

  it("keeps the server registry aligned with the shared frontend routing contract", () => {
    expect(Object.keys(INBOX_ROUTING).sort()).toEqual(Object.keys(INBOX_ROUTE_BY_TYPE).sort());
    for (const [type, route] of Object.entries(INBOX_ROUTE_BY_TYPE)) {
      expect(INBOX_ROUTING[type]?.route).toBe(route);
    }
  });

  it("registers every createInboxItem call site type", () => {
    const sourceRoot = resolve(import.meta.dir, "../../../packages/server/src");
    const files = [...new Bun.Glob("**/*.ts").scanSync({ cwd: sourceRoot, absolute: true })];
    const calls: Array<{ file: string; type: string; severity?: string }> = [];
    let invocationCount = 0;

    for (const file of files) {
      const relative = file.slice(sourceRoot.length + 1);
      if (TABLE_DRIVEN_TYPES[relative]) continue;
      const source = readFileSync(file, "utf8");
      invocationCount += [...source.matchAll(/\.createInboxItem\s*\(/g)].length;
      for (const match of source.matchAll(/\.createInboxItem\s*\(\s*\{([\s\S]*?)\n\s*\}\);/g)) {
        const type = match[1]?.match(/\btype:\s*"([^"]+)"/)?.[1];
        const severity = match[1]?.match(/\bseverity:\s*"([^"]+)"/)?.[1];
        expect(type, `${file} has a createInboxItem call without a literal type`).toBeDefined();
        if (type) calls.push({ file, type, severity });
      }
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(invocationCount);
    for (const call of calls) {
      expect(INBOX_ROUTING, `${call.file}: ${call.type} is missing from INBOX_ROUTING`)
        .toHaveProperty(call.type);
      if (call.severity) {
        expect(call.severity, `${call.file}: ${call.type} overrides the registered severity`)
          .toBe(INBOX_ROUTING[call.type]?.severity);
      }
    }
  });

  it("registers every Inbox type a table-driven writer can produce", () => {
    for (const [file, types] of Object.entries(TABLE_DRIVEN_TYPES)) {
      expect(types.length).toBeGreaterThan(0);
      for (const type of types) {
        expect(INBOX_ROUTING, `${file}: ${type} is missing from INBOX_ROUTING`).toHaveProperty(type);
      }
    }
  });
});
