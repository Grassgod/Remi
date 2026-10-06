import { describe, expect, it, vi } from "vitest";
import { SessionLogEntrySchema } from "@multiremi/core/api/schemas/session-log";
import { buildLogRowModel, TrailSignatureCache } from "./log-row-model";
import type { ActivityGroup } from "./issue-activity-presentation";

const row = (seq: number, overrides = {}) => SessionLogEntrySchema.parse({ session_id: "s", seq, id: `r${seq}`, kind: "message",
  revision: 1, render_version: "v", body_md: "body", body_html: "<p>body</p>", author_type: "member", metadata: {}, ...overrides });

describe("Issue row model", () => {
  it("preserves complete output while indexing replies and replaced metadata", () => {
    const parent = row(1), reply = row(2, { parent_id: parent.id });
    const before = buildLogRowModel([parent, reply]);
    expect(before.rows).toEqual([parent, reply]);
    expect(before.parentsWithReplies.has(parent.id)).toBe(true);
    expect(before.byId.get(reply.parent_id!)).toEqual(parent);
    const revised = row(1, { revision: 2, body_md: "changed", metadata: { attachments: [{ id: "new" }], reactions: [{ emoji: "new" }] } });
    const after = buildLogRowModel([revised]);
    expect(after.byId.get(parent.id)).toEqual(revised);
    expect(after.parentsWithReplies.size).toBe(0);
    expect(before.byId.get(parent.id)).toEqual(parent);
  });
  it("reuses unchanged trail signatures and invalidates revision, choices, activities and session", () => {
    const cache = new TrailSignatureCache();
    const state = { expanded: true, showOlder: false, truncateOlder: true };
    const group: ActivityGroup = { id: "g", system: false, collapsible: false, events: [{ kind: "log", entry: row(1) }] };
    const first = cache.signature("s:r0", [group], () => state);
    const json = vi.spyOn(JSON, "stringify");
    expect(cache.signature("s:r0", [{ ...group, events: [...group.events] }], () => state)).toBe(first);
    expect(json).not.toHaveBeenCalled();
    state.expanded = false;
    expect(cache.signature("s:r0", [group], () => state)).not.toBe(first);
    const changed = { ...group, events: [{ kind: "log" as const, entry: row(1, { revision: 2 }) }] };
    expect(cache.signature("s:r0", [changed], () => state)).toContain('2');
    const activity: ActivityGroup = { ...group, events: [{ kind: "activity", system: false, entry: {
      type: "activity", id: "a", actor_type: "system", actor_id: "", created_at: "now", details: { status: "todo" }, coalesced_count: 2,
    } }] };
    expect(cache.signature("s:r0", [activity], () => state)).toContain('todo');
    cache.signature("other:r0", [activity], () => state);
    cache.retain(new Set());
    json.mockClear(); cache.signature("s:r0", [activity], () => state);
    expect(json).toHaveBeenCalledOnce();
    json.mockRestore();
  });
});
