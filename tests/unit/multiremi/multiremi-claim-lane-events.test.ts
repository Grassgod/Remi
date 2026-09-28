import { afterEach, describe, expect, it } from "bun:test";
import { StoreContext } from "@multiremi/store/context.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("stale Issue lane claim events on SQLite", () => {
  function setup() {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ name: "Lane worker", provider: "claude" });
    const agent = store.createAgent({ name: "Lane agent", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Stale lane" });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const task = store.createSessionTask(session.id, { agentId: agent.id, prompt: "Claim stale lane" });
    store.getOrCreateSessionAgentLane(session.id, agent.id);
    db!.run(
      `UPDATE multiremi_session_agent_lanes SET provider_session_id = 'expired',
       provider = 'claude', runtime_id = ?, cursor_seq = 1,
       execution_fingerprint = 'expired' WHERE session_id = ? AND agent_id = ?`,
      [runtime.id, session.id, agent.id],
    );
    return { store, runtime, issue, task };
  }

  it("publishes the lane reset exactly once after claim commits", () => {
    const { store, runtime, issue, task } = setup();
    const events: boolean[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "session_agent_lane_reset") {
        events.push(db!.inTransaction);
      }
    });
    try {
      expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    } finally {
      unsubscribe();
    }
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "session_agent_lane_reset")).toHaveLength(1);
    expect(events).toEqual([false]);
  });

  it("drops the lane reset event and row when claim rolls back", () => {
    const { store, runtime, issue, task } = setup();
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type === "activity:created" && (event.payload.entry as { action?: string })?.action === "session_agent_lane_reset") {
        events.push(event.type);
      }
    });
    const original = StoreContext.prototype.appendIssueActivity;
    StoreContext.prototype.appendIssueActivity = function patched(this: StoreContext, issueId, input, queue) {
      original.call(this, issueId, input, queue);
      if (input.type === "session_agent_lane_reset") throw new Error("claim rollback injection");
    };
    try {
      expect(() => store.claimTask(runtime.id)).toThrow("claim rollback injection");
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribe();
    }
    expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === "session_agent_lane_reset")).toHaveLength(0);
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(events).toEqual([]);
  });
});

describe("optional activity callers in transaction owners on SQLite", () => {
  for (const path of ["held parent", "assign unassign", "update unassign"] as const) {
    function setup() {
      const store = createStore();
      store.ensureLocalWorkspace();
      const agent = store.createAgent({ name: `Owner ${path}`, provider: "claude" });
      const issue = store.createIssue({
        title: `Audit ${path}`,
        assigneeType: "agent",
        assigneeId: agent.id,
        status: "in_progress",
      });
      let taskId: string | null = null;
      if (path === "held parent") {
        store.createIssue({ title: "Open child", parentIssueId: issue.id, status: "in_progress" });
      } else {
        taskId = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Queued work" }).id;
      }
      const run = () => path === "held parent"
        ? store.updateIssue(issue.id, { status: "done" }, { holdParentStatus: true })
        : path === "assign unassign"
          ? store.assignIssue(issue.id, { assigneeType: null, assigneeId: null })
          : store.updateIssue(issue.id, { assigneeType: null, assigneeId: null });
      const action = path === "held parent" ? "parent_status_held" : "issue_unassigned";
      return { store, issue, taskId, run, action };
    }

    it(`${path}: publishes activity after commit`, () => {
      const { store, issue, run, action } = setup();
      const events: Array<{ action: string; inTransaction: boolean }> = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created") events.push({
          action: (event.payload.entry as { action: string }).action,
          inTransaction: db!.inTransaction,
        });
      });
      try {
        run();
      } finally {
        unsubscribe();
      }
      expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === action)).toHaveLength(1);
      expect(events.filter((event) => event.action === action)).toEqual([{ action, inTransaction: false }]);
      expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
    });

    it(`${path}: drops activity on rollback`, () => {
      const { store, issue, taskId, run, action } = setup();
      const events: string[] = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created") events.push((event.payload.entry as { action: string }).action);
      });
      const original = StoreContext.prototype.appendIssueActivity;
      StoreContext.prototype.appendIssueActivity = function patched(this: StoreContext, issueId, input, queue) {
        original.call(this, issueId, input, queue);
        if (input.type === action) throw new Error("activity rollback injection");
      };
      try {
        expect(run).toThrow("activity rollback injection");
      } finally {
        StoreContext.prototype.appendIssueActivity = original;
        unsubscribe();
      }
      expect(store.listIssueActivity(issue.id).filter((entry) => entry.type === action)).toHaveLength(0);
      if (taskId) expect(store.getTask(taskId)?.status).toBe("queued");
      expect(events).toEqual([]);
    });
  }
});
