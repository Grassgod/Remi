// MUL-400 S1 (E1 + E2): a parent issue's status is derived from its children,
// and every child ending reports to the parent owner.
//
// E1: a parent with unfinished children cannot enter `in_review`/`done` — the
// direct write path answers 409 `issue_status_held`, the task-terminal path is
// rewritten to `in_progress`, and a child event pulls an `in_review` parent back.
// E2: done / failed / blocked / cancelled all reach the parent owner, and a busy
// owner coalesces several reports into one queued round.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

type Store = ReturnType<typeof createStore>;

/** Issue activity rows with their free-form `data` narrowed for assertions. */
function activityOf(store: Store, issueId: string, type: string): Array<{ data: Record<string, unknown> | null }> {
  return store.listIssueActivity(issueId)
    .filter((entry) => entry.type === type)
    .map((entry) => ({ data: (entry.data ?? null) as Record<string, unknown> | null }));
}

/** Claim + start one specific task, whatever else is queued for the runtime. */
function runTask(store: Store, runtimeId: string, taskId: string) {
  let claimed = store.claimTask(runtimeId);
  while (claimed && claimed.id !== taskId) claimed = store.claimTask(runtimeId);
  if (!claimed) throw new Error(`Could not claim task ${taskId}`);
  return store.startTask(taskId);
}

function catchError(fn: () => unknown): Error & { code?: string; details?: { openChildren?: number } } {
  try {
    fn();
  } catch (err) {
    return err as Error & { code?: string; details?: { openChildren?: number } };
  }
  throw new Error("expected the call to throw");
}

describe("MUL-400 E1 — parent status derived from children", () => {
  it("holds a parent at in_progress when the task path derives in_review with open children", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_parent", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Parent owner", provider: "claude", runtimeId: runtime.id });
    const parent = store.createIssue({
      title: "Parent with open children",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.createIssue({ title: "Open child", parentIssueId: parent.id, status: "in_progress" });

    const task = store.createTask({ agentId: agent.id, issueId: parent.id, prompt: "do the parent work" });
    runTask(store, runtime.id, task.id);
    store.completeTask(task.id, { output: "parent round finished" });

    // Guard B: the derived in_review is rewritten, and the override is auditable.
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    const held = activityOf(store, parent.id, "parent_status_held");
    expect(held).toHaveLength(1);
    expect(held[0]?.data).toMatchObject({ requested: "in_review", openChildren: 1 });
  });

  it("rejects a direct in_review/done write while children are open and reports the count", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const parent = store.createIssue({ title: "Guarded parent", status: "in_progress" });
    const [first, second] = [
      store.createIssue({ title: "Child A", parentIssueId: parent.id, status: "in_progress" }),
      store.createIssue({ title: "Child B", parentIssueId: parent.id, status: "blocked" }),
    ];

    for (const status of ["in_review", "done"] as const) {
      const error = catchError(() => store.updateIssue(parent.id, { status }));
      expect(error.message, status).toContain("unfinished child issue");
      expect(error.code, status).toBe("issue_status_held");
      expect(error.details?.openChildren, status).toBe(2);
      expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    }

    // A blocked child counts as unfinished: closing the others is not enough.
    store.updateIssue(first!.id, { status: "done" });
    expect(catchError(() => store.updateIssue(parent.id, { status: "in_review" })).details?.openChildren).toBe(1);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");

    // With every child closed the guard stops applying.
    store.updateIssue(second!.id, { status: "cancelled" });
    expect(store.updateIssue(parent.id, { status: "in_review" }).status).toBe("in_review");
  });

  it("derives an in_review parent back to in_progress when a child changes, and never moves done/cancelled", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const parent = store.createIssue({ title: "Deriving parent", status: "in_review" });
    const child = store.createIssue({ title: "Late child", parentIssueId: parent.id, status: "in_progress" });

    store.updateIssue(child.id, { status: "blocked" });
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    const derived = activityOf(store, parent.id, "parent_status_derived");
    expect(derived).toHaveLength(1);
    expect(derived[0]?.data).toMatchObject({
      previousStatus: "in_review",
      status: "in_progress",
      openChildren: 1,
    });

    // A further child event with the parent already in_progress is a no-op.
    store.updateIssue(child.id, { status: "in_progress" });
    expect(activityOf(store, parent.id, "parent_status_derived")).toHaveLength(1);

    // done / cancelled parents are human decisions and never move automatically.
    for (const status of ["done", "cancelled"] as const) {
      const terminalParent = store.createIssue({ title: `Terminal ${status} parent`, status });
      const lateChild = store.createIssue({
        title: `Late child of ${status}`,
        parentIssueId: terminalParent.id,
        status: "in_progress",
      });
      store.updateIssue(lateChild.id, { status: "done" });
      expect(store.getIssue(terminalParent.id)?.status, status).toBe(status);
      expect(activityOf(store, terminalParent.id, "parent_status_derived")).toHaveLength(0);
    }
  });

  it("lets a member force the guard and audits it, while refusing a task identity on every writer", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Frozen owner", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Owner", role: "member" });
    const parent = store.createIssue({
      title: "Force parent",
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });
    store.createIssue({ title: "Open child", parentIssueId: parent.id, status: "in_progress" });

    // The member path succeeds only with force, and leaves an audit record.
    expect(catchError(() => store.updateIssue(parent.id, { status: "done" })).code).toBe("issue_status_held");
    expect(store.updateIssue(parent.id, { status: "done", force: true }).status).toBe("done");
    const forced = activityOf(store, parent.id, "issue_status_forced");
    expect(forced).toHaveLength(1);
    expect(forced[0]?.data).toMatchObject({ status: "done", openChildren: 1 });

    // The same fields through the API: a task identity is refused, a member is not.
    const otherParent = store.createIssue({ title: "Task identity parent", status: "in_progress" });
    store.createIssue({ title: "Task identity child", parentIssueId: otherParent.id, status: "in_progress" });
    const callerTask = store.createTask({ agentId: agent.id, prompt: "caller" });
    const credential = await store.createTaskAccessToken(callerTask, "local");
    const app = createMultiremiApp({ store });
    for (const path of [`/api/multiremi/issues/${otherParent.id}`, `/api/issues/${otherParent.id}`]) {
      const response = await app.request(path, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", force: true }),
      });
      expect(response.status, path).toBe(403);
      expect((await response.json()).code).toBe("issue_force_requires_member");
    }
    const batch = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [otherParent.id], updates: { status: "done", force: true } }),
    });
    expect(batch.status).toBe(403);
    expect(store.getIssue(otherParent.id)?.status).toBe("in_progress");

    // A4: without force, a task identity still cannot close a parent with children.
    const plainDone = await app.request(`/api/issues/${otherParent.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(plainDone.status).toBe(403);
    expect((await plainDone.json()).code).toBe("parent_done_requires_member");

    // A member using the same route gets the 409 reason plus the override.
    const memberCredential = await store.createAccessToken({
      name: "Owner PAT",
      type: "pat",
      workspaceId: "local",
      userId: "local",
    });
    const memberAttempt = await app.request(`/api/multiremi/issues/${otherParent.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${memberCredential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_review" }),
    });
    expect(memberAttempt.status).toBe(409);
    expect(await memberAttempt.json()).toMatchObject({
      code: "issue_status_held",
      reason: "children_open",
      open_children: 1,
    });
    const memberForced = await app.request(`/api/multiremi/issues/${otherParent.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${memberCredential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "in_review", force: true }),
    });
    expect(memberForced.status).toBe(200);
    expect(store.getIssue(otherParent.id)?.status).toBe("in_review");
  });

  it("applies the A1 final-summary rule to agent owners but not to member owners", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_summary", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Summary owner", provider: "claude", runtimeId: runtime.id });
    const parent = store.createIssue({
      title: "Summary parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({ title: "Only child", parentIssueId: parent.id, status: "in_progress" });
    store.updateIssue(child.id, { status: "done" });

    // No result-bearing round since the child closed: `done` is refused.
    expect(catchError(() => store.updateIssue(parent.id, { status: "done" })).code).toBe("final_summary_missing");

    // Finish the report round E2 queued for the owner; its result is the
    // "final summary" signal A1 looks for.
    const round = store.listTasksForIssue(parent.id).find((task) => task.status === "queued")!;
    runTask(store, runtime.id, round.id);
    store.completeTask(round.id, { output: "the last child is merged and verified" });
    expect(store.updateIssue(parent.id, { status: "done" }).status).toBe("done");

    // A member owner needs no machine-checked summary.
    const member = store.createWorkspaceMember({ name: "Human owner", role: "member" });
    const memberParent = store.createIssue({
      title: "Member summary parent",
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });
    const memberChild = store.createIssue({
      title: "Member child",
      parentIssueId: memberParent.id,
      status: "in_progress",
    });
    expect(catchError(() => store.updateIssue(memberParent.id, { status: "done" })).code).toBe("issue_status_held");
    store.updateIssue(memberChild.id, { status: "done" });
    expect(store.updateIssue(memberParent.id, { status: "done" }).status).toBe("done");
  });

  it("does not park a parent at todo when a member closes a child by hand", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Parent owner", provider: "codex" });
    const parent = store.createIssue({
      title: "In-review parent",
      status: "in_review",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({ title: "Manual child", parentIssueId: parent.id, status: "in_progress" });
    // A second child stays open, so the parent is still mid-flight when the
    // wakeup round is created — the case that used to reset it to todo.
    store.createIssue({ title: "Still open child", parentIssueId: parent.id, status: "in_progress" });

    store.updateIssue(child.id, { status: "done" });

    // The wakeup round exists and the parent stays open rather than going to todo.
    const tasks = store.listTasksForIssue(parent.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("queued");
    expect(store.getIssue(parent.id)?.status).not.toBe("todo");
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
  });
});

describe("MUL-400 E2 — child endings notify the parent owner", () => {
  it("notifies an agent owner for all four endings, distinguishing failed from a human block", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_notify", name: "Worker", provider: "claude", maxConcurrency: 8 });
    const agent = store.createAgent({ name: "Notified owner", provider: "claude", runtimeId: runtime.id });
    const parent = store.createIssue({
      title: "Notification parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    const cases: Array<{ outcome: string; issueId: string; apply: () => void }> = [];
    // The task-failure ending runs first: the parent wakeup round it queues would
    // otherwise be the natural target of `runTask`'s claim loop.
    const failingChild = store.createIssue({
      title: "Child failed",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    cases.push({
      outcome: "failed",
      issueId: failingChild.id,
      apply: () => {
        const task = store.createTask({ agentId: agent.id, issueId: failingChild.id, prompt: "explode" });
        runTask(store, runtime.id, task.id);
        store.failTask(task.id, { error: "boom" });
      },
    });
    for (const [label, status] of [["done", "done"], ["cancelled", "cancelled"], ["blocked", "blocked"]] as const) {
      const child = store.createIssue({
        title: `Child ${label}`,
        parentIssueId: parent.id,
        status: "in_progress",
      });
      cases.push({ outcome: label, issueId: child.id, apply: () => store.updateIssue(child.id, { status }) });
    }

    for (const testCase of cases) {
      const before = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system").length;
      testCase.apply();
      const comments = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system");
      expect(comments.length, testCase.outcome).toBe(before + 1);
      const latest = comments.at(-1)!;
      expect(latest.body, testCase.outcome).toContain(`mention://agent/${agent.id}`);

      const notification = store.listIssueActivity(parent.id)
        .filter((entry) => entry.type === "comment_created")
        .map((entry) => entry.data as Record<string, unknown> | null)
        .filter((data) => data?.outcome !== undefined)
        .at(-1);
      expect(notification, testCase.outcome).toMatchObject({ outcome: testCase.outcome });
    }

    // Four reports, one pending round: the owner wakes once for the batch.
    const parentTasks = store.listTasksForIssue(parent.id);
    expect(parentTasks).toHaveLength(1);
    expect(parentTasks[0]).toMatchObject({ agentId: agent.id, status: "queued" });
    expect(activityOf(store, parent.id, "child_done_parent_triggered")).toHaveLength(1);
    expect(activityOf(store, parent.id, "child_status_parent_coalesced")).toHaveLength(3);
    // The first report is the round's own subject; the rest append onto it.
    expect(parentTasks[0]?.prompt).toContain("reported failed");
    expect(parentTasks[0]?.prompt.match(/## Additional Sub-Issue Report/g)).toHaveLength(3);
  });

  it("files a child_issue_terminal inbox item for a member owner with the right severity", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const member = store.createWorkspaceMember({ name: "Human owner", role: "member" });
    const parent = store.createIssue({
      title: "Human parent",
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });

    const severities: Array<[string, string, string]> = [];
    for (const status of ["done", "cancelled", "blocked"] as const) {
      const child = store.createIssue({ title: `Human child ${status}`, parentIssueId: parent.id, status: "in_progress" });
      store.updateIssue(child.id, { status });
      severities.push([status, status === "done" || status === "cancelled" ? "info" : "warning", child.id]);
    }

    const items = store.listInboxItems(member.id).filter((item) => item.type === "child_issue_terminal");
    expect(items).toHaveLength(3);
    for (const [status, severity, childId] of severities) {
      const item = items.find(
        (candidate) => (candidate.details as Record<string, unknown> | null | undefined)?.childIssueId === childId,
      );
      expect(item, status).toBeDefined();
      expect(item?.severity, status).toBe(severity);
      expect(item?.issueId).toBe(parent.id);
    }

    // A human owner never gets a wakeup round or a parent system comment.
    expect(store.listTasksForIssue(parent.id)).toHaveLength(0);
    expect(store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system")).toHaveLength(0);
  });

  it("coalesces several child endings into one queued round while the owner is busy", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const leader = store.createAgent({ name: "Busy leader", provider: "claude" });
    const squad = store.createSquad({ name: "Busy squad", leaderId: leader.id });
    const parent = store.createIssue({
      title: "Busy parent",
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const running = store.createTask({ agentId: leader.id, issueId: parent.id, prompt: "current round" });
    db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [running.id]);

    const children = ["done", "failed", "blocked", "cancelled"].map((status) =>
      store.createIssue({ title: `Ending ${status}`, parentIssueId: parent.id, status: "in_progress" })
    );
    const [doneChild, blockedChild] = [children[0]!, children[2]!];
    store.updateIssue(doneChild.id, { status: "done" });

    const queuedAfterFirst = store.listTasksForIssue(parent.id).filter((task) => task.status === "queued");
    expect(queuedAfterFirst).toHaveLength(1);
    expect(activityOf(store, parent.id, "child_done_parent_triggered")).toHaveLength(1);
    // The retired skip reason must never appear again.
    expect(activityOf(store, parent.id, "child_done_parent_skipped")).toHaveLength(0);

    for (const child of [children[1]!, blockedChild, children[3]!]) {
      store.updateIssue(child.id, { status: "blocked" });
    }

    const queued = store.listTasksForIssue(parent.id).filter((task) => task.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.id).toBe(queuedAfterFirst[0]?.id);
    expect(queued[0]?.prompt).toContain("## Additional Sub-Issue Report");
    expect(queued[0]?.prompt).toContain("Outcome: blocked");
    expect(activityOf(store, parent.id, "child_status_parent_coalesced")).toHaveLength(3);

    // Every report still reached the parent as its own notification comment.
    const notifications = store.listIssueActivity(parent.id)
      .filter((entry) => entry.type === "comment_created")
      .map((entry) => entry.data as Record<string, unknown> | null)
      .filter((data) => data?.outcome !== undefined);
    expect(notifications).toHaveLength(4);
  });

  it("keeps the no-assignee comment and skip record, and reaches subscribers", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const subscriber = store.createWorkspaceMember({ name: "Watcher", role: "member" });
    const parent = store.createIssue({ title: "Unassigned parent", status: "in_progress" });
    store.addIssueSubscriber(parent.id, subscriber.id, "manual");
    const child = store.createIssue({ title: "Unassigned child", parentIssueId: parent.id, status: "in_progress" });

    store.updateIssue(child.id, { status: "blocked" });

    expect(store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system")).toHaveLength(1);
    expect(activityOf(store, parent.id, "child_done_parent_skipped")[0]?.data).toMatchObject({
      reason: "no_assignee",
      outcome: "blocked",
    });
    const items = store.listInboxItems(subscriber.id).filter((item) => item.type === "child_issue_terminal");
    expect(items).toHaveLength(1);
    expect(items[0]?.severity).toBe("warning");
    expect(items[0]?.details).toMatchObject({ outcome: "blocked", noAssignee: true } as Record<string, unknown>);
  });
});
