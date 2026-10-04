import { describe, it, expect } from "vitest";
import type { TimelineEntry } from "@multiremi/core/types";
import { createI18n } from "@multiremi/core/i18n/react";
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

  it.each(["assignee", "project", "label"])("renders workspace move clearing for %s using only the stored name", (field) => {
    expect(formatActivity(activity("workspace_move_cleared", { details: { field, name: "Original name" } }), t,
      () => { throw new Error("Clearing activity must not resolve source IDs"); }))
      .toBe(`activity.workspace_move_cleared_${field} {"name":"Original name"}`);
  });

  it("handles missing names and unknown clearing fields", () => {
    expect(formatActivity(activity("workspace_move_cleared", { details: { field: "label" } }), t))
      .toBe('activity.workspace_move_cleared_label {"name":"?"}');
    expect(formatActivity(activity("workspace_move_cleared", { details: { field: "future" } }), t))
      .toBe("activity.workspace_move_cleared");
  });

  it("ships workspace move clearing copy in all supported locales", async () => {
    const bundles = await Promise.all([
      import("../../locales/zh-Hans/issues.json"), import("../../locales/en/issues.json"),
      import("../../locales/ja/issues.json"), import("../../locales/ko/issues.json"),
    ]);
    for (const bundle of bundles) {
      const copy = bundle.default.activity as Record<string, string>;
      expect(copy.workspace_move_cleared).toBeTruthy();
      for (const field of ["assignee", "project", "label"]) expect(copy[`workspace_move_cleared_${field}`]).toContain("{{name}}");
    }
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

  it("explains delegation returns and skipped return reasons", () => {
    expect(formatActivity(activity("delegation_return_triggered"), t)).toBe(
      "activity.delegation_return_triggered",
    );
    expect(formatActivity(activity("delegation_return_triggered", {
      details: { sourceIssueId: "child", sourceIssueKey: "MUL-456", returnIssueId: "parent" },
    }), t)).toBe('activity.delegation_return_triggered_cross_issue {"key":"MUL-456"}');
    expect(
      formatActivity(
        activity("delegation_return_skipped", { details: { reason: "already_covered" } }),
        t,
      ),
    ).toBe(
      'activity.delegation_return_skipped {"reason":"activity.delegation_return_reason_already_covered"}',
    );
    for (const reason of [
      "coalesced_into_pending_return",
      "covered_by_queued_task",
      "deferred_lane_busy",
      "source_not_issue_task",
      "source_side_session",
      "source_not_squad_leader",
      "target_not_squad_member",
      "cross_issue_no_lineage",
      "self_dispatch",
      "covered_by_delegate_wakeup",
      "delegator_issue_closed",
      "delegator_session_missing",
    ]) {
      expect(
        formatActivity(activity("delegation_return_skipped", { details: { reason } }), t),
      ).toBe(
        `activity.delegation_return_skipped {"reason":"activity.delegation_return_reason_${reason}"}`,
      );
    }
    expect(
      formatActivity(
        activity("delegation_return_skipped", { details: { reason: "new_reason" } }),
        t,
      ),
    ).toBe('activity.delegation_return_skipped {"reason":"new_reason"}');
  });

  it.each([
    {
      locale: "zh-Hans",
      load: () => import("../../locales/zh-Hans/issues.json"),
      limited: "Leader 与 QA 的自动来回已达 5 次上限，已停止自动派活，等人介入",
      mention: "未派发 agent 提及：双方 agent 的自动来回已达上限",
      skipped: "未触发委派回程：目标任务没有 Issue",
    },
    {
      locale: "en",
      load: () => import("../../locales/en/issues.json"),
      limited: "stopped automatic dispatch between Leader and QA at the 5 round-trip limit; waiting for a person",
      mention: "did not dispatch the agent mention: the agent pair reached its automatic round-trip limit",
      skipped: "did not queue a delegation return: the target task has no issue",
    },
    {
      locale: "ja",
      load: () => import("../../locales/ja/issues.json"),
      limited: "Leader と QA の自動往復が上限 5 回に達したため停止し、人の介入を待っています",
      mention: "agent メンションをディスパッチしませんでした: agent 間の自動往復が上限に達しました",
      skipped: "委任元への通知を行いませんでした: 対象タスクに Issue がありません",
    },
    {
      locale: "ko",
      load: () => import("../../locales/ko/issues.json"),
      limited: "Leader와 QA의 자동 왕복이 5회 한도에 도달해 중단하고 사람의 개입을 기다립니다",
      mention: "agent 멘션을 디스패치하지 않았습니다: agent 간 자동 왕복 한도에 도달했습니다",
      skipped: "위임 반환을 대기열에 넣지 않았습니다: 대상 작업에 Issue가 없습니다",
    },
  ] as const)("renders the round-trip limit and new reasons in $locale", async ({ locale, load, limited, mention, skipped }) => {
    const bundle = (await load()).default;
    const i18n = createI18n(locale, { [locale]: { issues: bundle } });
    const localizedT = i18n.getFixedT(locale, "issues") as IssuesT;
    expect(formatActivity(activity("delegation_round_trip_limited", {
      details: { sourceAgentName: "Leader", sourceAgentId: "agt_leader",
        targetAgentName: "QA", targetAgentId: "agt_qa", limit: 5 },
    }), localizedT)).toBe(limited);
    expect(formatActivity(activity("comment_mention_skipped", {
      details: { reason: "pair_round_trip_limit" },
    }), localizedT)).toBe(mention);
    expect(formatActivity(activity("delegation_return_skipped", {
      details: { reason: "target_not_issue_task" },
    }), localizedT)).toBe(skipped);
  });

  it("explains child-done parent wakeups and skipped reasons", () => {
    expect(formatActivity(activity("child_done_parent_triggered"), t)).toBe(
      "activity.child_done_parent_triggered",
    );
    // MUL-400 E2 retired `active_task_exists`: a busy owner coalesces the report
    // into its queued round instead of skipping the wakeup.
    const reasons = {
      no_assignee: "no_assignee",
      agent_unavailable: "agent_unavailable",
      squad_leader_unavailable: "squad_leader_unavailable",
    };
    for (const [reason, key] of Object.entries(reasons)) {
      expect(
        formatActivity(activity("child_done_parent_skipped", { details: { reason } }), t),
      ).toBe(
        `activity.child_done_parent_skipped {"reason":"activity.child_done_parent_reason_${key}"}`,
      );
    }
    expect(
      formatActivity(
        activity("child_done_parent_skipped", { details: { reason: "future_reason" } }),
        t,
      ),
    ).toBe('activity.child_done_parent_skipped {"reason":"future_reason"}');

    // MUL-400 E1/E2 activities the parent and child pages now render.
    expect(formatActivity(activity("child_status_parent_coalesced"), t)).toBe(
      "activity.child_status_parent_coalesced",
    );
    expect(formatActivity(activity("parent_status_derived"), t)).toBe(
      "activity.parent_status_derived",
    );
    expect(
      formatActivity(activity("parent_status_held", { details: { requested: "in_review" } }), t),
    ).toBe('activity.parent_status_held {"status":"status.in_review"}');
    expect(formatActivity(activity("parent_status_held", { details: { reason: "grant_missing", requested: "done" } }), t))
      .toBe('activity.parent_status_held_grant_missing {"status":"status.done"}');
    expect(formatActivity(activity("parent_status_held", { details: { reason: "final_summary_missing", requested: "done" } }), t))
      .toBe('activity.parent_status_held_final_summary_missing {"status":"status.done"}');
    expect(formatActivity(activity("parent_done_grant_created", { details: { agentId: "agt_owner" } }), t, () => "Owner"))
      .toBe('activity.parent_done_grant_created {"agent":"Owner"}');
    expect(formatActivity(activity("parent_done_grant_revoked"), t)).toBe("activity.parent_done_grant_revoked");
    expect(formatActivity(activity("parent_done_grant_used", { details: { source: "scm_merge" } }), t))
      .toBe('activity.parent_done_grant_used {"source":"activity.parent_done_grant_source_scm_merge"}');
    expect(
      formatActivity(activity("issue_status_forced", { details: { status: "done" } }), t),
    ).toBe('activity.issue_status_forced {"status":"status.done"}');
    // A child that ends after its parent was closed: activity only, and the
    // copy names both the child and its outcome.
    expect(
      formatActivity(
        activity("child_status_after_parent_closed", {
          details: { childIssueKey: "MUL-2", outcome: "failed" },
        }),
        t,
      ),
    ).toBe(
      'activity.child_status_after_parent_closed {"key":"MUL-2","outcome":"activity.child_outcome_failed"}',
    );
    expect(
      formatActivity(activity("child_status_after_parent_closed", { details: { outcome: "done" } }), t),
    ).toBe(
      'activity.child_status_after_parent_closed {"key":"?","outcome":"activity.child_outcome_done"}',
    );
  });

  it("explains why an agent comment mention was skipped", () => {
    expect(
      formatActivity(
        activity("comment_mention_skipped", { details: { reason: "target_unavailable" } }),
        t,
      ),
    ).toBe(
      'activity.comment_mention_skipped {"reason":"activity.comment_mention_reason_target_unavailable"}',
    );
    expect(formatActivity(activity("comment_mention_skipped", { details: {} }), t)).toBe(
      'activity.comment_mention_skipped {"reason":"activity.reason_unknown"}',
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
        activity("dispatch_skipped", { details: { reason: "member_assignee" } }),
        t,
      ),
    ).toBe("activity.dispatch_skipped_member_assignee");
    expect(
      formatActivity(
        activity("dispatch_skipped", { details: { reason: "no_assignee" } }),
        t,
      ),
    ).toBe("activity.dispatch_skipped_no_assignee");
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

/**
 * MUL-400 E3 (MUL-409): the dependency gate and automatic start introduced
 * these activity types. Each one has to map to its own locale key with the
 * right interpolation — a missing case would fall through to the raw action.
 */
describe("formatActivity — dependency activities", () => {
  it("renders an automatic start with the satisfying prerequisite key", () => {
    expect(
      formatActivity(activity("dependency_auto_started", { details: { satisfiedByKey: "MUL-7" } }), t),
    ).toBe('activity.dependency_auto_started {"key":"MUL-7"}');
  });

  it("renders a readiness report with the satisfying prerequisite key", () => {
    expect(
      formatActivity(activity("dependency_satisfied", { details: { satisfied_by_key: "MUL-8" } }), t),
    ).toBe('activity.dependency_satisfied {"key":"MUL-8"}');
  });

  it("renders a structural dependency exemption in all four locales", async () => {
    expect(formatActivity(activity("dependency_gate_exempted", { details: { source: "redispatch" } }), t))
      .toBe('activity.dependency_gate_exempted {"source":"activity.dependency_gate_exempted_redispatch"}');
    const bundles = await Promise.all([
      import("../../locales/zh-Hans/issues.json"),
      import("../../locales/en/issues.json"),
      import("../../locales/ja/issues.json"),
      import("../../locales/ko/issues.json"),
    ]);
    for (const bundle of bundles) expect(bundle.default.activity.dependency_gate_exempted).toContain("{{source}}");
    expect(bundles[0]!.default.activity.dependency_gate_exempted).toContain("等待依赖");
    expect(bundles[0]!.default.activity.dependency_gate_exempted_retry).toBe("重试");
  });

  it("renders a skipped automatic start with the satisfying prerequisite key", () => {
    expect(
      formatActivity(activity("dependency_auto_start_skipped", { details: { satisfied_by_key: "MUL-9" } }), t),
    ).toBe('activity.dependency_auto_start_skipped {"key":"MUL-9"}');
  });

  /**
   * MUL-409 fix round 4 (QA round 3, suggestion 4): the record an operator sees
   * after a failed automatic start has to say what to DO. Fixing the owner and
   * assigning the issue again is the whole recovery — no forced start — and the
   * copy has to name that.
   */
  it("tells the operator how to recover from a skipped automatic start", async () => {
    const bundle = (await import("../../locales/zh-Hans/issues.json")).default as {
      activity: Record<string, string>;
    };
    const copy = bundle.activity.dependency_auto_start_skipped ?? "";
    expect(copy.startsWith("{{key}}")).toBe(true);
    expect(copy).toContain("负责人");
    expect(copy).toContain("指派");
    expect(copy).toContain("不需要强制开工");
  });

  it("renders a failed prerequisite with the dead prerequisite's key", () => {
    expect(
      formatActivity(activity("dependency_prerequisite_failed", { details: { prerequisite_key: "MUL-10" } }), t),
    ).toBe('activity.dependency_prerequisite_failed {"key":"MUL-10"}');
  });

  it("renders the waiting marker of a creation that parked in backlog", () => {
    expect(formatActivity(activity("dependency_waiting"), t)).toBe("activity.dependency_waiting");
  });

  it("renders each member force-start source", () => {
    expect(formatActivity(activity("dependency_force_started"), t)).toBe("activity.dependency_force_started");
    expect(formatActivity(activity("dependency_force_started", { details: { source: "comment" } }), t))
      .toBe("activity.dependency_force_started_comment");
    expect(formatActivity(activity("dependency_force_started", {
      details: { source: "mention", agent_id: "agt_qa" },
    }), t, (_type, id) => id === "agt_qa" ? "QA" : id))
      .toBe('activity.dependency_force_started_mention {"agent":"QA"}');
    expect(formatActivity(activity("dependency_force_started", { details: { source: "rerun" } }), t))
      .toBe("activity.dependency_force_started_rerun");
  });

  it("renders the dependency hold instead of the raw dispatch-skipped reason", () => {
    expect(
      formatActivity(activity("dispatch_skipped", { details: { reason: "dependencies_unmet" } }), t),
    ).toBe("activity.dependency_gate_reason_dependencies_unmet");
  });

  it("renders a readiness report folded into an already-queued round", () => {
    expect(formatActivity(activity("dependency_satisfied_coalesced"), t))
      .toBe("activity.dependency_satisfied_coalesced");
  });

  it("renders the dependency hold for a mention that could not dispatch", () => {
    // The outer copy names the skip; the reason resolves to the dependency hold
    // rather than leaking the raw "dependencies_unmet" string.
    expect(
      formatActivity(activity("comment_mention_skipped", { details: { reason: "dependencies_unmet" } }), t),
    ).toBe('activity.comment_mention_skipped {"reason":"activity.dependency_gate_reason_dependencies_unmet"}');
  });

  it("falls back to ? when the satisfying key is missing", () => {
    expect(formatActivity(activity("dependency_auto_started"), t)).toBe('activity.dependency_auto_started {"key":"?"}');
  });
});

describe("formatActivity — decision activities", () => {
  const actions = [
    "decision_requested",
    "decision_answered",
    "decision_received",
    "decision_escalated",
    "decision_reminder",
    "decision_card_skipped",
    "decision_card_queued",
    "decision_card_reminder",
    "decision_card_degraded",
  ] as const;

  it.each(actions)("localizes %s instead of exposing the raw action", (action) => {
    expect(formatActivity(activity(action), t)).toBe(`activity.${action}`);
  });

  it("ships copy for every decision activity in all four locales", async () => {
    const bundles = await Promise.all([
      import("../../locales/zh-Hans/issues.json"),
      import("../../locales/en/issues.json"),
      import("../../locales/ja/issues.json"),
      import("../../locales/ko/issues.json"),
    ]);
    for (const bundle of bundles) {
      const copy = bundle.default.activity as Record<string, string>;
      for (const action of actions) {
        expect(copy[action]).toBeTruthy();
        expect(copy[action]).not.toBe(action);
      }
    }
  });
});
