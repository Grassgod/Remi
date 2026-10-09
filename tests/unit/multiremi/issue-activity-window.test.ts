import { createResponsibleTestIssue } from './helpers.js';
import { afterEach, describe, expect, it } from "bun:test";
import { ISSUE_ACTIVITY_TYPES } from "@multiremi/contracts";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);
const time = (millisecond: number) => new Date(Date.UTC(2026, 0, 1) + millisecond).toISOString();
function insert(issueId: string, id: string, timestamp: string, type = "issue_updated") {
  db!.run("INSERT INTO multiremi_issue_activity (id, issue_id, actor_type, actor_id, type, body, data, created_at) VALUES (?, ?, 'system', NULL, ?, NULL, ?, ?)",
    [id, issueId, type, JSON.stringify({ status: "todo" }), timestamp]);
}

describe("Issue activity window (MUL-501 2a)", () => {
  it("tiles adjacent windows exactly once, including equal millisecond boundaries", async () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Tiled activity", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    db!.run("UPDATE multiremi_conversation_log SET created_at = ? WHERE session_id = ?", [time(0), session.id]);
    let seed = 501;
    const random = () => (seed = (seed * 16807) % 2147483647);
    let timestamp = 0;
    for (let i = 0; i < 80; i++) {
      timestamp += random() % 4;
      const row = store.appendConversationLog({ sessionId: session.id, kind: "message", authorType: "member", bodyMd: String(i) });
      db!.run("UPDATE multiremi_conversation_log SET created_at = ? WHERE id = ?", [time(timestamp), row.id]);
    }
    db!.run("DELETE FROM multiremi_issue_activity WHERE issue_id = ?", [issue.id]);
    const ids = Array.from({ length: 160 }, (_, index) => `act_test_${index}`);
    for (const id of ids) insert(issue.id, id, time((random() % (timestamp + 5)) - 2));
    const app = createMultiremiApp({ store });
    for (const size of [1, 3, 7, 30]) {
      const seen: string[] = [];
      let anchor = 0;
      let first = true;
      while (true) {
        const response = await app.request(`/api/sessions/${session.id}/log?with_activity=1&anchor=${anchor}&before=${first ? 1 : 0}&after=${size}`);
        expect(response.status).toBe(200);
        const window = await response.json();
        expect(window.activities_truncated).toBe(false);
        seen.push(...window.activities.map((a: { id: string }) => a.id));
        if (!window.has_more_after) break;
        anchor = window.entries.at(-1).seq;
        first = false;
      }
      expect(seen.length).toBe(ids.length);
      expect([...new Set(seen)].sort()).toEqual([...ids].sort());
    }
  });

  it("opts in only on the default Issue session and excludes comment and unknown audits", async () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Default only", workspaceId: "local" });
    const main = store.getOrCreateDefaultIssueSession(issue.id);
    const side = store.createIssueSession(issue.id, { title: "Side" });
    const agent = store.createAgent({ name: "Chat agent", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id, workspaceId: "local" });
    insert(issue.id, "act_comment", time(0), "comment_created");
    insert(issue.id, "act_future", time(0), "future_type");
    const app = createMultiremiApp({ store });
    for (const session of [side, chat]) {
      const window = await (await app.request(`/api/sessions/${session.id}/log?with_activity=1`)).json();
      expect(window.activities).toBeUndefined();
    }
    const plain = await (await app.request(`/api/sessions/${main.id}/log`)).json();
    expect(plain.activities).toBeUndefined();
    const window = await (await app.request(`/api/sessions/${main.id}/log?with_activity=1`)).json();
    expect(window.activities.some((a: { action: string }) => a.action === "issue_created")).toBe(true);
    expect(window.activities.some((a: { id: string }) => a.id === "act_comment" || a.id === "act_future")).toBe(false);
    expect(ISSUE_ACTIVITY_TYPES).not.toContain("comment_created");
    expect(ISSUE_ACTIVITY_TYPES).not.toContain("comment_updated");
    expect(ISSUE_ACTIVITY_TYPES).not.toContain("workspace_move_cleared");
  });

  it("caps a tail at its newest 200 activities, preserves label names and handles an empty log", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Capped", workspaceId: "local" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    db!.run("DELETE FROM multiremi_issue_activity WHERE issue_id = ?", [issue.id]);
    for (let i = 0; i < 205; i++) insert(issue.id, `act_${String(i).padStart(3, "0")}`, time(i));
    const result = store.listIssueActivityBetween(issue.id, { types: ISSUE_ACTIVITY_TYPES });
    expect(result.activities_truncated).toBe(true);
    expect(result.activities.map(a => a.id)).toEqual(Array.from({ length: 200 }, (_, i) => `act_${String(i + 5).padStart(3, "0")}`));
    expect(store.listIssueActivityBetween(issue.id, { types: [], limit: 200 }).activities).toEqual([]);
    db!.run("DELETE FROM multiremi_conversation_log WHERE session_id = ?", [session.id]);
    expect(store.conversationLogWindow(session.id).prev_entry_created_at).toBeNull();
    const label = store.createLabel({ workspaceId: "local", name: "QA label", color: "#00aa00" });
    store.attachLabelToIssue(issue.id, label.id);
    expect(store.listIssueActivityBetween(issue.id, { types: ["label_attached"] }).activities[0]?.details).toMatchObject({ body: "QA label", color: "#00aa00" });
  });

  it("records only changed old field values alongside the new update, including camel aliases", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Old title", workspaceId: "local", priority: "medium" });
    store.updateIssue(issue.id, { title: "New title", startDate: "2026-10-05", priority: "medium" });
    const row = store.listIssueActivity(issue.id).findLast(a => a.type === "issue_updated")!;
    expect(row.data).toMatchObject({ title: "New title", startDate: "2026-10-05", previous: { title: "Old title", start_date: null } });
    expect((row.data as { previous: object }).previous).not.toHaveProperty("priority");
    expect(store.listConversationLogEntries(store.getOrCreateDefaultIssueSession(issue.id).id).map(e => e.kind)).not.toContain("activity");
  });

  it("rolls back the field update and previous snapshot when audit insertion fails", () => {
    const store = createStore();
    const issue = createResponsibleTestIssue(store, { title: "Atomic audit", workspaceId: "local", priority: "medium" });
    db!.exec("CREATE TRIGGER reject_activity BEFORE INSERT ON multiremi_issue_activity WHEN NEW.type = 'issue_updated' BEGIN SELECT RAISE(ABORT, 'audit rejected'); END");
    expect(() => store.updateIssue(issue.id, { priority: "high" })).toThrow("audit rejected");
    expect(store.getIssue(issue.id)?.priority).toBe("medium");
    expect(store.listIssueActivity(issue.id).some(a => a.type === "issue_updated")).toBe(false);
  });
});
