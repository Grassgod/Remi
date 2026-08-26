import { describe, it, expect } from "vitest";
import type { TimelineEntry } from "@multiremi/core/types";
import { formatActivity, priorityLabel, statusLabel, type IssuesT } from "./format-activity";

/**
 * `t` is only ever called as `t($ => $.<namespace>.<key>, params?)`, so a
 * two-level proxy is enough to report which locale key the formatter picked
 * and which interpolations it threaded through.
 */
const keyProxy = new Proxy(
  {},
  {
    get: (_target, ns: string) =>
      new Proxy({}, { get: (_t, key: string) => `${ns}.${key}` }),
  },
);

const t = ((selector: (dict: unknown) => string, params?: Record<string, unknown>) => {
  const key = selector(keyProxy);
  return params ? `${key} ${JSON.stringify(params)}` : key;
}) as unknown as IssuesT;

function activity(action: string, over: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    type: "activity",
    id: "a1",
    actor_type: "member",
    actor_id: "user-1",
    action,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("statusLabel / priorityLabel", () => {
  it("localizes known values", () => {
    expect(statusLabel("done", t)).toBe("status.done");
    expect(priorityLabel("high", t)).toBe("priority.high");
  });

  it("passes an unknown value through untranslated", () => {
    expect(statusLabel("teleported", t)).toBe("teleported");
    expect(priorityLabel("screaming", t)).toBe("screaming");
  });
});

describe("formatActivity", () => {
  it("renders a status change with both localized ends", () => {
    expect(
      formatActivity(activity("status_changed", { details: { from: "todo", to: "done" } }), t),
    ).toBe('activity.status_changed {"from":"status.todo","to":"status.done"}');
  });

  it("falls back to ? for a missing end of a priority change", () => {
    expect(
      formatActivity(activity("priority_changed", { details: { to: "high" } }), t),
    ).toBe('activity.priority_changed {"from":"?","to":"priority.high"}');
  });

  it("formats Luna title rename audit activities", () => {
    expect(
      formatActivity(activity("title_renamed", {
        details: { from: "Remi", to: "实现 Issue 自动命名" },
      }), t),
    ).toBe('activity.title_renamed {"from":"Remi","to":"实现 Issue 自动命名"}');
  });

  it("detects a self-assign", () => {
    expect(
      formatActivity(
        activity("assignee_changed", {
          details: { to_type: "member", to_id: "user-1" },
        }),
        t,
      ),
    ).toBe("activity.self_assigned");
  });

  it("names the new assignee when a resolver is supplied", () => {
    expect(
      formatActivity(
        activity("assignee_changed", { details: { to_type: "agent", to_id: "agent-9" } }),
        t,
        () => "Zhouzhou",
      ),
    ).toBe('activity.assigned_to {"name":"Zhouzhou"}');
  });

  it("reports assignee removal when the target is cleared", () => {
    expect(
      formatActivity(
        activity("assignee_changed", { details: { from_id: "user-2" } }),
        t,
        () => "unused",
      ),
    ).toBe("activity.removed_assignee");
  });

  it("degrades to a generic assignee change when nothing resolves", () => {
    expect(
      formatActivity(activity("assignee_changed", { details: {} }), t),
    ).toBe("activity.changed_assignee");
  });

  it("formats date changes and their removals", () => {
    expect(
      formatActivity(activity("due_date_changed", { details: { to: "2026-06-01" } }), t),
    ).toBe('activity.due_date_set {"date":"Jun 1"}');
    expect(formatActivity(activity("due_date_changed", { details: {} }), t)).toBe(
      "activity.due_date_removed",
    );
    expect(
      formatActivity(activity("start_date_changed", { details: { to: "2026-06-01" } }), t),
    ).toBe('activity.start_date_set {"date":"Jun 1"}');
    expect(formatActivity(activity("start_date_changed", { details: {} }), t)).toBe(
      "activity.start_date_removed",
    );
  });

  it("carries the coalesced run count into task outcomes", () => {
    expect(
      formatActivity(activity("task_completed", { coalesced_count: 3 }), t),
    ).toBe('activity.task_completed {"count":3}');
    expect(formatActivity(activity("task_failed"), t)).toBe(
      'activity.task_failed {"count":1}',
    );
  });

  it("keeps the squad leader's reason when it has one", () => {
    expect(
      formatActivity(
        activity("squad_leader_evaluated", {
          details: { outcome: "action", reason: "  needs a rerun  " },
        }),
        t,
      ),
    ).toBe('activity.squad_leader_action_reason {"reason":"needs a rerun"}');
    expect(
      formatActivity(
        activity("squad_leader_evaluated", { details: { outcome: "no_action" } }),
        t,
      ),
    ).toBe("activity.squad_leader_no_action");
    expect(
      formatActivity(
        activity("squad_leader_evaluated", { details: { outcome: "failed" } }),
        t,
      ),
    ).toBe("activity.squad_leader_failed");
    expect(
      formatActivity(activity("squad_leader_evaluated", { details: {} }), t),
    ).toBe("activity.squad_leader_evaluated");
  });

  it("explains a skipped dispatch, with the specific no-runnable-agent variant", () => {
    expect(
      formatActivity(
        activity("dispatch_skipped", { details: { reason: "no_runnable_agent", error: "No runnable agent for squad: sqd_1" } }),
        t,
      ),
    ).toBe("activity.dispatch_skipped_no_runnable_agent");
    expect(
      formatActivity(
        activity("dispatch_skipped", { details: { reason: "assign_failed", error: "Squad is archived: sqd_1" } }),
        t,
      ),
    ).toBe('activity.dispatch_skipped_reason {"reason":"Squad is archived: sqd_1"}');
    expect(formatActivity(activity("dispatch_skipped", { details: {} }), t)).toBe(
      "activity.dispatch_skipped",
    );
  });

  it("echoes an unknown action instead of rendering a missing key", () => {
    expect(formatActivity(activity("teleported"), t)).toBe("teleported");
    expect(formatActivity(activity(undefined as unknown as string), t)).toBe("");
  });
});
