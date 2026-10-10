import { describe, expect, it } from "vitest";
import type { IssueActivityEntry } from "@multiremi/contracts";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { activityTrails, groupEvents, isDuplicateAssignment, placeActivities, splitActivity } from "./issue-activity-presentation";

const time = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString();
const row = (seq: number, n: number, kind = "message", metadata: Record<string, unknown> = {}) => SessionLogEntrySchema.parse({
  session_id: "s", seq, id: `row-${seq}`, revision: 1, kind, body_md: "Task", body_html: null,
  render_version: "v", author_type: kind === "message" ? "member" : "system", author_id: kind === "message" ? "u" : null,
  created_at: time(n), metadata,
});
const activity = (id: string, n: number, action = "issue_created", details: Record<string, unknown> = {}): IssueActivityEntry => ({
  type: "activity", id, created_at: time(n), action, actor_type: "member", actor_id: "u", details,
});

describe("Issue activity placement and groups", () => {
  it("places ties after all same-time log rows and breaks activity ties by id", () => {
    expect(placeActivities([row(0, 0, "head"), row(1, 1), row(2, 1), row(3, 3)], [activity("z", 1), activity("a", 1)], false)
      .map(event => event.entry.id)).toEqual(["row-0", "row-1", "row-2", "a", "z", "row-3"]);
  });
  it("handles empty windows and activities before the first row or after a tail", () => {
    expect(placeActivities([], [activity("a", 1)], false).map(e => e.entry.id)).toEqual(["a"]);
    expect(placeActivities([row(0, 5, "head"), row(1, 10)], [activity("a", 1), activity("b", 20)], false)
      .map(e => e.entry.id)).toEqual(["row-0", "a", "row-1", "b"]);
  });
  it.each([1, 2, 3])("uses threshold three for %i different activities", count => {
    const events = placeActivities([row(0, 0, "head")], Array.from({ length: count }, (_, n) => activity(`a${n}`, n + 1, n === 0 ? "issue_created" : n === 1 ? "label_attached" : "label_detached")), false);
    const group = activityTrails(groupEvents(events)).trailers.get("row-0")![0]!;
    expect(group.events).toHaveLength(count);
    expect(group.collapsible).toBe(count >= 3);
  });
  it("filters first, while visible system activities and comments break the folding run", () => {
    const rows = [row(0, 0, "head"), row(1, 4), row(2, 7, "system")];
    const activities = [activity("a", 1), activity("b", 2, "decision_requested"), activity("c", 3, "label_attached"), activity("d", 5), activity("e", 8, "label_detached")];
    const hidden = activityTrails(groupEvents(placeActivities(rows, activities, false)));
    expect(hidden.trailers.get("row-0")![0]!.events.map(e => e.entry.id)).toEqual(["a", "c"]);
    expect(hidden.trailers.get("row-1")![0]!.events.map(e => e.entry.id)).toEqual(["d", "e"]);
    const shown = activityTrails(groupEvents(placeActivities(rows, activities, true)));
    expect(shown.trailers.get("row-0")!.map(g => g.events.map(e => e.entry.id))).toEqual([["a"], ["b"], ["c"]]);
    expect(shown.trailers.get("row-2")![0]!.events[0]!.entry.id).toBe("e");
  });
  it("shares a three-member run with a delegation, without duplicating agent assignment", () => {
    const turn = row(1, 1, "turn", { assignee_agent_id: "a" });
    const events = placeActivities([row(0, 0, "head"), turn], [activity("assign", 1, "issue_assigned", { to_type: "agent", to_id: "a" }),
      activity("status", 2, "issue_updated", { status: "todo" }), activity("priority", 3, "issue_updated", { priority: "high" })], false);
    const view = activityTrails(groupEvents(events));
    expect(view.entries.map(e => e.id)).toEqual(["row-0"]);
    expect(view.trailers.get("row-0")![0]!.events.map(e => e.entry.id)).toEqual(["row-1", "status:status", "priority:priority"]);
    expect(view.trailers.get("row-0")![0]!.collapsible).toBe(true);
  });
  it("coalesces consecutive equal actions from one actor within two minutes and keeps the first id", () => {
    const events = placeActivities([row(0, 0, "head")], [activity("a", 1), activity("b", 2), activity("c", 123)], false);
    const group = activityTrails(groupEvents(events)).trailers.get("row-0")![0]!;
    expect(group.events.map(e => e.entry.id)).toEqual(["a", "c"]);
    expect(group.events[0]!.kind === "activity" && group.events[0]!.entry.coalesced_count).toBe(2);
  });
  it("does not coalesce activities across delegation rows or different actors", () => {
    const events = placeActivities([row(0, 0, "head"), row(1, 2, "turn")], [activity("a", 1), activity("b", 3), { ...activity("c", 4), actor_id: "other" }], false);
    expect(activityTrails(groupEvents(events)).trailers.get("row-0")![0]!.events).toHaveLength(4);
  });
  it("splits changed fields, keeps old rows without previous and drops position/metadata-only writes", () => {
    const input = activity("a", 1, "issue_updated", { status: "todo", priority: "high", startDate: "2026-10-05", previous: { status: "backlog", priority: "high", start_date: null } });
    expect(splitActivity(input).map(e => [e.id, e.details])).toEqual([
      ["a:status", { field: "status", from: "backlog", to: "todo" }], ["a:start_date", { field: "start_date", from: null, to: "2026-10-05" }],
    ]);
    expect(splitActivity(activity("old", 1, "issue_updated", { status: "todo", parent_id: null }))).toHaveLength(2);
    expect(splitActivity(activity("a", 1, "issue_updated", { position: 3, metadata: {}, archived_at: null }))).toEqual([]);
    expect(placeActivities([], [activity("a", 1, "comment_created"), activity("c", 3, "unknown")], true)).toEqual([]);
  });
  it("keeps workspace clearing as a conversation activity while hiding its platform message", () => {
    const cleared = activity("cleared", 2, "workspace_move_cleared", { field: "project", name: "Original project" });
    const message = { ...row(1, 2), sender_type: "platform", metadata: { type: "workspace_move_cleared" } };
    const events = placeActivities([row(0, 0, "head"), message], [cleared], false);
    expect(events.map(event => event.entry.id)).toEqual(["row-0", "cleared"]);
    expect(events[1]!.kind === "activity" && events[1]!.system).toBe(false);
    expect(events[1]!.entry).toMatchObject({ details: { field: "project", name: "Original project" } });
  });
  it("preserves every workspace clearing detail when consecutive records share an actor and action", () => {
    const activities = ["assignee", "project", "label", "label"].map((field, n) =>
      activity(`clear-${n}`, n + 1, "workspace_move_cleared", { field, name: `Name ${n}` }));
    const groups = activityTrails(groupEvents(placeActivities([row(0, 0, "head")], activities, false)));
    expect(groups.trailers.get("row-0")![0]!.events.map(event => event.entry.id)).toEqual(activities.map(a => a.id));
  });
});

describe("assignment deduplication (A4)", () => {
  const assigned = activity("a", 10, "issue_assigned", { to_type: "agent", to_id: "a" });
  it("matches the same actor/agent within ten seconds, and ignores the actor for a system turn", () => {
    const turn = { ...row(1, 20, "turn", { assignee_agent_id: "a" }), author_type: "member", author_id: "u" };
    expect(isDuplicateAssignment(assigned, [turn])).toBe(true);
    expect(isDuplicateAssignment(assigned, [{ ...turn, author_id: "other" }])).toBe(false);
    expect(isDuplicateAssignment(assigned, [{ ...turn, author_type: "system", author_id: null }])).toBe(true);
    expect(isDuplicateAssignment(assigned, [{ ...turn, metadata: { assignee_agent_id: "other" } }])).toBe(false);
  });
  it("retains assignment beyond ten seconds, without a matching turn, or to a member", () => {
    expect(isDuplicateAssignment(assigned, [row(1, 20.001, "turn", { assignee_agent_id: "a" })])).toBe(false);
    expect(isDuplicateAssignment(assigned, [])).toBe(false);
    expect(isDuplicateAssignment({ ...assigned, details: { to_type: "member", to_id: "a" } }, [row(1, 10, "turn", { assignee_agent_id: "a" })])).toBe(false);
    expect(isDuplicateAssignment({ ...assigned, action: "issue_unassigned" }, [row(1, 10, "turn", { assignee_agent_id: "a" })])).toBe(false);
  });
});
