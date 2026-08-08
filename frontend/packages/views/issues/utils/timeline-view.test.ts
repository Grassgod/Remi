import { describe, it, expect } from "vitest";
import type { TimelineEntry } from "@multiremi/core/types";
import {
  buildTimelineView,
  flattenGroups,
  lastActivityGroupId,
} from "./timeline-view";

function comment(id: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: "comment",
    id,
    actor_type: "member",
    actor_id: "user-1",
    content: `body of ${id}`,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function activity(
  id: string,
  action: string,
  over: Partial<TimelineEntry> = {},
): TimelineEntry {
  return {
    type: "activity",
    id,
    actor_type: "member",
    actor_id: "user-1",
    action,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("buildTimelineView", () => {
  it("describes a reply's parent and marks the parent as answered", () => {
    const view = buildTimelineView([
      comment("c1", { content: "the question" }),
      comment("c2", { parent_id: "c1" }),
    ]);

    expect(view.parentRefs.get("c2")).toEqual({
      id: "c1",
      actorType: "member",
      actorId: "user-1",
      preview: "the question",
    });
    expect(view.parentIds.has("c1")).toBe(true);
    expect(view.parentIds.has("c2")).toBe(false);
  });

  it("renders a reply chip-less when its parent is outside the window", () => {
    const view = buildTimelineView([comment("c2", { parent_id: "missing" })]);
    expect(view.parentRefs.size).toBe(0);
    expect(view.parentIds.size).toBe(0);
  });

  it("coalesces same-actor same-action activities inside the 2-minute window", () => {
    const view = buildTimelineView([
      activity("a1", "status_changed", { created_at: "2026-01-01T00:00:00Z" }),
      activity("a2", "status_changed", { created_at: "2026-01-01T00:01:00Z" }),
    ]);

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]!.entries).toHaveLength(1);
    expect(view.groups[0]!.entries[0]!.coalesced_count).toBe(2);
  });

  it("keeps activities apart once they fall outside the window", () => {
    const view = buildTimelineView([
      activity("a1", "status_changed", { created_at: "2026-01-01T00:00:00Z" }),
      activity("a2", "status_changed", { created_at: "2026-01-01T00:05:00Z" }),
    ]);

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]!.entries).toHaveLength(2);
  });

  it("coalesces task_completed regardless of how far apart the runs are", () => {
    const view = buildTimelineView([
      activity("a1", "task_completed", { created_at: "2026-01-01T00:00:00Z" }),
      activity("a2", "task_completed", { created_at: "2026-03-01T00:00:00Z" }),
    ]);

    expect(view.groups[0]!.entries[0]!.coalesced_count).toBe(2);
  });

  it("never coalesces squad_leader_evaluated — outcome/reason are audit data", () => {
    const view = buildTimelineView([
      activity("a1", "squad_leader_evaluated"),
      activity("a2", "squad_leader_evaluated"),
    ]);

    expect(view.groups[0]!.entries).toHaveLength(2);
  });

  it("does not coalesce across different actors", () => {
    const view = buildTimelineView([
      activity("a1", "status_changed"),
      activity("a2", "status_changed", { actor_id: "user-2" }),
    ]);

    expect(view.groups[0]!.entries).toHaveLength(2);
  });

  it("groups consecutive activities and keeps each comment on its own", () => {
    const view = buildTimelineView([
      activity("a1", "created"),
      activity("a2", "title_changed"),
      comment("c1"),
      activity("a3", "status_changed"),
    ]);

    expect(view.groups.map((g) => g.type)).toEqual([
      "activities",
      "comment",
      "activities",
    ]);
    expect(view.groups[0]!.entries.map((e) => e.id)).toEqual(["a1", "a2"]);
  });
});

describe("flattenGroups", () => {
  it("projects a resolved comment as a bar until it is expanded", () => {
    const groups = buildTimelineView([
      comment("c1", { resolved_at: "2026-01-02T00:00:00Z" }),
    ]).groups;

    expect(flattenGroups(groups, new Set())[0]!.kind).toBe("resolved-bar");
    expect(flattenGroups(groups, new Set(["c1"]))[0]!.kind).toBe("comment");
  });

  it("keys an activity group on its first entry", () => {
    const groups = buildTimelineView([
      activity("a1", "created"),
      activity("a2", "title_changed"),
    ]).groups;

    const items = flattenGroups(groups, new Set());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "activity-group", id: "a1" });
  });
});

describe("lastActivityGroupId", () => {
  it("returns the id of the trailing activity block", () => {
    const groups = buildTimelineView([
      activity("a1", "created"),
      comment("c1"),
      activity("a2", "status_changed"),
      activity("a3", "title_changed"),
    ]).groups;

    expect(lastActivityGroupId(groups)).toBe("a2");
  });

  it("returns null when the timeline holds no activity", () => {
    const groups = buildTimelineView([comment("c1")]).groups;
    expect(lastActivityGroupId(groups)).toBeNull();
  });
});
