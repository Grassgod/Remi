// MUL-400 S2 (E3): sibling dependencies actually hold and release work.
//
// The dependency gate has three entry points (assign, status write, creation),
// the automatic start is driven by the prerequisite's own terminal write, and
// the failure path has to reach a human. These tests drive the real store and
// the real HTTP routes against an in-memory database; the Postgres end-to-end
// run lives in `reports/`.
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { StoreContext, type CommitEventQueue } from "@multiremi/store/context.js";
import { TasksRepo } from "@multiremi/store/repos/tasks-repo.js";
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

/**
 * Every task row of an issue, terminal ones included. The QA round-2 blockers
 * hid behind `filter(status !== "cancelled")` counts, so the fix-round tests
 * assert the whole table instead.
 */
function allTaskRows(store: Store, issueId: string): Array<{ id: string; status: string; agentId: string }> {
  return store.listTasksForIssue(issueId).map((task) => ({
    id: task.id,
    status: task.status,
    agentId: task.agentId,
  }));
}

/** Every activity row of one type, in timeline order. */
function allActivityRows(store: Store, issueId: string, type: string) {
  return store.listIssueActivity(issueId).filter((entry) => entry.type === type);
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

  /**
   * MUL-409 fix round, QA suggestion 2: a pre-existing `blocks` row is stored
   * against the *other* column, so the reported pair has to be read back the
   * same way. `unmet[0].issueId` must name the waiter, not the prerequisite.
   */
  it("reads a legacy blocks row as (waiter blocked_by prerequisite)", () => {
    const store = createStore();
    const prerequisite = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const waiter = store.createIssue({ title: "Waiter", status: "backlog" });
    db!.run(
      `INSERT INTO multiremi_issue_dependencies (id, workspace_id, issue_id, depends_on_issue_id, type, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["dep_legacy_blocks", "local", prerequisite.id, waiter.id, "blocks", new Date().toISOString()],
    );

    const unmet = store.listUnmetPrerequisites(waiter.id);
    expect(unmet).toHaveLength(1);
    expect(unmet[0]!.issueId).toBe(waiter.id);
    expect(unmet[0]!.dependsOnIssueId).toBe(prerequisite.id);
    expect(unmet[0]!.key).toBe(prerequisite.key);
    expect(store.getIssueWaitingOn(waiter.id).unmet).toHaveLength(1);

    // The gate's 409 body carries the same pair, so a client can render it.
    const held = catchError(() => store.updateIssue(waiter.id, { status: "todo" }));
    expect(held.code).toBe("dependencies_unmet");
    const details = held.details as { unmet?: Array<{ issueId: string; dependsOnIssueId: string }> };
    expect(details.unmet?.[0]).toMatchObject({ issueId: waiter.id, dependsOnIssueId: prerequisite.id });
  });

  /**
   * MUL-409 fix round, QA suggestion 8: `related` is not a dependency in either
   * direction, so it must not be given one.
   */
  it("reports no direction for a related row from either end", () => {
    const store = createStore();
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B" });
    store.createIssueDependency(a.id, { dependsOnIssueId: b.id, type: "related" });

    expect(store.listIssueDependencies(a.id)[0]!.direction).toBeNull();
    expect(store.listIssueDependencies(b.id)[0]!.direction).toBeNull();
    // A `related` row is neither a prerequisite nor a dependent.
    expect(store.listUnmetPrerequisites(a.id)).toEqual([]);
    expect(store.listUnmetPrerequisites(b.id)).toEqual([]);
    expect(store.getIssueWaitingOn(b.id)).toMatchObject({ unmet: [], prerequisites: [] });
    // So it never triggers the gate.
    store.updateIssue(b.id, { status: "todo" });
    expect(store.getIssue(b.id)!.status).toBe("todo");
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

  /**
   * MUL-409 fix round, blocking 1: a forced start must really start. The status
   * alone is not the deliverable — the issue has to own a round, otherwise no
   * automatic path can pick it up again.
   */
  it.each(["agent", "squad"] as const)("forces a %s-owned issue into a real round", (ownerKind) => {
    const { store, agent } = storeWithAgent();
    const squad = store.createSquad({ name: "Force squad", workspaceId: "local", leaderId: agent.id });
    const ownerId = ownerKind === "agent" ? agent.id : squad.id;
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      assigneeType: ownerKind,
      assigneeId: ownerId,
      blockedBy: [prereq.id],
    });

    const forced = store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });
    expect(forced.status).toBe("todo");

    const rounds = store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.status).toBe("queued");
    // The owner the member asked for is the one that got the round.
    expect(rounds[0]!.agentId).toBe(ownerKind === "agent" ? agent.id : agent.id);
    expect(activityOf(store, dependent.id, "dependency_force_started")).toHaveLength(1);
    // The dependency rows stay: the issue is running *despite* an unmet
    // prerequisite, and the page has to keep saying so.
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
  });

  it("creates only one round when the same issue is forced twice", () => {
    const { store, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
      blockedBy: [prereq.id],
    });

    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });
    // The second call no longer leaves backlog, so the gate has nothing to
    // override and no dispatch runs again.
    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });

    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
    expect(activityOf(store, dependent.id, "dependency_force_started")).toHaveLength(1);

    // A forced issue that moves on is no longer waiting, so further writes are
    // ordinary status changes and must not queue another round either.
    store.updateIssue(dependent.id, { status: "in_progress", force: true, actorType: "member", actorId: "mem_local" });
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
    expect(store.getIssue(dependent.id)!.status).toBe("in_progress");
  });

  it("does not dispatch a second round when a forced issue's prerequisite later finishes", () => {
    const { store, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
      blockedBy: [prereq.id],
    });

    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);

    // The prerequisite finishing only auto-starts issues still parked in
    // backlog; a forced one is already running and must keep its single round.
    store.updateIssue(prereq.id, { status: "done" });
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
    expect(activityOf(store, dependent.id, "dependency_auto_started")).toHaveLength(0);
  });

  /**
   * MUL-409 fix round, blocking 1: the gate only holds an issue that is
   * *waiting*. An issue that is already `todo` with an unmet prerequisite is
   * information, not a hold, so the same agent can be assigned again and the
   * round is created — the rescue path for rows stranded by the old behavior.
   */
  it("lets the same agent pick up a todo issue that carries an unmet prerequisite", () => {
    const { store, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Stranded",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
      blockedBy: [prereq.id],
    });
    // The shape the old force path left behind: todo with an unmet prerequisite.
    db!.run("UPDATE multiremi_issues SET status = 'todo' WHERE id = ?", [dependent.id]);

    const assigned = store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });
    expect(assigned.task?.id).toBeDefined();
    expect(assigned.issue.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
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

  it.each([
    ["dependency_on_ancestor", (store: Store) => {
      const parent = store.createIssue({ title: "Parent" });
      const child = store.createIssue({ title: "Child", parentIssueId: parent.id });
      return { blockedBy: [parent.id], parent, expectCode: "dependency_on_ancestor" };
    }],
    ["a missing prerequisite", (store: Store) => ({
      blockedBy: ["iss_does_not_exist"],
      parent: undefined,
      expectCode: "not_found",
    })],
    ["a prerequisite in another workspace", (store: Store) => {
      const remote = store.createIssue({ title: "Remote", workspaceId: "remote" });
      return { blockedBy: [remote.id], parent: undefined, expectCode: "cross_workspace" };
    }],
  ])("rolls the whole creation back when %s rejects the dependency", (_label, build) => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const { blockedBy, parent, expectCode } = build(store);
    const issuesBefore = store.listIssues({ workspaceId: "local" }).length;
    const childrenBefore = parent ? store.listChildIssues(parent.id).length : 0;
    const dependenciesBefore = (db!.query("SELECT COUNT(*) AS n FROM multiremi_issue_dependencies").get() as { n: number }).n;
    const nextKeyBefore = `MUL-${issuesBefore + 1}`;

    const failure = catchError(() => store.createIssue({
      title: "Rejected child",
      status: "todo",
      parentIssueId: parent?.id,
      blockedBy,
    }));
    // The dependency error is what surfaced, not a constraint violation.
    if (expectCode === "not_found") expect(failure.message).toContain("Dependent issue not found");
    else if (expectCode === "cross_workspace") expect(failure.message).toContain("within a workspace");
    else expect(failure.code).toBe(expectCode);

    // Nothing survives the failed creation: no orphan issue row, no child row,
    // no dependency row, and the next issue number is unchanged.
    expect(store.listIssues({ workspaceId: "local" }).length).toBe(issuesBefore);
    if (parent) expect(store.listChildIssues(parent.id).length).toBe(childrenBefore);
    expect((db!.query("SELECT COUNT(*) AS n FROM multiremi_issue_dependencies").get() as { n: number }).n)
      .toBe(dependenciesBefore);
    expect(store.createIssue({ title: "After the rejection" }).key).toBe(nextKeyBefore);
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

  /**
   * MUL-409 fix round, QA suggestion 6 / blocking-1 follow-up: a readiness
   * report must not queue a round of its own. With a shared parent the line
   * joins the prerequisite's E2 report — one round for the parent owner, and it
   * mentions the dependent.
   */
  it("folds the readiness line into the prerequisite's report when both share a parent", () => {
    const { store, agent } = storeWithAgent();
    const member = store.listWorkspaceMembers("local")[0]!;
    const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const prerequisite = store.createIssue({ title: "Prerequisite", status: "in_progress", parentIssueId: parent.id });
    const dependent = store.createIssue({
      title: "Human-owned sibling",
      status: "backlog",
      parentIssueId: parent.id,
      blockedBy: [prerequisite.id],
      assigneeType: "member",
      assigneeId: member.id,
    });

    store.updateIssue(prerequisite.id, { status: "done" });

    // Exactly one round: the E2 report for the prerequisite, not one per report.
    const rounds = store.listTasksForIssue(parent.id).filter((task) => task.status !== "cancelled");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.triggerCommentId).toBeTruthy();
    const comment = store.getIssueComment(rounds[0]!.triggerCommentId!)!;
    expect(comment.body).toContain(prerequisite.key);
    expect(comment.body).toContain(dependent.key);
    // The dependent records the merge under the same activity type; the flag is
    // what distinguishes "folded into the prerequisite's report" from "reported
    // on its own".
    const satisfied = activityOf(store, dependent.id, "dependency_satisfied");
    expect(satisfied).toHaveLength(2);
    expect(satisfied.some((entry) => entry.data?.mergedIntoPrerequisiteReport === true)).toBe(true);
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
  });

  it("does not queue a round when a differently-parented dependent becomes ready", () => {
    const { store, agent } = storeWithAgent();
    const member = store.listWorkspaceMembers("local")[0]!;
    const prerequisiteParent = store.createIssue({ title: "Prerequisite parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const dependentParent = store.createIssue({ title: "Dependent parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const prerequisite = store.createIssue({ title: "Prerequisite", status: "in_progress", parentIssueId: prerequisiteParent.id });
    const dependent = store.createIssue({
      title: "Human-owned",
      status: "backlog",
      parentIssueId: dependentParent.id,
      blockedBy: [prerequisite.id],
      assigneeType: "member",
      assigneeId: member.id,
    });

    const before = store.listTasksForIssue(dependentParent.id).length;
    store.updateIssue(prerequisite.id, { status: "done" });

    // No queued round on the dependent's parent, so none is created either.
    expect(store.listTasksForIssue(dependentParent.id).length).toBe(before);
    expect(activityOf(store, dependentParent.id, "dependency_satisfied")).toHaveLength(1);
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
  });

  it("extends the dependent parent's queued round instead of creating another", () => {
    const { store, agent } = storeWithAgent();
    const member = store.listWorkspaceMembers("local")[0]!;
    const prerequisiteParent = store.createIssue({ title: "Prerequisite parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const dependentParent = store.createIssue({ title: "Dependent parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const queued = store.createTask({ agentId: agent.id, issueId: dependentParent.id, prompt: "waiting round" });
    const prerequisite = store.createIssue({ title: "Prerequisite", status: "in_progress", parentIssueId: prerequisiteParent.id });
    const dependent = store.createIssue({
      title: "Human-owned",
      status: "backlog",
      parentIssueId: dependentParent.id,
      blockedBy: [prerequisite.id],
      assigneeType: "member",
      assigneeId: member.id,
    });

    store.updateIssue(prerequisite.id, { status: "done" });

    const rounds = store.listTasksForIssue(dependentParent.id).filter((task) => task.status !== "cancelled");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.id).toBe(queued.id);
    expect(rounds[0]!.prompt).toContain(dependent.key);
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

  /**
   * MUL-409 fix round, QA suggestion 5: the no-owner dependent. With no parent
   * the report falls back to the dependent's subscribers; with a parent it
   * joins the parent's report.
   */
  it.each(["cancelled", "blocked"] as const)("reports a %s prerequisite for an unowned dependent with a parent", (terminal) => {
    const { store, agent } = storeWithAgent();
    const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Unowned", status: "backlog", parentIssueId: parent.id, blockedBy: [prereq.id] });

    store.updateIssue(prereq.id, { status: terminal });

    const failed = activityOf(store, dependent.id, "dependency_prerequisite_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({ prerequisiteStatus: terminal });
    const comments = store.listIssueComments(parent.id).filter((comment) => comment.type === "system");
    expect(comments.some((comment) => comment.body.includes(dependent.key))).toBe(true);
  });

  it.each(["cancelled", "blocked"] as const)("reports a %s prerequisite to the subscribers of an unowned dependent with no parent", (terminal) => {
    const { store } = storeWithAgent();
    const member = store.listWorkspaceMembers("local")[0]!;
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Unowned", status: "backlog", blockedBy: [prereq.id] });
    store.addIssueSubscriber(dependent.id, member.id, "manual");

    store.updateIssue(prereq.id, { status: terminal });

    expect(activityOf(store, dependent.id, "dependency_prerequisite_failed")).toHaveLength(1);
    const items = store.listInboxItems(member.id, "local");
    expect(items.some((item) => item.type === "dependency_prerequisite_failed")).toBe(true);
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

  /**
   * MUL-409 fix round 2: the assign route must NOT accept an override. `force`
   * is a server-internal dispatch option (the audited member status write sets
   * it), so a request body that supplies it is ignored — the assignment behaves
   * exactly like one without it, which keeps the plan's "one override, always
   * audited" rule true.
   */
  it.each([
    ["camelCase member", { assigneeType: "agent", force: true }],
    ["snake_case member", { assignee_type: "agent", force: true }],
  ])("ignores a body-supplied force on the assign route (%s)", async (_label, overrides) => {
    const { store, agent } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Dependent", status: "backlog", blockedBy: [prereq.id] });
    const camel = "assigneeType" in overrides;
    const body = camel
      ? { ...overrides, assigneeId: agent.id }
      : { ...overrides, assignee_id: agent.id };

    const response = await app.request(`/api/multiremi/issues/${dependent.id}/assign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { issue: { status: string; assigneeId?: string | null }; task: unknown };

    // Same outcome as a plain assign: owner recorded, still waiting, no round.
    expect(payload.issue.status).toBe("backlog");
    expect(payload.task).toBeNull();
    expect(store.getIssue(dependent.id)!.assigneeId).toBe(agent.id);
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
    expect(activityOf(store, dependent.id, "dependency_force_started")).toHaveLength(0);
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
  });

  it("keeps the PATCH status override as the only way across, with its audit record", async () => {
    const { store, agent } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Dependent",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    const response = await app.request(`/api/issues/${dependent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo", force: true }),
    });
    expect(response.status).toBe(200);
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
    // Exactly one record, and only the PATCH path can produce it.
    expect(activityOf(store, dependent.id, "dependency_force_started")).toHaveLength(1);
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

/**
 * MUL-409 fix round 2, blocking 3 (Senior大哥 ruling `cmt_am1o8xnzkwy0`): the
 * dependency gate gains a second layer at the single task-creation funnel, so
 * every path that can start work on a waiting issue is covered, and the only
 * way across stays the audited member `force`.
 */
describe("MUL-400 E3 — task-creation gate", () => {
  function parked() {
    const { store, runtime, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Waiting", status: "backlog", blockedBy: [prereq.id] });
    return { store, runtime, agent, prereq, dependent };
  }

  it("refuses a task-identity call through POST /api/multiremi/tasks with 409", async () => {
    const { store, agent, dependent } = parked();
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, issueId: dependent.id, prompt: "start early" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { code?: string; error?: string };
    expect(body.code).toBe("dependencies_unmet");
    expect(body.error).toContain("force");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
  });

  it("refuses a member call through POST /api/multiremi/tasks with 409 too", async () => {
    // The gate is structural: a member passes the route's auth but not the gate.
    const { store, agent, dependent } = parked();
    const app = createMultiremiApp({ store });
    const response = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", "x-multiremi-actor": "member" },
      body: JSON.stringify({ agentId: agent.id, issueId: dependent.id, prompt: "member start" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as { code?: string }).code).toBe("dependencies_unmet");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
  });

  it("lets assignIssue dispatch once a member force moved the issue out of backlog", () => {
    const { store, agent, dependent } = parked();
    // The forced start needs an owner to dispatch to, so record one first.
    store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });
    expect(store.getIssue(dependent.id)!.assigneeId).toBe(agent.id);
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);

    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "local" });
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
    expect(activityOf(store, dependent.id, "dependency_force_started")).toHaveLength(1);

    // The issue is no longer waiting, so the task-creation gate lets a further
    // dispatch through instead of refusing it: replacing the owner is allowed.
    const second = store.createAgent({ name: "Second owner", provider: "claude" });
    const reassigned = store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: second.id });
    expect(reassigned.task?.id).toBeDefined();
    expect(store.listTasksForIssue(dependent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
  });

  it("settles an Autopilot trigger_issue run as skipped without creating a task", () => {
    const { store, agent, dependent } = parked();
    const autopilot = store.createAutopilot({
      workspaceId: "local",
      title: "Run the waiting issue",
      assigneeId: agent.id,
      createdById: "local",
      createdByType: "member",
      executionMode: "trigger_issue",
    });
    const run = store.runAutopilot(autopilot.id, { triggerIssueId: dependent.id, source: "manual" });
    expect(run.status).toBe("skipped");
    expect(run.failureReason).toBe("dependencies_unmet");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
  });

  it("keeps a human comment and records a dispatch_skipped hold on a waiting issue", () => {
    const { store, agent, dependent } = parked();
    store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });
    expect(activityOf(store, dependent.id, "dispatch_skipped")).toHaveLength(1);

    const comment = store.createIssueComment(dependent.id, { body: "please start", authorType: "member", authorId: "local" });
    expect(store.getIssueComment(comment.id)).not.toBeNull();
    // The comment landed, no round was created, and the hold is visible.
    const skips = activityOf(store, dependent.id, "dispatch_skipped");
    expect(skips.length).toBeGreaterThanOrEqual(2);
    expect(skips.at(-1)!.data).toMatchObject({ reason: "dependencies_unmet", commentId: comment.id });
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
  });

  it("keeps an agent mention and records comment_mention_skipped", () => {
    const { store, agent, dependent } = parked();
    const leader = store.createAgent({ name: "Leader", provider: "claude" });
    const comment = store.createIssueComment(dependent.id, {
      body: `[@${agent.name}](mention://agent/${agent.id}) please start`,
      authorType: "member",
      authorId: "local",
    });

    expect(store.getIssueComment(comment.id)).not.toBeNull();
    const skipped = activityOf(store, dependent.id, "comment_mention_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.data).toMatchObject({ reason: "dependencies_unmet", agentId: agent.id });
    expect(activityOf(store, dependent.id, "comment_mention_triggered")).toHaveLength(0);
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
    expect(leader.archivedAt).toBeNull();
  });

  it("does not block a retry of an existing round on a waiting issue", () => {
    // The round exists BEFORE the dependency is declared — the only way an
    // issue can be both waiting and already have tasks — and its retry is a
    // continuation of that round, not the issue's first execution.
    const { store, runtime, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Existing work", status: "in_progress" });
    const first = store.createTask({ agentId: agent.id, issueId: dependent.id, prompt: "run" });
    let claimed = store.claimTask(runtime.id);
    while (claimed && claimed.id !== first.id) claimed = store.claimTask(runtime.id);
    store.startTask(first.id);
    store.failTask(first.id, { error: "boom" });

    // Now the issue gains an unmet prerequisite and is parked again.
    store.createIssueDependency(dependent.id, { dependsOnIssueId: prereq.id, type: "blocked_by" });
    store.updateIssue(dependent.id, { status: "backlog" });
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");

    const retried = store.createTask({
      agentId: agent.id,
      issueId: dependent.id,
      prompt: "retry",
      attempt: 2,
      continuedFromTaskId: first.id,
    });
    expect(retried.attempt).toBe(2);
    expect(store.getIssue(prereq.id)!.status).toBe("in_progress");
  });

  it("returns 409 from the rerun route for a waiting issue", async () => {
    const { store, agent, dependent } = parked();
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/issues/${dependent.id}/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id }),
    });
    expect(response.status).toBe(409);
    const body = await response.json() as { code?: string };
    expect(body.code).toBe("dependencies_unmet");
    expect(store.listTasksForIssue(dependent.id)).toHaveLength(0);
    expect(allActivityRows(store, dependent.id, "dependency_gate_exempted")).toEqual([]);
  });

  it("does not block a continuation that names continuedFromTaskId", () => {
    // Same history: the previous round predates the dependency.
    const { store, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({ title: "Existing work", status: "in_progress" });
    const previous = store.createTask({ agentId: agent.id, issueId: dependent.id, prompt: "previous" });
    store.createIssueDependency(dependent.id, { dependsOnIssueId: prereq.id, type: "blocked_by" });
    store.updateIssue(dependent.id, { status: "backlog" });
    // Structural exemption: the round continues an existing conversation.
    const continuation = store.createTask({
      agentId: agent.id,
      issueId: dependent.id,
      prompt: "continue",
      continuedFromTaskId: previous.id,
    });
    expect(continuation.continuedFromTaskId).toBe(previous.id);
  });

  it("does not block the E2 wake-up that carries preserveIssueStatus", () => {
    const { store, agent } = storeWithAgent();
    const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const other = store.createIssue({ title: "Other prerequisite", status: "in_progress" });
    const parkedParent = store.createIssue({
      title: "Parked parent",
      status: "backlog",
      assigneeType: "agent",
      assigneeId: agent.id,
      blockedBy: [other.id],
    });

    // A wake-up round for a child's outcome is a notification, not a start.
    const wakeup = store.createTask({
      agentId: agent.id,
      issueId: parkedParent.id,
      prompt: "child reported",
      preserveIssueStatus: true,
    });
    expect(wakeup.id).toBeDefined();
    expect(store.getIssue(parkedParent.id)!.status).toBe("backlog");
    expect(store.getIssue(parent.id)!.status).toBe("in_progress");
  });
});

/**
 * MUL-409 fix round 3, QA round-2 blockers. Each test reproduces the reported
 * request and then asserts the whole row set — task rows including cancelled
 * ones, every activity row, and the HTTP status plus error code.
 */
describe("MUL-400 E3 — fix round 3: gate integrity", () => {
  function parkedWithOwner() {
    const { store, runtime, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Waiting",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    return { store, runtime, agent, prereq, dependent };
  }

  // ── blocker 1: a request body cannot forge a structural exemption ─────────
  it.each([
    ["camelCase attempt", { attempt: 2 }],
    ["camelCase attempt with maxAttempts", { attempt: 2, maxAttempts: 3 }],
    ["snake_case attempt", { attempt: 2, max_attempts: 3 }],
    ["camelCase preserveIssueStatus", { preserveIssueStatus: true }],
    ["snake_case preserve_issue_status", { preserve_issue_status: true }],
  ])("ignores a body-supplied exemption on the task route (%s)", async (_label, extra) => {
    const { store, agent, dependent } = parkedWithOwner();
    const app = createMultiremiApp({ store });

    const response = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: agent.id, issueId: dependent.id, prompt: "start early", ...extra }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as { code?: string }).code).toBe("dependencies_unmet");
    // The whole row set: nothing at all was created.
    expect(allTaskRows(store, dependent.id)).toEqual([]);
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    expect(allActivityRows(store, dependent.id, "dependency_force_started")).toEqual([]);
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
  });

  // Suggestion 1 (QA round 3): the ADR says both spellings of every
  // server-owned exemption field are stripped from a public request. The route
  // stripped `maxAttempts` but forwarded `max_attempts` untouched — the store
  // happens not to read it today, so the hole was invisible, but the next gate
  // that does would inherit it.
  it.each([
    ["camelCase", { maxAttempts: 9 }, "maxAttempts"],
    ["snake_case", { max_attempts: 9 }, "max_attempts"],
  ])("strips max attempts from a public task request (%s)", async (_label, extra, key) => {
    const { store, agent, prereq } = parkedWithOwner();
    const app = createMultiremiApp({ store });

    // Observe what the route hands the store: the field must not be in it. The
    // stored row cannot show this, because the store's own default is what wins
    // either way.
    type CreateInput = Record<string, unknown>;
    const seen: CreateInput[] = [];
    const target = store as unknown as { createTask(input: CreateInput): unknown };
    const original = target.createTask.bind(target);
    target.createTask = (input: CreateInput) => { seen.push(input); return original(input); };

    const response = await app.request("/api/multiremi/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Use a non-waiting issue so the request reaches the store at all: on a
      // waiting issue the gate refuses before the body matters.
      body: JSON.stringify({ agentId: agent.id, issueId: prereq.id, prompt: "strip check", ...extra }),
    });
    target.createTask = original;
    expect(response.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(key in seen[0]!).toBe(false);
    expect(seen[0]).not.toHaveProperty("maxAttempts");
    expect(seen[0]).not.toHaveProperty("max_attempts");
  });

  it("still lets the internal retry path through", () => {
    // Structural exemption for a real retry: the server sets attempt itself.
    const { store, runtime, agent } = storeWithAgent();
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const issue = store.createIssue({ title: "Existing", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "run" });
    let claimed = store.claimTask(runtime.id);
    while (claimed && claimed.id !== first.id) claimed = store.claimTask(runtime.id);
    store.startTask(first.id);
    store.failTask(first.id, { error: "boom" });

    store.createIssueDependency(issue.id, { dependsOnIssueId: prereq.id, type: "blocked_by" });
    store.updateIssue(issue.id, { status: "backlog" });
    const retry = store.createTask({
      agentId: agent.id,
      issueId: issue.id,
      prompt: "retry",
      attempt: 2,
      continuedFromTaskId: first.id,
    });
    expect(retry.attempt).toBe(2);
  });

  // ── blocker 2: one forced start queues exactly one row ────────────────────
  it.each([
    ["/api/multiremi/issues", true],
    ["/api/issues", false],
  ])("queues exactly one task row for a member force through %s", async (path, camel) => {
    const { store, dependent } = parkedWithOwner();
    const app = createMultiremiApp({ store });
    const response = await app.request(`${path}/${dependent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo", force: true }),
    });
    expect(response.status).toBe(200);

    const rows = allTaskRows(store, dependent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    expect(allActivityRows(store, dependent.id, "dependency_force_started")).toHaveLength(1);
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
  });

  it("keeps a single task row when the same issue is forced twice", async () => {
    const { store, dependent } = parkedWithOwner();
    const app = createMultiremiApp({ store });
    for (let i = 0; i < 2; i++) {
      const response = await app.request(`/api/issues/${dependent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "todo", force: true }),
      });
      expect(response.status).toBe(200);
    }
    expect(allTaskRows(store, dependent.id)).toHaveLength(1);
  });

  // ── blocker 4: create-issue dependency errors keep their contract ──────────
  it.each([
    { kind: "ancestor", expected: 409, expectedCode: "dependency_on_ancestor" },
    { kind: "not_found", expected: 400, expectedCode: "none" },
    { kind: "cross_workspace", expected: 400, expectedCode: "none" },
  ])("maps the $kind creation rejection to the right HTTP status on both routes", async ({ kind, expected, expectedCode }) => {
    const { store } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const parent = store.createIssue({ title: "Parent" });
    // Build the cross-workspace target once, outside the route loop: creating it
    // per iteration would itself change the issue count the rollback assertion
    // compares against.
    const remote = kind === "cross_workspace" ? store.createIssue({ title: "Remote", workspaceId: "remote" }) : null;
    const blockedBy = kind === "ancestor"
      ? [parent.id]
      : kind === "not_found"
        ? ["iss_does_not_exist"]
        : [remote!.id];

    for (const path of ["/api/issues", "/api/multiremi/issues"]) {
      const before = (db!.query("SELECT COUNT(*) AS n FROM multiremi_issues").get() as { n: number }).n;
      const beforeChildren = store.listChildIssues(parent.id).length;
      const beforeDeps = (db!.query("SELECT COUNT(*) AS n FROM multiremi_issue_dependencies").get() as { n: number }).n;

      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: `Rejected-${kind}`, parent_issue_id: parent.id, blocked_by: blockedBy }),
      });
      expect(response.status).toBe(expected);
      const body = await response.json() as { code?: string };
      // Only the cycle/ancestor rejection carries a machine-readable code;
      // the other two are plain 400s from the dependency mapper.
      expect(body.code ?? "none").toBe(expectedCode);

      // Rollback is unchanged: no orphan row, no child, no dependency.
      expect((db!.query("SELECT COUNT(*) AS n FROM multiremi_issues").get() as { n: number }).n).toBe(before);
      expect(store.listChildIssues(parent.id).length).toBe(beforeChildren);
      expect((db!.query("SELECT COUNT(*) AS n FROM multiremi_issue_dependencies").get() as { n: number }).n).toBe(beforeDeps);
    }
  });

  it("records a real mention-skip event with the dependencies_unmet reason", () => {
    // The unit above renders the copy; this one proves the activity the UI reads
    // is actually produced by the mention path on a waiting issue.
    const { store, agent, dependent } = parkedWithOwner();
    const comment = store.createIssueComment(dependent.id, {
      body: `[@${agent.name}](mention://agent/${agent.id}) please start`,
      authorType: "member",
      authorId: "local",
    });

    expect(store.getIssueComment(comment.id)).not.toBeNull();
    const skipped = allActivityRows(store, dependent.id, "comment_mention_skipped");
    expect(skipped).toHaveLength(1);
    expect((skipped[0]!.data ?? {}) as Record<string, unknown>).toMatchObject({
      reason: "dependencies_unmet",
      commentId: comment.id,
      agentId: agent.id,
    });
    expect(allTaskRows(store, dependent.id)).toEqual([]);
  });

  it("records a real coalesced-readiness event", () => {
    // dependency_satisfied_coalesced is written when a readiness line joins an
    // already-queued parent round; the frontend case above renders it.
    const { store, agent } = storeWithAgent();
    const member = store.listWorkspaceMembers("local")[0]!;
    const prerequisiteParent = store.createIssue({ title: "Prereq parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    const dependentParent = store.createIssue({ title: "Dependent parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    store.createTask({ agentId: agent.id, issueId: dependentParent.id, prompt: "queued round" });
    const prerequisite = store.createIssue({ title: "Prerequisite", status: "in_progress", parentIssueId: prerequisiteParent.id });
    store.createIssue({
      title: "Ready sibling",
      status: "backlog",
      parentIssueId: dependentParent.id,
      blockedBy: [prerequisite.id],
      assigneeType: "member",
      assigneeId: member.id,
    });

    store.updateIssue(prerequisite.id, { status: "done" });

    const coalesced = allActivityRows(store, dependentParent.id, "dependency_satisfied_coalesced");
    expect(coalesced).toHaveLength(1);
    expect((coalesced[0]!.data ?? {}) as Record<string, unknown>).toMatchObject({ agentId: agent.id });
    // The line joined the existing round instead of creating a second one.
    expect(store.listTasksForIssue(dependentParent.id).filter((task) => task.status !== "cancelled")).toHaveLength(1);
  });

  // ── blocker 5: batch is not a dependency override ─────────────────────────
  it.each([
    ["/api/multiremi/issues/batch-update", { issueIds: [] }, false],
    ["/api/issues/batch-update", { issue_ids: [] }, true],
  ])("keeps a waiting issue parked when %s carries force", async (path, _shape, snake) => {
    const { store, dependent } = parkedWithOwner();
    const app = createMultiremiApp({ store });
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snake
        ? { issue_ids: [dependent.id], updates: { status: "todo", force: true } }
        : { issueIds: [dependent.id], updates: { status: "todo", force: true } }),
    });
    expect(response.status).toBe(200);

    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    expect(allTaskRows(store, dependent.id)).toEqual([]);
    expect(allActivityRows(store, dependent.id, "dependency_force_started")).toEqual([]);
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
  });

  it("still lets batch force close a parent past the parent-status guard (S1)", async () => {
    const { store, agent } = storeWithAgent();
    const app = createMultiremiApp({ store });
    const parent = store.createIssue({ title: "Parent", status: "in_progress", assigneeType: "agent", assigneeId: agent.id });
    store.createIssue({ title: "Open child", parentIssueId: parent.id, status: "in_progress" });

    const response = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue_ids: [parent.id], updates: { status: "in_review", force: true } }),
    });
    expect(response.status).toBe(200);
    expect(store.getIssue(parent.id)!.status).toBe("in_review");
    expect(allActivityRows(store, parent.id, "issue_status_forced")).toHaveLength(1);
  });
});

describe("MUL-400 E3 — fix round 4: atomic automatic start", () => {
  /** A parked dependent plus its in-progress prerequisite and one agent. */
  function parkedChain(name = "Round4") {
    const { store, runtime, agent } = storeWithAgent(name);
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Waiting",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    return { store, runtime, agent, prereq, dependent };
  }

  /**
   * The two internal seams an auto-start can fail at, expressed as the store
   * objects they live on. QA injected at "the activity write after the round was
   * built"; these cover that step plus the round creation and both activity
   * writes around it.
   */
  type Seams = {
    ctx: { appendIssueActivity(issueId: string, input: { type: string }): void };
    tasks: { createTaskWithinTransaction(input: unknown): unknown };
  };

  function seams(store: Store): Seams {
    return store as unknown as Seams;
  }

  /** Fail the first call matching `matches`; every later call goes through. */
  function injectOnce<T extends object>(
    target: T,
    method: keyof T,
    matches: (args: unknown[]) => boolean,
  ): () => void {
    const original = target[method] as unknown as (...args: unknown[]) => unknown;
    let fired = false;
    (target as Record<string, unknown>)[method as string] = (...args: unknown[]) => {
      if (!fired && matches(args)) {
        fired = true;
        throw new Error(`injected failure at ${String(method)}`);
      }
      return original.apply(target, args);
    };
    return () => { (target as Record<string, unknown>)[method as string] = original; };
  }

  it("starts a parked dependent and leaves exactly one queued round", () => {
    const { store, prereq, dependent } = parkedChain("happy");
    store.updateIssue(prereq.id, { status: "done" });

    // The plain path works, so the failure cases below are not trivially failing.
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(allTaskRows(store, dependent.id).map((row) => row.status)).toEqual(["queued"]);
    expect(allActivityRows(store, dependent.id, "dependency_auto_started")).toHaveLength(1);
  });

  it.each([
    ["while creating the round", "task", null],
    ["while writing issue_assigned", "activity", "issue_assigned"],
    ["while writing dependency_auto_started", "activity", "dependency_auto_started"],
  ] as const)("rolls the whole attempt back when a step fails %s", (_label, kind, type) => {
    const { store, prereq, dependent } = parkedChain(`inj_${type ?? kind}`);
    const target = seams(store);
    const restore = kind === "task"
      ? injectOnce(target.tasks, "createTaskWithinTransaction", () => true)
      : injectOnce(target.ctx, "appendIssueActivity", (args) => (args[1] as { type?: string })?.type === type);

    let thrown: Error | null = null;
    try {
      store.updateIssue(prereq.id, { status: "done" });
    } catch (err) {
      thrown = err as Error;
    }
    restore();

    // The attempt left nothing: the dependent is still waiting, it owns no task
    // row of ANY status, and the skip is recorded exactly once.
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    expect(allTaskRows(store, dependent.id)).toEqual([]);
    const skipped = allActivityRows(store, dependent.id, "dependency_auto_start_skipped");
    expect(skipped).toHaveLength(1);
    expect((skipped[0]!.data ?? {}) as Record<string, unknown>).toMatchObject({ reason: "dispatch_failed" });
    // No half-written activity from the failed attempt survived ...
    expect(allActivityRows(store, dependent.id, "dependency_auto_started")).toEqual([]);
    // ... the prerequisite's own transition is untouched ...
    expect(store.getIssue(prereq.id)!.status).toBe("done");
    // ... and the failure never reaches the caller as an exception: the
    // prerequisite's `done` must not be taken down by a dependent that cannot
    // start.
    expect(thrown).toBeNull();
  });

  it("does not claim a backlog issue that already has an active round", () => {
    const { store, runtime, agent, prereq, dependent } = parkedChain("boundary");
    // A structurally exempt round already holds the issue while it is parked:
    // the exemption is what lets a round exist on a `backlog` issue at all.
    const task = store.createTask({
      agentId: agent.id,
      issueId: dependent.id,
      prompt: "exempt round",
      attempt: 2,
      preserveIssueStatus: true,
    });
    expect(task.status).toBe("queued");
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");

    store.updateIssue(prereq.id, { status: "done" });

    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    const active = allTaskRows(store, dependent.id)
      .filter((row) => !["completed", "failed", "cancelled"].includes(row.status));
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(task.id);
    expect(allActivityRows(store, dependent.id, "dependency_auto_started")).toEqual([]);
    expect(allActivityRows(store, dependent.id, "dependency_auto_start_skipped")).toEqual([]);
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    expect(store.getIssue(dependent.id)!.status).toBe("in_progress");
  });

  it("keeps prerequisite completion successful when recording a skipped auto-start fails", async () => {
    const { store, prereq, dependent } = parkedChain("skip_write");
    const app = createMultiremiApp({ store });
    const target = seams(store);
    const restoreRound = injectOnce(target.tasks, "createTaskWithinTransaction", () => true);
    const restoreSkip = injectOnce(target.ctx, "appendIssueActivity", (args) =>
      (args[1] as { type?: string })?.type === "dependency_auto_start_skipped");
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await app.request(`/api/issues/${prereq.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      expect(response.status).toBe(200);
      expect(store.getIssue(prereq.id)!.status).toBe("done");
      expect(store.getIssue(dependent.id)!.status).toBe("backlog");
      expect(allTaskRows(store, dependent.id)).toEqual([]);
      expect(allActivityRows(store, dependent.id, "dependency_auto_start_skipped")).toEqual([]);
      expect(warnings.mock.calls).toHaveLength(1);
      expect(warnings.mock.calls.some((call) => String(call).includes("skip record failed"))).toBe(true);
    } finally {
      restoreRound();
      restoreSkip();
      warnings.mockRestore();
    }
  });

  it("lets a member move a satisfied backlog issue to todo without force and queues its agent", async () => {
    const { store, agent } = storeWithAgent("satisfied_patch");
    const prereq = store.createIssue({ title: "Done prerequisite", status: "done" });
    const dependent = store.createIssue({
      title: "Recoverable dependent", status: "backlog", blockedBy: [prereq.id],
      assigneeType: "agent", assigneeId: agent.id,
    });
    const app = createMultiremiApp({ store });
    const response = await app.request(`/api/issues/${dependent.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo" }),
    });
    expect(response.status).toBe(200);
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(allTaskRows(store, dependent.id).map((row) => row.status)).toEqual(["queued"]);
    expect(allActivityRows(store, dependent.id, "dependency_force_started")).toEqual([]);
  });

  it.each(["redispatch", "retry", "continuation", "delegation_return", "parent_wakeup"] as const)(
    "records one post-commit gate exemption for %s",
    (source) => {
      const { store, runtime, agent } = storeWithAgent(`exemption_${source}`);
      const prerequisite = store.createIssue({ title: "Open prerequisite", status: "in_progress" });
      const issue = store.createIssue({ title: "Earlier work", status: "in_progress" });
      const previous = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "earlier round" });
      if (source === "redispatch") store.cancelTask(previous.id);
      if (source === "retry") {
        expect(store.claimTask(runtime.id)?.id).toBe(previous.id);
        store.startTask(previous.id);
        store.failTask(previous.id, { error: "failed", failureReason: "unknown" });
      }
      store.createIssueDependency(issue.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
      store.updateIssue(issue.id, { status: "backlog" });

      const events: Array<{ type: string; persisted: number }> = [];
      const stop = store.onWorkspaceEvent((event) => {
        if (event.type === "activity:created"
          && (event.payload.entry as { action?: string })?.action === "dependency_gate_exempted") {
          events.push({ type: event.type, persisted: allActivityRows(store, issue.id, "dependency_gate_exempted").length });
        }
      });
      const task = store.createTask({
        agentId: agent.id, issueId: issue.id, prompt: `continue ${source}`,
        ...(source === "redispatch" || source === "retry" ? { attempt: 2, parentTaskId: previous.id } : {}),
        ...(source === "continuation" ? { continuedFromTaskId: previous.id } : {}),
        ...(source === "delegation_return" ? {
          delegationId: "dlg_exemption", delegatedByAgentId: agent.id, parentTaskId: previous.id,
        } : {}),
        ...(source === "parent_wakeup" ? { preserveIssueStatus: true, parentTaskId: previous.id } : {}),
      });
      stop();
      expect(store.getTask(task.id)?.status).toBe("queued");
      expect(allTaskRows(store, issue.id).some((row) => row.id === task.id)).toBe(true);
      const activities = allActivityRows(store, issue.id, "dependency_gate_exempted");
      expect(activities).toHaveLength(1);
      expect(activities[0]!.data).toMatchObject({
        source, taskId: task.id, task_id: task.id,
        previousTaskId: previous.id, previous_task_id: previous.id,
        unmet: [{ key: prerequisite.key }],
        unmetPrerequisites: [{ key: prerequisite.key }],
        unmet_prerequisites: [{ key: prerequisite.key }],
      });
      expect(events).toEqual([{ type: "activity:created", persisted: 1 }]);
    },
  );

  it("keeps a committed exempt task when its post-commit activity write fails", () => {
    const { store, agent, dependent } = parkedChain("exemption_write_failure");
    const restore = injectOnce(seams(store).ctx, "appendIssueActivity", (args) =>
      (args[1] as { type?: string })?.type === "dependency_gate_exempted");
    const warnings = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const task = store.createTask({
        agentId: agent.id, issueId: dependent.id, prompt: "continue", attempt: 2,
      });
      expect(task.status).toBe("queued");
      expect(allTaskRows(store, dependent.id)).toHaveLength(1);
      expect(allActivityRows(store, dependent.id, "dependency_gate_exempted")).toEqual([]);
      expect(warnings.mock.calls.some((call) => String(call).includes("post-commit issue activity failed"))).toBe(true);
    } finally {
      restore();
      warnings.mockRestore();
    }
  });

  it("records an actual automatic retry of a waiting issue", () => {
    const { store, runtime, agent } = storeWithAgent("actual_retry");
    const prerequisite = store.createIssue({ title: "Unfinished", status: "in_progress" });
    const issue = store.createIssue({ title: "Running work", status: "in_progress" });
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, prompt: "first attempt", maxAttempts: 2,
    });
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.createIssueDependency(issue.id, { dependsOnIssueId: prerequisite.id, type: "blocked_by" });
    store.updateIssue(issue.id, { status: "backlog" });
    store.failTask(first.id, { error: "runtime dropped", failureReason: "runtime_offline" });
    const retry = store.listTasksForIssue(issue.id).find((task) => task.id !== first.id)!;
    expect(retry.status).toBe("queued");
    const exempted = allActivityRows(store, issue.id, "dependency_gate_exempted");
    expect(exempted).toHaveLength(1);
    expect(exempted[0]!.data).toMatchObject({
      source: "retry", taskId: retry.id, previousTaskId: first.id,
      unmet: [{ key: prerequisite.key }],
    });
  });

  it("records no exemption for an issue outside waiting state", () => {
    const { store, agent } = storeWithAgent("not_waiting");
    const issue = store.createIssue({ title: "Ready", status: "todo" });
    store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "retry", attempt: 2 });
    expect(allActivityRows(store, issue.id, "dependency_gate_exempted")).toEqual([]);
  });

  it("emits issue:updated for the dependent with the new status", () => {
    const { store, prereq, dependent } = parkedChain("events");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    store.onWorkspaceEvent((event) => { events.push({ type: event.type, payload: event.payload }); });

    store.updateIssue(prereq.id, { status: "done" });

    const updated = events.filter((entry) => entry.type === "issue:updated"
      && (entry.payload as { issue?: { id?: string } }).issue?.id === dependent.id);
    expect(updated).toHaveLength(1);
    const payload = updated[0]!.payload as { issue: { status: string }; status_changed: boolean; prev_status: string };
    expect(payload.issue.status).toBe("todo");
    expect(payload.status_changed).toBe(true);
    expect(payload.prev_status).toBe("backlog");
    // The activity event is there too, and it is not a substitute for the
    // status event the frontend re-buckets from.
    expect(events.some((entry) => entry.type === "activity:created")).toBe(true);
  });

  it("emits no status event when the attempt rolls back", () => {
    const { store, prereq, dependent } = parkedChain("rollback_events");
    const restore = injectOnce(seams(store).ctx, "appendIssueActivity",
      (args) => (args[1] as { type?: string })?.type === "issue_assigned");
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    store.onWorkspaceEvent((event) => { events.push({ type: event.type, payload: event.payload }); });

    store.updateIssue(prereq.id, { status: "done" });
    restore();

    expect(events.filter((entry) => entry.type === "issue:updated"
      && (entry.payload as { issue?: { id?: string } }).issue?.id === dependent.id)).toEqual([]);
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
  });

  it("dispatches again through a public assign once an archived owner is restored", () => {
    const { store, prereq, dependent, agent } = parkedChain("archived_owner");
    db!.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), agent.id]);

    store.updateIssue(prereq.id, { status: "done" });

    // The failure left the retryable waiting state, with the skip recorded.
    expect(store.getIssue(dependent.id)!.status).toBe("backlog");
    expect(allTaskRows(store, dependent.id)).toEqual([]);
    expect(allActivityRows(store, dependent.id, "dependency_auto_start_skipped")).toHaveLength(1);

    // Fixing the owner makes the public assign route work — no force needed.
    db!.run("UPDATE multiremi_agents SET archived_at = NULL WHERE id = ?", [agent.id]);
    const assigned = store.assignIssue(dependent.id, { assigneeType: "agent", assigneeId: agent.id });
    expect(assigned.task?.id).toBeDefined();
    expect(store.getIssue(dependent.id)!.status).toBe("todo");
    expect(allTaskRows(store, dependent.id).map((row) => row.status)).toEqual(["queued"]);
  });
});

describe("MUL-400 E3 — fix round 4: native PATCH dependency errors", () => {
  function parked() {
    const { store, agent } = storeWithAgent("Patch4");
    const prereq = store.createIssue({ title: "Prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Waiting",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    return { store, prereq, dependent };
  }

  // QA's four spellings from the round-3 report: the plain status write and the
  // three request-body attempts to smuggle a parent-status override.
  const FORMS = [
    ["plain", { status: "todo" }],
    ["parentStatusForce", { status: "todo", parentStatusForce: true }],
    ["parent_status_force", { status: "todo", parent_status_force: true }],
    ["options.parentStatusForce", { status: "todo", options: { parentStatusForce: true } }],
  ] as const;

  it.each(FORMS)("answers 409 dependencies_unmet on both PATCH routes (%s)", async (_label, body) => {
    for (const path of ["/api/multiremi/issues", "/api/issues"]) {
      const { store, dependent } = parked();
      const app = createMultiremiApp({ store });
      const response = await app.request(`${path}/${dependent.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json() as { error?: string; code?: string };
      expect({ path, status: response.status }).toEqual({ path, status: 409 });
      expect({ path, code: payload.code }).toEqual({ path, code: "dependencies_unmet" });
      expect(String(payload.error ?? "")).toContain(dependent.key);
      // Nothing half-written: still waiting, no round, no force record.
      expect(store.getIssue(dependent.id)!.status).toBe("backlog");
      expect(allTaskRows(store, dependent.id)).toEqual([]);
      expect(allActivityRows(store, dependent.id, "dependency_force_started")).toEqual([]);
      expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
    }
  });
});

/**
 * MUL-409 QA round 4, blocker 1 — the forced start is one transaction.
 *
 * The QA finding: the status transaction committed first and the dispatch ran
 * afterwards, so a process that exited in between left the issue at `todo` with
 * no round and no automatic path back (auto-start only scans `backlog`). The
 * race ruling for the other half: when the force request takes the row lock
 * after the gate already opened, it crosses nothing, so it must leave an
 * ordinary member start and NOT a `dependency_force_started`.
 *
 * Invariant per attempt: exactly one task row (any status, cancelled included),
 * the issue leaves `backlog` exactly once, and exactly one of the three start
 * records exists — `dependency_auto_started`, `dependency_force_started`, or the
 * member's `issue_updated` backlog -> todo with no dependency start activity.
 */
describe("MUL-409 — fix round 5: forced start is one transaction", () => {
  function parked(name = "Force5") {
    const { store, runtime, agent } = storeWithAgent(name);
    const prereq = store.createIssue({ title: "Open prerequisite", status: "in_progress" });
    const dependent = store.createIssue({
      title: "Waiting",
      status: "backlog",
      blockedBy: [prereq.id],
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    return { store, runtime, agent, prereq, dependent };
  }

  /** The three start records, classified the way the ruling names them. */
  function classifyStart(store: Store, issueId: string): "auto" | "force" | "member" | "none" | "both" {
    const auto = allActivityRows(store, issueId, "dependency_auto_started").length;
    const force = allActivityRows(store, issueId, "dependency_force_started").length;
    const member = store.listIssueActivity(issueId).some((entry) => {
      if (entry.type !== "issue_updated") return false;
      const data = (entry.data ?? null) as Record<string, unknown> | null;
      // The activity row stores the member's request, so `status: "todo"` is the
      // durable trace of a member-driven backlog -> todo transition.
      return data?.status === "todo";
    });
    if (auto && force) return "both";
    if (auto) return "auto";
    if (force) return "force";
    if (member) return "member";
    return "none";
  }

  function expectSingleStart(store: Store, issueId: string, label: string) {
    expect({
      label,
      tasks: allTaskRows(store, issueId).length,
      start: classifyStart(store, issueId),
      status: store.getIssue(issueId)!.status,
    }).toEqual({ label, tasks: 1, start: expect.not.stringMatching(/^(none|both)$/) as unknown as string, status: "todo" });
  }

  it("commits the status, the force record, the assignment and the round together", () => {
    const { store, dependent } = parked("atomic_commit");
    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });
    expectSingleStart(store, dependent.id, "commit");
    // The dependency row stays: the issue runs *despite* an unmet prerequisite.
    expect(store.listUnmetPrerequisites(dependent.id)).toHaveLength(1);
    const types = store.listIssueActivity(dependent.id).map((entry) => entry.type);
    expect(types).toContain("dependency_force_started");
    expect(types).toContain("issue_assigned");
  });

  it.each(["status update", "task insert", "issue_assigned", "dependency_force_started"] as const)(
    "rolls the whole forced start back when %s fails",
    (step) => {
      const { store } = parked(`abort_${step.replace(/ /g, "_")}`);
      const prereq2 = store.createIssue({ title: "Open prerequisite", status: "in_progress" });
      const dependent = store.createIssue({
        title: `Abort ${step}`,
        status: "backlog",
        blockedBy: [prereq2.id],
        assigneeType: "agent",
        assigneeId: store.listAgents("local")[0]!.id,
      });

      let injected = false;
      const fail = (): never => { injected = true; throw new Error(`injected failure at ${step}`); };
      const restore: Array<() => void> = [];

      // Each patch replaces the real production step with one that throws once:
      // the SQLite handle for the status UPDATE (the store reaches it through
      // its own `db` reference, so the instance property shadows the prototype),
      // the task repository's in-transaction insert, and the Issue activity
      // writer.
      if (step === "status update") {
        const handle = db!;
        const original = handle.run;
        (handle as unknown as Record<string, unknown>).run = function patched(this: unknown, sql: string, ...rest: unknown[]) {
          if (!injected && String(sql).includes("UPDATE multiremi_issues") && String(sql).includes("title = ?")) fail();
          return (original as (...inner: unknown[]) => unknown).apply(this, [sql, ...rest]);
        };
        restore.push(() => { delete (handle as unknown as Record<string, unknown>).run; });
      } else if (step === "task insert") {
        const original = TasksRepo.prototype.createTaskWithinTransaction;
        TasksRepo.prototype.createTaskWithinTransaction = function patched(this: TasksRepo, ...args: unknown[]) {
          if (!injected) fail();
          return (original as (...inner: unknown[]) => unknown).apply(this, args);
        } as typeof TasksRepo.prototype.createTaskWithinTransaction;
        restore.push(() => { TasksRepo.prototype.createTaskWithinTransaction = original; });
      } else {
        const original = StoreContext.prototype.appendIssueActivity;
        StoreContext.prototype.appendIssueActivity = function patched(
          this: StoreContext,
          issueId: string,
          input: { type: string },
          queue?: CommitEventQueue,
        ) {
          if (!injected && input.type === step) fail();
          return original.call(this, issueId, input, queue);
        };
        restore.push(() => { StoreContext.prototype.appendIssueActivity = original; });
      }

      try {
        expect(() => store.updateIssue(dependent.id, {
          status: "todo", force: true, actorType: "member", actorId: "mem_local",
        })).toThrow(/injected failure/);
        expect(injected).toBe(true);
      } finally {
        for (const undo of restore.reverse()) undo();
      }

      // Back to the honest waiting state, with nothing half-written.
      expect({
        step,
        status: store.getIssue(dependent.id)!.status,
        tasks: allTaskRows(store, dependent.id),
        force: allActivityRows(store, dependent.id, "dependency_force_started"),
        assigned: allActivityRows(store, dependent.id, "issue_assigned"),
      }).toEqual({ step, status: "backlog", tasks: [], force: [], assigned: [] });
    },
  );

  it("keeps the status change and records a skip when the owner cannot run", () => {
    for (const kind of ["member", "none", "archived"] as const) {
      const { store, dependent, agent } = parked(`skip_${kind}`);
      if (kind === "member") {
        const member = store.listWorkspaceMembers("local")[0]!;
        db!.run("UPDATE multiremi_issues SET assignee_type = 'member', assignee_id = ? WHERE id = ?", [member.id, dependent.id]);
      } else if (kind === "none") {
        db!.run("UPDATE multiremi_issues SET assignee_type = NULL, assignee_id = NULL WHERE id = ?", [dependent.id]);
      } else {
        db!.run("UPDATE multiremi_agents SET archived_at = ? WHERE id = ?", [new Date().toISOString(), agent.id]);
      }

      store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });

      // Same durable shape as before: the member's transition stands, nothing is
      // queued, and the reason is recorded.
      expect({
        kind,
        status: store.getIssue(dependent.id)!.status,
        tasks: allTaskRows(store, dependent.id),
        force: allActivityRows(store, dependent.id, "dependency_force_started").length,
      }).toEqual({ kind, status: "todo", tasks: [], force: 1 });
      if (kind === "archived") {
        expect(allActivityRows(store, dependent.id, "dispatch_skipped").at(-1)!.data)
          .toMatchObject({ reason: "force_start_dispatch_failed" });
      }
    }
  });

  /**
   * The race ruling: the gate is already open when the force request takes the
   * lock. The request crosses nothing, so it must NOT claim an override — the
   * member's own `issue_updated` is the single start record, and no dependency
   * start activity is written.
   */
  it("records an ordinary member start when every prerequisite is already done", () => {
    const { store, prereq, dependent } = parked("gate_open");
    // Satisfy the prerequisite before the force request, so the gate is open.
    db!.run("UPDATE multiremi_issues SET status = 'done' WHERE id = ?", [prereq.id]);
    expect(store.listUnmetPrerequisites(dependent.id)).toEqual([]);

    store.updateIssue(dependent.id, { status: "todo", force: true, actorType: "member", actorId: "mem_local" });

    expectSingleStart(store, dependent.id, "gate-already-open");
    expect(allActivityRows(store, dependent.id, "dependency_force_started")).toEqual([]);
    expect(allActivityRows(store, dependent.id, "dependency_auto_started")).toEqual([]);
    // The member's own transition is the record that survives: the store writes
    // `issue_updated` as the actor's own request (status, force, actor), which is
    // the third start kind this ruling names.
    const updated = allActivityRows(store, dependent.id, "issue_updated");
    expect(updated.some((entry) => entry.data?.status === "todo" && entry.data?.force === true)).toBe(true);
  });
});
