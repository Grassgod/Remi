/**
 * MUL-400 S1: every path the parent-status work touches must reach the database
 * with a transaction depth of at most 1.
 *
 * `PostgresSyncDatabase.transaction()` is a bare BEGIN/COMMIT with no savepoint
 * support, so a nested `transaction()` commits the outer one early, releases its
 * locks, and makes the outer ROLLBACK a no-op. The store's convention is that
 * the outermost caller owns the only transaction and everything inside it uses a
 * `...WithinTransaction` variant. This file wraps `db.transaction` in a depth
 * counter and asserts that ceiling for each entry point, plus the atomicity of
 * the E2 hook itself.
 *
 * The counters run on both backends: SQLite here, and the same assertions run
 * against real Postgres when `MULTIREMI_TEST_POSTGRES_URL` points at one (the
 * PG suite imports this file's helpers, see `multiremi-postgres-tx-depth`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

type Store = ReturnType<typeof createStore>;

/**
 * Count nested `transaction()` calls on a database handle. The store's own
 * database is a write-invalidating proxy whose `transaction` forwards to the
 * target on every read, so wrapping the target observes every call the store
 * makes, including the ones that start from a repo.
 */
export function transactionDepthCounter(database: unknown): { max: number; reset(): void } {
  const target = database as { transaction: (fn: (...args: never[]) => unknown) => (...args: unknown[]) => unknown };
  const original = target.transaction;
  const counter = {
    max: 0,
    reset() { counter.max = 0; },
  };
  let depth = 0;
  target.transaction = (fn: (...args: never[]) => unknown) => {
    const run = original.call(target, fn);
    return (...args: unknown[]) => {
      depth += 1;
      counter.max = Math.max(counter.max, depth);
      try {
        return run(...args);
      } finally {
        depth -= 1;
      }
    };
  };
  return counter;
}

/**
 * The counter must wrap the handle the store actually built with. The store
 * facade keeps its proxy in a private field that request-read-cache re-wraps, so
 * the tests count the target sqlite handle the helper created instead — same
 * call tree one `transaction()` layer down.
 */
function wrapStore(store: Store): { max: number; reset(): void } {
  return transactionDepthCounter(db);
}

export function setupDepthStore() {
  const store = createStore();
  store.ensureLocalWorkspace();
  const runtime = store.registerRuntime({
    id: "rt_depth",
    name: "Depth worker",
    provider: "claude",
    maxConcurrency: 8,
  });
  const agent = store.createAgent({ name: "Depth owner", provider: "claude", runtimeId: runtime.id });
  return { store, runtime, agent };
}

export function runTask(store: Store, runtimeId: string, taskId: string) {
  let claimed = store.claimTask(runtimeId);
  while (claimed && claimed.id !== taskId) claimed = store.claimTask(runtimeId);
  if (!claimed) throw new Error(`Could not claim task ${taskId}`);
  return store.startTask(taskId);
}

function busyParent(store: Store, agentId: string, title: string) {
  const parent = store.createIssue({
    title,
    status: "in_progress",
    assigneeType: "agent",
    assigneeId: agentId,
  });
  const running = store.createTask({ agentId, issueId: parent.id, prompt: "current round" });
  db!.run("UPDATE multiremi_tasks SET status = 'running' WHERE id = ?", [running.id]);
  return parent;
}

describe("MUL-400 S1 transaction depth — issue write paths", () => {
  for (const status of ["done", "blocked", "cancelled"] as const) {
    it(`keeps updateIssue(child -> ${status}) at depth 1 when the owner is free`, () => {
      const { store, agent } = setupDepthStore();
      const parent = store.createIssue({
        title: `Free parent ${status}`,
        status: "in_progress",
        assigneeType: "agent",
        assigneeId: agent.id,
      });
      const child = store.createIssue({ title: `Child ${status}`, parentIssueId: parent.id, status: "in_progress" });
      const counter = wrapStore(store);
      counter.reset();
      store.updateIssue(child.id, { status });
      expect(counter.max).toBe(1);
      // The report still landed as exactly one queued round.
      expect(store.listTasksForIssue(parent.id).filter((task) => task.status === "queued")).toHaveLength(1);
    });

    it(`keeps updateIssue(child -> ${status}) at depth 1 when the owner is busy`, () => {
      const { store, agent } = setupDepthStore();
      const parent = busyParent(store, agent.id, `Busy parent ${status}`);
      const child = store.createIssue({ title: `Busy child ${status}`, parentIssueId: parent.id, status: "in_progress" });
      const counter = wrapStore(store);
      counter.reset();
      store.updateIssue(child.id, { status });
      expect(counter.max).toBe(1);
      expect(store.listTasksForIssue(parent.id).filter((task) => task.status === "queued")).toHaveLength(1);
    });
  }

  it("keeps the in_review-parent re-derivation for a new child at depth 1", () => {
    const { store } = setupDepthStore();
    const parent = store.createIssue({ title: "Review parent", status: "in_review" });
    const counter = wrapStore(store);
    counter.reset();
    store.createIssue({ title: "New child", parentIssueId: parent.id, status: "todo" });
    expect(counter.max).toBeLessThanOrEqual(1);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    expect(store.listIssueActivity(parent.id).filter((entry) => entry.type === "parent_status_derived"))
      .toHaveLength(1);
  });

  it("keeps the re-derivation on a new child and on a re-parented child at depth 1", () => {
    const { store } = setupDepthStore();
    const parent = store.createIssue({ title: "Derive parent", status: "in_review" });
    const counter = wrapStore(store);

    // A child created under an in_review parent pushes it back. `createIssue`
    // is a single INSERT that re-derives inline, so it needs no transaction of
    // its own; the ceiling is what matters here.
    counter.reset();
    const child = store.createIssue({ title: "Late child", parentIssueId: parent.id, status: "in_progress" });
    expect(counter.max, "createIssue").toBeLessThanOrEqual(1);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");

    // Another child stays behind, so the parent still has open work. Put it back
    // in review (a member decision, so `force`), then move the first child to a
    // different parent: BOTH parents re-derive — the new one because a child
    // arrived, the old one because its remaining child set is still open.
    const stayBehind = store.createIssue({
      title: "Stays behind",
      parentIssueId: parent.id,
      status: "in_progress",
    });
    store.updateIssue(parent.id, { status: "in_review", force: true });
    expect(store.getIssue(parent.id)?.status).toBe("in_review");
    const second = store.createIssue({ title: "Second parent", status: "in_review" });
    counter.reset();
    store.updateIssue(child.id, { parentIssueId: second.id });
    expect(counter.max, "re-parent").toBe(1);
    expect(store.getIssue(parent.id)?.status, "old parent").toBe("in_progress");
    expect(store.getIssue(second.id)?.status, "new parent").toBe("in_progress");
    expect(store.getIssue(stayBehind.id)?.parentIssueId).toBe(parent.id);
  });
});

describe("MUL-400 S1 transaction depth — task terminal paths", () => {
  it("keeps completeTask, failTask and cancelTask at depth 1", () => {
    const { store, runtime, agent } = setupDepthStore();
    const parent = store.createIssue({
      title: "Terminal depth parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const counter = wrapStore(store);

    const completingChild = store.createIssue({
      title: "Completing child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const completing = store.createTask({ agentId: agent.id, issueId: completingChild.id, prompt: "finish" });
    runTask(store, runtime.id, completing.id);
    counter.reset();
    store.completeTask(completing.id, { output: "finished" });
    expect(counter.max, "completeTask").toBe(1);

    const failingChild = store.createIssue({
      title: "Failing child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const failing = store.createTask({ agentId: agent.id, issueId: failingChild.id, prompt: "explode" });
    runTask(store, runtime.id, failing.id);
    counter.reset();
    store.failTask(failing.id, { error: "boom" });
    expect(counter.max, "failTask").toBe(1);
    // A task failure ends the child on `blocked`, so the E2 hook really ran.
    expect(store.getIssue(failingChild.id)?.status).toBe("blocked");

    const cancellingChild = store.createIssue({
      title: "Cancelling child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const cancelling = store.createTask({ agentId: agent.id, issueId: cancellingChild.id, prompt: "cancel me" });
    counter.reset();
    store.cancelTask(cancelling.id);
    expect(counter.max, "cancelTask").toBe(1);
  });

  it("keeps the WHOLE task lifecycle at depth 1, counter armed before createTask", () => {
    const { store, runtime, agent } = setupDepthStore();
    const parent = store.createIssue({
      title: "Lifecycle parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({
      title: "Lifecycle child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const counter = wrapStore(store);

    // QA round 3: arm the counter BEFORE createTask. createTask derives the
    // child's Issue to `todo` and startTask derives it back to `in_progress`;
    // both used to run the E1/E2 hook inline inside their own transaction.
    counter.reset();
    const task = store.createTask({ agentId: agent.id, issueId: child.id, prompt: "lifecycle" });
    expect(counter.max, "createTask").toBe(1);
    expect(store.getIssue(child.id)?.status).toBe("todo");

    let claimed = store.claimTask(runtime.id);
    while (claimed && claimed.id !== task.id) claimed = store.claimTask(runtime.id);
    counter.reset();
    store.startTask(task.id);
    expect(counter.max, "startTask").toBe(1);
    expect(store.getIssue(child.id)?.status).toBe("in_progress");

    counter.reset();
    store.completeTask(task.id, { output: "lifecycle done" });
    expect(counter.max, "completeTask").toBe(1);
  });

  it("keeps the remaining task-lifecycle writers at depth 1", () => {
    const { store, runtime, agent } = setupDepthStore();
    const counter = wrapStore(store);

    // createTaskHumanRequest parks the Issue at in_review (guard B exempt).
    const askParent = store.createIssue({
      title: "Ask parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const askChild = store.createIssue({
      title: "Ask child",
      parentIssueId: askParent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const askTask = store.createTask({ agentId: agent.id, issueId: askChild.id, prompt: "ask" });
    runTask(store, runtime.id, askTask.id);
    counter.reset();
    const request = store.createTaskHumanRequest({
      taskId: askTask.id,
      kind: "question",
      payload: { question: "which one?" },
    });
    expect(counter.max, "createTaskHumanRequest").toBe(1);
    expect(store.getIssue(askChild.id)?.status).toBe("in_review");

    counter.reset();
    store.respondTaskHumanRequest(request.id, { response: { answer: "that one" } });
    expect(counter.max, "respondTaskHumanRequest").toBe(1);

    counter.reset();
    store.expireTaskHumanRequest(request.id, "timeout");
    expect(counter.max, "expireTaskHumanRequest").toBeLessThanOrEqual(1);

    // A comment mention dispatches through the same creation entry point.
    const dispatchParent = store.createIssue({
      title: "Dispatch parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const dispatchChild = store.createIssue({
      title: "Dispatch child",
      parentIssueId: dispatchParent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    counter.reset();
    store.createIssueComment(dispatchChild.id, {
      authorType: "member",
      authorId: "local",
      body: `[@${agent.id}](mention://agent/${agent.id}) please continue`,
    });
    expect(counter.max, "comment dispatch").toBe(1);
  });

  it("keeps cancelTasksByTriggerComments and recoverOrphans at depth 1", () => {
    const { store, runtime, agent } = setupDepthStore();
    const parent = store.createIssue({
      title: "Sweep depth parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({
      title: "Sweep depth child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const comment = store.createIssueComment(child.id, { authorType: "member", authorId: "local", body: "go" });
    const triggered = store.createTask({
      agentId: agent.id,
      issueId: child.id,
      runtimeId: runtime.id,
      triggerCommentId: comment.id,
      prompt: "triggered",
    });
    const counter = wrapStore(store);

    counter.reset();
    store.cancelTasksByTriggerComments("local", [comment.id]);
    expect(counter.max, "cancelTasksByTriggerComments").toBe(1);
    expect(store.getTask(triggered.id)?.status).toBe("cancelled");

    const orphan = store.createTask({ agentId: agent.id, issueId: child.id, runtimeId: runtime.id, prompt: "orphan" });
    store.claimTask(runtime.id);
    counter.reset();
    store.recoverOrphans(runtime.id);
    expect(counter.max, "recoverOrphans").toBe(1);
    expect(store.getTask(orphan.id)?.status).toBe("failed");
  });
});

describe("MUL-400 S1 transaction depth — organizer actions", () => {
  it("keeps the organizer cancel and redispatch actions at depth 1", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const owner = store.createWorkspaceMember({
      id: "mem_owner",
      workspaceId: "local",
      userId: "owner",
      name: "Owner",
      role: "owner",
    });
    const runtime = store.registerRuntime({
      id: "rt_org_depth",
      name: "Organizer runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const supervisor = store.createAgent({
      name: "Organizer depth",
      provider: "codex",
      workspaceId: "local",
      ownerId: owner.userId ?? owner.id,
      role: "supervisor",
    });
    const worker = store.createAgent({
      name: "Worker depth",
      provider: "codex",
      workspaceId: "local",
      ownerId: owner.userId ?? owner.id,
    });
    store.updateWorkspace("local", { settings: { organizer: { mode: "act" } } });
    const patrol = store.createIssue({ title: "Organizer patrol depth", workspaceId: "local" });
    const supervisorTask = store.createTask({
      agentId: supervisor.id,
      issueId: patrol.id,
      workspaceId: "local",
      prompt: "patrol",
    });
    const parent = store.createIssue({
      title: "Organizer target parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: worker.id,
    });
    const child = store.createIssue({
      title: "Organizer target child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: worker.id,
    });
    const target = store.createTask({
      agentId: worker.id,
      issueId: child.id,
      runtimeId: runtime.id,
      workspaceId: "local",
      prompt: "target",
    });
    const counter = wrapStore(store);

    counter.reset();
    store.performOrganizerAction({
      supervisorTaskId: supervisorTask.id,
      supervisorAgentId: supervisor.id,
      targetTaskId: target.id,
      action: "cancel",
      reason: "depth probe",
    });
    expect(counter.max, "organizer cancel").toBe(1);

    const secondTarget = store.createTask({
      agentId: worker.id,
      issueId: child.id,
      runtimeId: runtime.id,
      workspaceId: "local",
      prompt: "target 2",
    });
    counter.reset();
    store.performOrganizerAction({
      supervisorTaskId: supervisorTask.id,
      supervisorAgentId: supervisor.id,
      targetTaskId: secondTarget.id,
      action: "redispatch",
      reason: "depth probe",
    });
    expect(counter.max, "organizer redispatch").toBe(1);
  });
});

describe("MUL-400 S1 transaction depth — SCM merge completion", () => {
  /** A real SCM connection in the `local` workspace, as scm-store.test.ts seeds it. */
  function seedScm(store: Store) {
    process.env.MULTIREMI_SCM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    store.updateWorkspace("local", {
      repos: [{
        id: "repo_widgets",
        name: "widgets",
        url: "git@github.com:acme/widgets.git",
        source: "github",
        default_branch: "main",
      }],
      settings: { scm_auto_link_enabled: true, scm_complete_issue_on_merge_enabled: true },
    });
    return store.createScmConnection({
      workspaceId: "local",
      name: "GitHub depth",
      provider: "github",
      mode: "hybrid",
      accessToken: "ghp_depth_token",
      webhookSecret: "depth-webhook-secret",
      repositoryIds: ["repo_widgets"],
    });
  }

  function projectChangeRequest(store: Store, connectionId: string, title: string) {
    store.advanceScmEntitySnapshot({
      connectionId,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "42",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v-42",
      contentHash: "change-42",
      payload: {
        number: 42,
        title,
        state: "merged",
        source_branch: "agent/depth",
        url: "https://github.com/acme/widgets/pull/42",
      },
    });
  }

  function recordMerge(store: Store, connectionId: string, logicalKey: string) {
    return store.recordScmCanonicalEvent({
      workspaceId: "local",
      connectionId,
      repositoryId: "repo_widgets",
      type: "change.merged",
      subjectType: "change_request",
      subjectId: "42",
      logicalKey,
      fidelity: "inferred",
      payload: { id: "provider-change-42", number: 42, branch: "main", mergeSha: "abc" },
      evidence: { source: "poll", dedupeKey: `poll:${logicalKey}`, providerEventId: null },
    });
  }

  it("keeps the held branch (children still open) at depth 1", () => {
    const { store } = setupDepthStore();
    const connection = seedScm(store);
    const parent = store.createIssue({ title: "SCM held parent", workspaceId: "local" });
    store.updateIssue(parent.id, { status: "in_progress" });
    store.createIssue({ title: "Running child", parentIssueId: parent.id, status: "in_progress" });
    projectChangeRequest(store, connection.id, `${parent.key}: deliver one slice`);

    const counter = wrapStore(store);
    counter.reset();
    recordMerge(store, connection.id, "change.merged:42:depth-held");
    expect(counter.max, "held merge").toBe(1);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    expect(store.listIssueActivity(parent.id).filter((entry) => entry.type === "parent_status_held"))
      .toHaveLength(1);
  });

  it("keeps the done branch (no open children) at depth 1", () => {
    const { store } = setupDepthStore();
    const connection = seedScm(store);
    const parent = store.createIssue({ title: "SCM done parent", workspaceId: "local" });
    store.updateIssue(parent.id, { status: "in_progress" });
    store.updateIssue(store.createIssue({
      title: "Finished child",
      parentIssueId: parent.id,
      status: "in_progress",
    }).id, { status: "done" });
    projectChangeRequest(store, connection.id, `${parent.key} final delivery`);

    const counter = wrapStore(store);
    counter.reset();
    recordMerge(store, connection.id, "change.merged:42:depth-done");
    expect(counter.max, "closed merge").toBe(1);
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(store.listIssueActivity(parent.id).filter((entry) => entry.type === "issue_status_forced"))
      .toHaveLength(0);
  });
});

describe("MUL-400 S1 events never fire inside a transaction", () => {
  it("publishes the E1/E2 pushes only after the write transaction commits", () => {
    const { store, agent } = setupDepthStore();
    const parent = store.createIssue({
      title: "Emission parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({
      title: "Emission child",
      parentIssueId: parent.id,
      status: "in_progress",
    });

    // `db.inTransaction` is the real signal: any event delivered while it is
    // true reached clients before the row was durable, and a ROLLBACK would
    // have made it a lie.
    const events: Array<{ type: string; action: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      events.push({ type: event.type, action: entry?.action ?? "", inTransaction: db!.inTransaction });
    });
    try {
      // E2: child done -> notification comment + fresh parent round.
      store.updateIssue(child.id, { status: "done" });
      // E1 re-derivation: an in_review parent with an open child goes back.
      store.updateIssue(parent.id, { status: "in_review", force: true });
      const second = store.createIssue({
        title: "Emission child two",
        parentIssueId: parent.id,
        status: "in_progress",
      });
      store.updateIssue(second.id, { status: "blocked" });
    } finally {
      unsubscribe();
    }

    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
    // The pushes the S1 hook owes the UI are all present, post-commit.
    expect(events.some((event) => event.type === "comment:created")).toBe(true);
    expect(events.some((event) => event.type === "issue:updated")).toBe(true);
    // The audit activities the hook writes are also published post-commit.
    expect(events.some((event) => event.action === "child_done_parent_triggered")).toBe(true);
    expect(events.some((event) => event.action === "parent_status_derived")).toBe(true);
  });

  it("drops the deferred events when the organizer transaction rolls back", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const owner = store.createWorkspaceMember({
      id: "mem_emitter",
      workspaceId: "local",
      userId: "owner",
      name: "Owner",
      role: "owner",
    });
    const runtime = store.registerRuntime({
      id: "rt_emitter",
      name: "Emitter runtime",
      provider: "codex",
      workspaceId: "local",
    });
    const supervisor = store.createAgent({
      name: "Emitter supervisor",
      provider: "codex",
      workspaceId: "local",
      ownerId: owner.userId ?? owner.id,
      role: "supervisor",
    });
    const worker = store.createAgent({
      name: "Emitter worker",
      provider: "codex",
      workspaceId: "local",
      ownerId: owner.userId ?? owner.id,
    });
    store.updateWorkspace("local", { settings: { organizer: { mode: "act" } } });
    const patrol = store.createIssue({ title: "Emitter patrol", workspaceId: "local" });
    const supervisorTask = store.createTask({
      agentId: supervisor.id,
      issueId: patrol.id,
      workspaceId: "local",
      prompt: "patrol",
    });
    const target = store.createTask({
      agentId: worker.id,
      runtimeId: runtime.id,
      workspaceId: "local",
      prompt: "target",
    });

    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => events.push(event.type));
    // Fail after the audit comment is written, before the organizer commits.
    const issues = (store as unknown as {
      issues: { notifyOrganizerAction: (...args: unknown[]) => void };
    }).issues;
    const originalNotify = issues.notifyOrganizerAction.bind(issues);
    issues.notifyOrganizerAction = (...args: unknown[]) => {
      originalNotify(...args);
      throw new Error("emitter rollback");
    };
    try {
      expect(() => store.performOrganizerAction({
        supervisorTaskId: supervisorTask.id,
        supervisorAgentId: supervisor.id,
        targetTaskId: target.id,
        action: "cancel",
        reason: "emitter rollback probe",
      })).toThrow("emitter rollback");
    } finally {
      issues.notifyOrganizerAction = originalNotify;
      unsubscribe();
    }

    // Rolled back → the audit comment never existed → nothing may be pushed.
    expect(store.getTask(target.id)?.status).toBe("queued");
    expect(events.filter((type) => type === "comment:created")).toHaveLength(0);
    // The organizer's own activity/audit pushes are deferred too; the trailing
    // issue:updated from the terminal sync is main-existing and out of scope.
    expect(events.filter((type) => type === "activity:created")).toHaveLength(0);
  });
});

describe("MUL-400 E2 hook atomicity", () => {
  it("leaves no orphan round and no half activity when the hook fails mid-write", () => {
    const { store, agent } = setupDepthStore();
    const parent = store.createIssue({
      title: "Atomic parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({
      title: "Atomic child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    // Fail exactly where QA asked: after the round is inserted, before its
    // audit activity is appended. `appendIssueActivity` on the store context is
    // the writer both the round and the coalesced branch use.
    type ActivityInput = { type: string };
    const ctx = (store as unknown as {
      ctx: { appendIssueActivity: (issueId: string, input: ActivityInput) => void };
    }).ctx;
    const original = ctx.appendIssueActivity.bind(ctx);
    const failOn = ["child_done_parent_triggered", "child_status_parent_coalesced"];
    ctx.appendIssueActivity = (issueId: string, input: ActivityInput) => {
      if (failOn.includes(input.type)) throw new Error("injected hook failure");
      original(issueId, input);
    };

    let thrown: Error | null = null;
    try {
      store.updateIssue(child.id, { status: "done" });
    } catch (err) {
      thrown = err as Error;
    }
    ctx.appendIssueActivity = original;

    // ADR 0003: the child's own status was committed before the hook ran.
    expect(store.getIssue(child.id)?.status).toBe("done");
    // The failure is observable at the call site ...
    expect(thrown?.message).toBe("injected hook failure");
    // ... and nothing half-written is left behind: no round, no notification
    // comment, no audit row from the failed hook transaction.
    expect(store.listTasksForIssue(parent.id)).toHaveLength(0);
    expect(store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system")).toHaveLength(0);
    expect(store.listIssueActivity(parent.id).filter((entry) => failOn.includes(entry.type))).toHaveLength(0);
  });

  it("logs the failure for a task-terminal hook (how an operator finds it)", () => {
    const { store, runtime, agent } = setupDepthStore();
    const parent = store.createIssue({
      title: "Logged hook parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = store.createIssue({
      title: "Logged hook child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const task = store.createTask({ agentId: agent.id, issueId: child.id, prompt: "explode" });
    runTask(store, runtime.id, task.id);

    // The task-terminal path must not fail a completed run, so its hook failure
    // goes to the log. `runChildStatusChanges` emits
    // "child status hook skipped for <issue id>: <message>".
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    const originalHook = store.notifyChildStatusChange.bind(store);
    store.notifyChildStatusChange = (() => {
      throw new Error("terminal hook exploded");
    }) as typeof originalHook;
    try {
      store.failTask(task.id, { error: "boom" });
    } finally {
      store.notifyChildStatusChange = originalHook as typeof store.notifyChildStatusChange;
      console.warn = originalWarn;
    }

    // The terminal state still committed, and the failure is in the log.
    expect(store.getTask(task.id)?.status).toBe("failed");
    expect(warnings.some((line) =>
      line.includes("child status hook skipped for") && line.includes("terminal hook exploded"))).toBe(true);
  });
});
