// MUL-400 S2 (E3): sibling dependencies actually hold and release work.
//
// The dependency gate has three entry points (assign, status write, creation),
// the automatic start is driven by the prerequisite's own terminal write, and
// the failure path has to reach a human. These tests drive the real store and
// the real HTTP routes against an in-memory database; the Postgres end-to-end
// run lives in `reports/`.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

type Store = ReturnType<typeof createStore>;

function activityOf(store: Store, issueId: string, type: string): Array<{ body: string | null; data: Record<string, unknown> | null }> {
  return store.listIssueActivity(issueId)
    .filter((entry) => entry.type === type)
    .map((entry) => ({ body: entry.body, data: (entry.data ?? null) as Record<string, unknown> | null }));
}

function catchError(fn: () => unknown): Error & { code?: string; details?: Record<string, unknown> } {
  try {
    fn();
  } catch (err) {
    return err as Error & { code?: string; details?: Record<string, unknown> };
  }
  throw new Error("expected the call to throw");
}

/** A store with a runtime and one agent that can own work. */
function storeWithAgent(name = "Owner") {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({ id: `rt_${name}`, name, provider: "claude", maxConcurrency: 4 });
  const agent = store.createAgent({ name, provider: "claude", runtimeId: runtime.id });
  return { store, runtime, agent };
}

describe("MUL-400 E3 — dependency semantics", () => {
  it("stores one direction and reads both sides with a computed direction", () => {
    const store = createStore();
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });

    // `blocks` is a view of the reverse relation: A blocks B means B waits for A.
    store.createIssueDependency(a.id, { dependsOnIssueId: b.id, type: "blocks" });
    const stored = db!.query("SELECT issue_id, depends_on_issue_id, type FROM multiremi_issue_dependencies").all() as Array<Record<string, string>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.issue_id).toBe(b.id);
    expect(stored[0]!.depends_on_issue_id).toBe(a.id);
    expect(stored[0]!.type).toBe("blocked_by");

    const fromB = store.listIssueDependencies(b.id);
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.direction).toBe("blocked_by");
    expect(fromB[0]!.dependsOnIssueId).toBe(a.id);
    const fromA = store.listIssueDependencies(a.id);
    expect(fromA).toHaveLength(1);
    expect(fromA[0]!.direction).toBe("blocks");
    // The stored pair is the stored pair whichever side asks; only the
    // perspective-relative `direction` differs.
    expect(fromA[0]!.issueId).toBe(b.id);
    expect(fromA[0]!.dependsOnIssueId).toBe(a.id);
    expect(fromA[0]!.issue?.id).toBe(b.id);
    expect(fromA[0]!.dependsOnIssue?.id).toBe(a.id);

    // Keys and ids are both accepted.
    const c = store.createIssue({ title: "C" });
    store.createIssueDependency(c.id, { depends_on_issue_id: a.key, type: "blocked_by" });
    expect(store.listIssueDependencies(c.id)[0]!.dependsOnIssueId).toBe(a.id);
  });

  it("treats only done as satisfied and reports the unmet list", () => {
    const store = createStore();
    const prereq = store.createIssue({ title: "Prerequisite" });
    const dependent = store.createIssue({ title: "Dependent", status: "backlog" });
    store.createIssueDependency(dependent.id, { dependsOnIssueId: prereq.id, type: "blocked_by" });

    expect(store.listUnmetPrerequisites(dependent.id).map((row) => row.key)).toEqual([prereq.key]);
    for (const unmet of ["in_review", "blocked", "cancelled"]) {
      store.updateIssue(prereq.id, { status: unmet });
      expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
    }
    store.updateIssue(prereq.id, { status: "done" });
    expect(store.listUnmetPrerequisites(dependent.id)).toEqual([]);
    expect(store.getIssueWaitingOn(dependent.id)).toMatchObject({ unmet: [] });
    expect(store.getIssueWaitingOn(dependent.id).prerequisites).toHaveLength(1);
  });

  it("refuses a cycle with the key path and a dependency on an ancestor", () => {
    const store = createStore();
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });
    const c = store.createIssue({ title: "C" });
    store.createIssueDependency(b.id, { dependsOnIssueId: a.id, type: "blocked_by" });
    store.createIssueDependency(c.id, { dependsOnIssueId: b.id, type: "blocked_by" });

    // A would wait for C, and C already waits on A through B.
    const cycle = catchError(() => store.createIssueDependency(a.id, { dependsOnIssueId: c.id, type: "blocked_by" }));
    expect(cycle.code).toBe("dependency_cycle");
    expect(cycle.details?.path).toEqual([c.key, b.key, a.key]);

    const parent = store.createIssue({ title: "Parent" });
    const child = store.createIssue({ title: "Child", parentIssueId: parent.id });
    const ancestor = catchError(() => store.createIssueDependency(child.id, { dependsOnIssueId: parent.id, type: "blocked_by" }));
    expect(ancestor.code).toBe("dependency_on_ancestor");
    // Nearest ancestor first: the dependent, then the ancestor chain.
    expect(ancestor.details?.path).toEqual([child.key, parent.key]);
  });

  it("keeps a long chain from being reported as a cycle", () => {
    const store = createStore();
    const issues = Array.from({ length: 60 }, (_, index) => store.createIssue({ title: `Chain ${index}` }));
    for (let index = 1; index < issues.length; index++) {
      store.createIssueDependency(issues[index]!.id, { dependsOnIssueId: issues[index - 1]!.id, type: "blocked_by" });
    }
    // The tail may still depend on the head's prerequisite; only a real cycle is refused.
    const extra = store.createIssue({ title: "Extra" });
    store.createIssueDependency(extra.id, { dependsOnIssueId: issues[issues.length - 1]!.id, type: "blocked_by" });
    expect(store.listUnmetPrerequisites(extra.id)).toHaveLength(1);
  });
});

describe("MUL-400 E3 — gate", () => {
  it("records the assignee without dispatching while a prerequisite is open", () => {
    const { store, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Dependent", status: "backlog" });
    store.createIssueDependency(dependent.id, { dependsOnIssueId: prereq.id, type: "blocked_by" });

    const assigned = store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });
    expect(assigned.task).toBeNull();
    expect(assigned.issue.status).toBe("backlog");
    expect(assigned.issue.assigneeId).toBe(agent.id);
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
    expect(activityOf(store, dependent.id, "dispatch_skipped")[0]!.data).toMatchObject({ reason: "dependencies_unmet" });
    expect(store.listIssueActivity(dependent.id).some((entry) => entry.type === "dependency_auto_started")).toBe(false);
  });

  it("answers 409 on backlog -> todo and lets a member force past it", () => {
    const store = createStore();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Dependent", status: "backlog" });
    store.createIssueDependency(dependent.id, { dependsOnIssueId: prereq.id, type: "blocked_by" });

    const held = catchError(() => store.updateIssue(dependent.id, { status: "todo" }));
    expect(held.code).toBe("dependencies_unmet");
    expect(held.details?.unmet).toHaveLength(1);
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");

    const forced = store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });
    expect(forced.status).toBe("todo");
    // The rows stay, so the page can still explain what was skipped.
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
    expect(activityOf(store, dependent.id, "dependency_force_started")[0]!.data).toMatchObject({ previousStatus: "backlog" });
  });

  it("parks a created issue in backlog when blocked_by is unmet", () => {
    const store = createStore();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Dependent", status: "todo", blockedBy: [prereq.key] });
    expect(dependent.status).toBe("backlog");
    expect(store.listUnmetPrerequisites(dependent.id).map((row) => row.key)).toEqual([prereq.key]);
    expect(activityOf(store, dependent.id, "dependency_waiting")).toHaveLength(1);

    // A satisfied prerequisite at creation time keeps the requested status.
    const donePrereq = store.createIssue({ title: "Already done" });
    store.updateIssue(donePrereq.id, { status: "done" });
    const started = store.createIssue({ title: "Ready", status: "todo", blocked_by: [donePrereq.id] });
    expect(started.status).toBe("todo");
  });

  it("rejects the whole creation when a prerequisite would create a cycle", () => {
    const store = createStore();
    const first = store.createIssue({ title: "First" });
    const second = store.createIssue({ title: "Second", blockedBy: [first.id] });
    // `second` already waits on `first`; making `first` wait on `second` closes
    // the loop, and the whole creation must be rolled back.
    const before = store.listIssues({ workspaceId: "local" }).length;
    const cyclic = catchError(() => store.createIssue({
      title: "Cyclic",
      status: "todo",
      blockedBy: [first.id],
      // The new issue is `second`'s prerequisite, so `first` waiting for it
      // would mean first -> new -> second -> first.
      id: second.id,
    }));
    expect(cyclic).toBeDefined();
    expect(store.listIssues({ workspaceId: "local" }).length).toBe(before);
  });
});

describe("MUL-400 E3 — automatic start", () => {
  function chain() {
    const { store, runtime, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const dependent = store.createIssue({ title: "Dependent", status: "backlog", blockedBy: [prereq.id] });
    const task = store.createTask({ agentId: agent.id, issueId: prereq.id, prompt: "finish the prerequisite" });
    return { store, runtime, agent, prereq, dependent, task };
  }

  function runTask(store: Store, runtimeId: string, taskId: string) {
    let claimed = store.claimTask(runtimeId);
    while (claimed && claimed.id !== taskId) claimed = store.claimTask(runtimeId);
    if (!claimed) throw new Error(`Could not claim task ${taskId}`);
    return store.startTask(taskId);
  }

  it("starts a dependent whose owner is an agent once the prerequisite is done", () => {
    const { store, runtime, agent, prereq, dependent, task } = chain();
    // The dependent is owned by the same agent while still parked.
    store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });

    runTask(store, runtime.id, task.id);
    store.completeTask(task.id, { output: "prerequisite finished" });
    store.updateIssue(prereq.id, { status: "done" });

    const started = store.getIssue(dependent.id)!;
    expect(started.status).toBe("todo");
    const auto = activityOf(store, dependent.id, "dependency_auto_started");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.data).toMatchObject({ satisfiedByKey: prereq.key, autoStarted: true });
    expect(store.listTasksForIssue(dependent.id).filter((row) => row.status !== "cancelled")).toHaveLength(1);
  });

  it("only reports for a member-owned dependent", () => {
    const { store, prereq } = chain();
    const member = store.getWorkspaceMember("mem_local") ?? store.listWorkspaceMembers("local")[0]!;
    const dependent = store.createIssue({
      title: "Human start",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "member",
      assigneeId: member.id,
    });
    store.updateIssue(prereq.id, { status: "done" });

    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    expect(activityOf(store, dependent.id, "dependency_auto_started")).toHaveLength(0);
    expect(activityOf(store, dependent.id, "dependency_satisfied")).toHaveLength(1);
  });

  it("is idempotent when the prerequisite is written done twice", () => {
    const { store, agent, prereq, dependent } = chain();
    store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });
    store.updateIssue(prereq.id, { status: "done" });
    const firstTasks = store.listTasksForIssue(dependent.id).length;
    // Re-enter done (in_review then done) and re-run the hook.
    store.updateIssue(prereq.id, { status: "in_review" });
    store.updateIssue(prereq.id, { status: "done" });
    expect(activityOf(store, dependent.id, "dependency_auto_started")).toHaveLength(1);
    expect(store.listTasksForIssue(dependent.id).length).toBe(firstTasks);
  });
});

describe("MUL-400 E3 — prerequisite failure", () => {
  it("records the failure and reaches the dependent's owner with the three commands", () => {
    const { store, agent } = storeWithAgent();
    const member = store.getWorkspaceMember("mem_local") ?? store.listWorkspaceMembers("local")[0]!;
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "member",
      assigneeId: member.id,
    });

    store.updateIssue(prereq.id, { status: "cancelled" });

    const failed = activityOf(store, dependent.id, "dependency_prerequisite_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({ prerequisiteKey: prereq.key, prerequisiteStatus: "cancelled" });
    const commands = (failed[0]!.data as { commands: string[] }).commands;
    expect(commands).toHaveLength(3);
    expect(commands[0]).toContain("replacement");
    expect(commands[1]).toContain(`remi issue update ${dependent.key} --status cancelled`);
    expect(commands[2]).toContain(`remi issue dependency remove ${dependent.key}`);

    const items = store.listInboxItems(member.id, "local");
    expect(items.some((item) => item.type === "dependency_prerequisite_failed")).toBe(true);
    // The dependent stays parked: only a human chooses between the three ways out.
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
  });

  it("folds the failure into the parent report when the dependent has a parent", () => {
    const { store, agent } = storeWithAgent();
    const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Dependent", status: "backlog", parentIssueId: parent.id, blockedBy: [prereq.id] });

    store.updateIssue(prereq.id, { status: "blocked" });

    const comments = store.listIssueComments(parent.id).filter((comment) => comment.type === "system");
    expect(comments.some((comment) => comment.body.includes(prereq.key) && comment.body.includes(dependent.key))).toBe(true);
    // S1's round scheduling carries it: the parent owner gets a queued round.
    expect(store.listTasksForIssue(parent.id).some((task) => task.status === "queued")).toBe(true);
  });
});

describe("MUL-400 E3 — surfaces", () => {
  it("serves blocked_by on children, waiting_on on detail, and the waiting bucket", async () => {
    const { store } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const parent = store.createIssue({ title: "Parent", status: "in_progress" });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const waiting = store.createIssue({ title: "Waiting", status: "backlog", parentIssueId: parent.id, blockedBy: [prereq.id] });
    const active = store.createIssue({ title: "Active", status: "in_progress", parentIssueId: parent.id });

    const children = await (await app.request(`/api/issues/${parent.id}/children`)).json() as { issues: Array<Record<string, unknown>> };
    expect(children.issues.find((row) => row.id === waiting.id)!.blocked_by).toEqual([prereq.key]);
    expect(children.issues.find((row) => row.id === active.id)!.blocked_by).toEqual([]);

    const detail = await (await app.request(`/api/multiremi/issues/${waiting.id}`)).json() as {
      issue: { waiting_on: string[] };
      waitingOn: { unmet: unknown[] };
    };
    expect(detail.issue.waiting_on).toEqual([prereq.key]);
    expect(detail.waitingOn.unmet).toHaveLength(1);

    const progress = await (await app.request("/api/issues/child-progress")).json() as {
      progress: Array<{ parentIssueId: string; waiting: number; active: number }>;
    };
    const parentRow = progress.progress.find((row) => row.parentIssueId === parent.id)!;
    expect(parentRow.waiting).toBe(1);
    expect(parentRow.active).toBe(1);
  });

  it("filters lists by parent_id and top_level_only", async () => {
    const { store } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const parent = store.createIssue({ title: "Parent" });
    store.createIssue({ title: "Child one", parentIssueId: parent.id });
    store.createIssue({ title: "Child two", parentIssueId: parent.id });
    store.createIssue({ title: "Root" });

    const byKey = await (await app.request(`/api/issues?parent_id=${parent.key}`)).json() as { issues: Array<Record<string, unknown>> };
    expect(byKey.issues).toHaveLength(2);
    const topLevel = await (await app.request("/api/issues?top_level_only=true")).json() as { issues: Array<Record<string, unknown>> };
    expect(topLevel.issues.some((row) => row.id === parent.id)).toBe(true);
    expect(topLevel.issues.some((row) => row.parent_issue_id === parent.id)).toBe(false);
  });

  it("answers dependency_cycle and dependencies_unmet over HTTP with machine-readable codes", async () => {
    const { store } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });
    await app.request(`/api/issues/${a.id}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depends_on_issue_id: b.id, type: "blocks" }),
    });
    const cyclic = await app.request(`/api/issues/${a.id}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ depends_on_issue_id: b.id, type: "blocked_by" }),
    });
    expect(cyclic.status).toBe(409);
    expect(await cyclic.json()).toMatchObject({ code: "dependency_cycle" });

    const dependent = store.createIssue({ title: "Dependent", status: "backlog", blockedBy: [b.id] });
    const held = await app.request(`/api/issues/${dependent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    });
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ code: "dependencies_unmet" });
  });

  it("reports dependencies_unmet on create instead of backlog_status", async () => {
    const { store, agent } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });

    const response = await app.request("/api/issues", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Blocked child",
        status: "todo",
        assignee_type: "agent",
        assignee_id: agent.id,
        blocked_by: [prereq.key],
      }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body.status).toBe("backlog");
    expect(body.dispatch_status).toBe("skipped");
    expect(body.dispatch_skipped_reason).toBe("dependencies_unmet");
  });
});

describe("MUL-400 E3 — the kill switch", () => {
  it("passes everything through when MULTIREMI_DEPENDENCY_GATE is off", () => {
    const previous = process.env.MULTIREMI_DEPENDENCY_GATE;
    process.env.MULTIREMI_DEPENDENCY_GATE = "off";
    try {
      const { store, agent } = storeWithAgent();
      const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
      const dependent = store.createIssue({ title: "Dependent", status: "todo", blockedBy: [prereq.id] });
      expect(dependent.status).toBe("todo");
      const assigned = store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });
      expect(assigned.task).not.toBeNull();

      const other = store.createIssue({ title: "Other", status: "in_progress" });
      const waiting = store.createIssue({ title: "Waiting", status: "backlog", blockedBy: [other.id] });
      store.updateIssue(other.id, { status: "done" });
      expect(store.getIssue(waiting.id)!.status).toBe("backlog");
      expect(activityOf(store, waiting.id, "dependency_auto_started")).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.MULTIREMI_DEPENDENCY_GATE;
      else process.env.MULTIREMI_DEPENDENCY_GATE = previous;
    }
  });
});
