// Sibling test for packages/server/src/store/context.ts — proves the StoreContext
// is wired to the same state the MultiremiStore
// facade exposes (listener Sets, analytics buffers) and that its lazy host
// getter resolves back into the store for cross-domain lookups.
import { expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import { StoreContext } from "@multiremi/store/context.js";
import { AnalyticsRepo } from "@multiremi/store/repos/analytics-repo.js";
import { pendingTurnBackendTests } from "./pending-turn-test-backends.js";

pendingTurnBackendTests("StoreContext wiring", (fixture) => {
let db: ReturnType<typeof fixture>["db"];

function createStore(): MultiremiStore {
  db = fixture().db;
  return fixture().store;
}

  it("routes facade-registered workspace listeners through the context", () => {
    const store = createStore();
    const seen: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      seen.push(event.type);
    });

    store.emitWorkspaceEvent({ type: "test:event", workspaceId: "local", payload: {} });
    expect(seen).toEqual(["test:event"]);

    unsubscribe();
    store.emitWorkspaceEvent({ type: "test:event", workspaceId: "local", payload: {} });
    expect(seen).toEqual(["test:event"]);
  });

  it("fires task-enqueued listeners registered on the facade", () => {
    const store = createStore();
    const enqueued: string[] = [];
    const unsubscribe = store.onTaskEnqueued((task) => {
      enqueued.push(task.id);
    });

    const agent = store.createAgent({ name: "Ctx worker", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "hello" });
    expect(enqueued).toEqual([task.id]);

    unsubscribe();
    store.createTask({ agentId: agent.id, prompt: "again" });
    expect(enqueued).toEqual([task.id]);
  });

  it("fires task-event listeners registered on the facade", () => {
    const store = createStore();
    const events: string[] = [];
    store.onTaskEvent((event) => {
      events.push(event.type);
    });

    const agent = store.createAgent({ name: "Ctx runner", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "run" });
    store.cancelTask(task.id);
    expect(events).toContain("task:cancelled");
  });

  it("writes analytics events and metric counters the facade reads back", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ name: "ctx-runtime", provider: "claude" });
    expect(runtime.id).toBeTruthy();

    const events = store.listAnalyticsEvents({ name: "runtime_registered" });
    expect(events.length).toBe(1);
    expect(events[0]!.name).toBe("runtime_registered");

    const counters = store.listMetricCounters({ name: "multiremi_runtime_registered_total" });
    expect(counters.length).toBe(1);
    expect(counters[0]!.value).toBe(1);
  });

  it("appends issue activity and broadcasts activity:created from the context", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Ctx issue", workspaceId: "local" });
    const broadcasts: string[] = [];
    store.onWorkspaceEvent((event) => {
      broadcasts.push(event.type);
    });

    store.updateIssue(issue.id, { status: "in_progress" });

    expect(store.listIssueActivity(issue.id).some((entry) => entry.type === "issue_updated")).toBe(true);
    expect(broadcasts).toContain("activity:created");
  });

  it("names the missing wiring when analytics() is reached on a hand-built context", () => {
    const store = createStore();
    // The analytics recorders are the one surface `resolveHost` cannot reach, so a context built
    // outside the MultiremiStore constructor only fails at call time — the message has to say why.
    const bare = new StoreContext(db!, () => store);
    expect(() => bare.analytics()).toThrow("registerAnalytics");

    bare.registerAnalytics(new AnalyticsRepo(bare));
    expect(bare.analytics()).toBeInstanceOf(AnalyticsRepo);
  });

  it("resolves the lazy host for cross-domain inbox creation", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const member = store.listWorkspaceMembers("local")[0]!;
    const issue = store.createIssue({ title: "Assign me", workspaceId: "local" });

    store.assignIssue(issue.id, { assigneeType: "member", assigneeId: member.id });

    const inbox = store.listInboxItems(member.id);
    expect(inbox.some((item) => item.type === "issue_assigned" && item.issueId === issue.id)).toBe(true);
  });

  it("routes to the triggering Issue Session before the default and rejects sessions outside the current workspace or Issue", () => {
    const store = createStore();
    const issue = store.createIssue({ title: "Notification routing" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { title: "Triggering comment" });
    const foreignWorkspace = store.createWorkspace({ name: "Foreign", slug: "foreign" });
    const foreignIssue = store.createIssue({ title: "Foreign issue", workspaceId: foreignWorkspace.id });
    const foreign = store.getOrCreateDefaultIssueSession(foreignIssue.id);
    const otherIssue = store.createIssue({ title: "Other local issue" });
    const other = store.getOrCreateDefaultIssueSession(otherIssue.id);
    const ctx = new StoreContext(db, () => store);
    for (const [trigger, expected] of [[side.id, side.id], [foreign.id, main.id], [other.id, main.id], ["ises_missing", main.id]]) {
      const item = ctx.createInboxItem({ issueId: issue.id, memberId: "mem_local_local", type: "comment_mention",
        title: "Mention", details: { issue_session_id: trigger } })!;
      expect(store.getMessage(item.id)?.session_id).toBe(expected);
    }
  });
});
