import { runTurnExecutionMutation } from '@multiremi/store/turn-execution-records.js';
import type { SqlDatabase as UnifiedFixtureDatabase } from '@multiremi/store/db/postgres.js';
/**
 * MUL-400 S1: every path the parent-status work touches must reach the database
 * with a transaction depth of at most 1.
 *
 * Depth 1 is a hard contract for these entry points, not a bridge limit (Senior
 * ruling cmt_96e1yqxgifms §1, docs/adr/0011-transaction-ownership-and-side-effect-timing.md).
 * A nested `transaction()` is a SAVEPOINT on both backends (MUL-405), so it no
 * longer commits the outer one early, but it is still an extra frame a helper
 * added. The store's convention is that the outermost caller owns the only
 * transaction and everything inside it uses a `...WithinTransaction` variant.
 * This file wraps `db.transaction` in a depth counter that counts every frame,
 * outer and nested, and asserts that ceiling for each entry point, plus the
 * atomicity of the E2 hook itself.
 *
 * This file runs the counter on SQLite; multiremi-parent-status-pg-depth.test.ts
 * runs the same full-frame count, plus the SQL control assertions, on real
 * PostgreSQL.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { StoreContext } from "@multiremi/store/context.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";
import { inboxFlowFixture, triggerInboxFlow } from "./fixtures/inbox-flow-fixture.js";

afterEach(resetMultiremiTestEnv);

type Store = ReturnType<typeof createStore>;

/**
 * Count nested `transaction()` calls on a database handle. The store's own
 * database is a write-invalidating proxy whose `transaction` forwards to the
 * target on every read, so wrapping the target observes every call the store
 * makes, including the ones that start from a repo.
 */
interface DepthCounter {
  max: number;
  maxTopLevel: number;
  maxNested: number;
  taskInserts: Array<{ depth: number; inTransaction: boolean }>;
  reset(): void;
}

export function transactionDepthCounter(database: unknown): DepthCounter {
  const target = database as {
    readonly inTransaction?: boolean;
    transaction: (fn: (...args: never[]) => unknown) => (...args: unknown[]) => unknown;
    run: (sql: string, params?: unknown[]) => unknown;
  };
  const original = target.transaction;
  const counter: DepthCounter = {
    max: 0,
    maxTopLevel: 0,
    maxNested: 0,
    taskInserts: [],
    reset() { counter.max = 0; counter.maxTopLevel = 0; counter.maxNested = 0; counter.taskInserts = []; },
  };
  let depth = 0;
  let topLevelDepth = 0;
  let nestedDepth = 0;
  const execute = target.run.bind(target);
  target.run = (sql, params) => {
    if (/INSERT\s+INTO\s+multiremi_turn_attempts/i.test(sql)) {
      counter.taskInserts.push({ depth: topLevelDepth + nestedDepth, inTransaction: target.inTransaction === true });
    }
    return execute(sql, params);
  };
  target.transaction = (fn: (...args: never[]) => unknown) => {
    const run = original.call(target, fn);
    return (...args: unknown[]) => {
      const nested = target.inTransaction === true;
      if (nested) nestedDepth += 1; else topLevelDepth += 1;
      counter.maxTopLevel = Math.max(counter.maxTopLevel, topLevelDepth);
      counter.maxNested = Math.max(counter.maxNested, nestedDepth);
      depth += 1;
      counter.max = Math.max(counter.max, depth);
      try {
        return run(...args);
      } finally {
        depth -= 1;
        if (nested) nestedDepth -= 1; else topLevelDepth -= 1;
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
function wrapStore(store: Store): DepthCounter {
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
  runTurnExecutionMutation(db! as unknown as UnifiedFixtureDatabase,"UPDATE multiremi_turn_execution_records SET status = 'running' WHERE id = ?", [running.id]);
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
      expect(counter.maxTopLevel).toBe(1);
      expect(counter.maxNested).toBe(0);
      expect(counter.taskInserts).toEqual([{ depth: 1, inTransaction: true }]);
      expect(counter.maxTopLevel + counter.maxNested).toBe(1);
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
      expect(counter.maxTopLevel).toBe(1);
      expect(counter.maxNested).toBe(0);
      expect(counter.taskInserts).toEqual([{ depth: 1, inTransaction: true }]);
      expect(counter.maxTopLevel + counter.maxNested).toBe(1);
      expect(store.listTasksForIssue(parent.id).filter((task) => task.status === "queued")).toHaveLength(1);
    });
  }

  it("inserts the E4 pending turn inside the decision transaction at depth 1", () => {
    const { store } = setupDepthStore();
    const flow = inboxFlowFixture(store, "e4");
    const counter = wrapStore(store);
    counter.reset();
    triggerInboxFlow(store, flow);
    expect(counter.maxTopLevel).toBe(1);
    expect(counter.maxNested).toBe(0);
    expect(counter.taskInserts).toEqual([{ depth: 1, inTransaction: true }]);
  });

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
    runTask(store, runtime.id, orphan.id);
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

  it("rolls the SCM status, audit rows and effect mark back on a grant-used failure", () => {
    const { store, agent } = setupDepthStore();
    const connection = seedScm(store);
    const parent = store.createIssue({
      title: "SCM atomic parent", workspaceId: "local", status: "in_progress",
      assigneeType: "agent", assigneeId: agent.id,
    });
    store.updateIssue(store.createIssue({
      title: "SCM finished child",
      parentIssueId: parent.id,
      status: "in_progress",
    }).id, { status: "done" });
    store.grantParentDone(parent.id, "local");
    store.createIssueComment(parent.id, { body: "SCM summary", authorType: "agent", authorId: agent.id });
    projectChangeRequest(store, connection.id, `${parent.key} atomic delivery`);

    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") events.push(entry?.action ?? "");
    });
    const original = StoreContext.prototype.appendIssueActivity;
    let injected = false;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      issueId: string,
      input: { type: string },
      ...rest: unknown[]
    ) {
      original.call(this, issueId, input as never, ...rest as [never]);
      if (input.type === "parent_done_grant_used") {
        injected = true;
        throw new Error("scm grant-used injection");
      }
    } as typeof StoreContext.prototype.appendIssueActivity;
    try {
      recordMerge(store, connection.id, "change.merged:42:scm-atomic");
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribe();
    }
    expect(injected).toBe(true);
    // The injected failure is caught by the effect loop and recorded as a retry
    // reason: the parent must NOT be done and no audit row may survive.
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    const types = store.listIssueActivity(parent.id).map((entry) => entry.type);
    expect(types).not.toContain("parent_done_grant_used");
    expect(types).not.toContain("scm_merge_completed");
    expect(events.filter((action) => action === "issue_updated" || action === "parent_done_grant_used"))
      .toHaveLength(0);
    const pending = db!.query(
      "SELECT status, last_error FROM multiremi_scm_effects WHERE issue_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(parent.id) as { status?: string; last_error?: string | null } | null;
    expect(pending?.status).toBe("pending");
    expect(String(pending?.last_error ?? "")).toContain("scm grant-used injection");

    // Retrying the same dispatch settles it exactly once.
    recordMerge(store, connection.id, "change.merged:42:scm-atomic");
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "parent_done_grant_used")).toHaveLength(1);
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "scm_merge_completed")).toHaveLength(1);
    const settled = db!.query(
      "SELECT status FROM multiremi_scm_effects WHERE issue_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(parent.id) as { status?: string } | null;
    expect(settled?.status).toBe("applied");
  });

  it("emits the SCM grant-used events exactly once and only after COMMIT", () => {
    const { store, agent } = setupDepthStore();
    const connection = seedScm(store);
    const parent = store.createIssue({
      title: "SCM event parent", workspaceId: "local", status: "in_progress",
      assigneeType: "agent", assigneeId: agent.id,
    });
    store.updateIssue(store.createIssue({
      title: "SCM event child",
      parentIssueId: parent.id,
      status: "in_progress",
    }).id, { status: "done" });
    store.grantParentDone(parent.id, "local");
    store.createIssueComment(parent.id, { body: "SCM summary", authorType: "agent", authorId: agent.id });
    projectChangeRequest(store, connection.id, `${parent.key} event delivery`);
    const events: Array<{ action: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type !== "activity:created") return;
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      events.push({ action: entry?.action ?? "", inTransaction: db!.inTransaction });
    });
    try {
      recordMerge(store, connection.id, "change.merged:42:scm-events");
    } finally {
      unsubscribe();
    }
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(events.filter((event) => event.action === "parent_done_grant_used")).toHaveLength(1);
    expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
  });

  it("keeps the granted and summarized done branch at depth 1", () => {
    const { store, agent } = setupDepthStore();
    const connection = seedScm(store);
    const parent = store.createIssue({
      title: "SCM done parent", workspaceId: "local", status: "in_progress",
      assigneeType: "agent", assigneeId: agent.id,
    });
    store.updateIssue(store.createIssue({
      title: "Finished child",
      parentIssueId: parent.id,
      status: "in_progress",
    }).id, { status: "done" });
    store.grantParentDone(parent.id, "local");
    store.createIssueComment(parent.id, { body: "All child work delivered", authorType: "agent", authorId: agent.id });
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

describe("MUL-457 — grant use is atomic with the parent status", () => {
  /**
   * QA round 1, blocker 1: the API path wrote `issue_updated` and
   * `parent_done_grant_used` after the status transaction committed, and the SCM
   * path marked its effect `applied` even later. Injecting a failure at the
   * grant-used INSERT therefore left the parent `done` with the audit rows
   * already visible. Both paths now write status + audit + effect in one
   * transaction, so the injected failure must roll all of it back and the SCM
   * effect must still be retryable.
   */
  function grantedParentCase(store: Store, agentId: string) {
    const parent = store.createIssue({
      title: "Granted parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agentId,
    });
    const child = store.createIssue({
      title: "Finished child",
      parentIssueId: parent.id,
      status: "in_progress",
    });
    store.updateIssue(child.id, { status: "done" });
    store.grantParentDone(parent.id, "local");
    store.createIssueComment(parent.id, { body: "All child work delivered", authorType: "agent", authorId: agentId });
    return { parent, child };
  }

  function failOnGrantUsedOnce(): { restore(): void; fired(): boolean } {
    const original = StoreContext.prototype.appendIssueActivity;
    let fired = false;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      issueId: string,
      input: { type: string },
      ...rest: unknown[]
    ) {
      original.call(this, issueId, input as never, ...rest as [never]);
      if (input.type === "parent_done_grant_used") {
        fired = true;
        throw new Error("grant-used injection");
      }
    } as typeof StoreContext.prototype.appendIssueActivity;
    return {
      fired: () => fired,
      restore() { StoreContext.prototype.appendIssueActivity = original; },
    };
  }

  it("rolls the API status, both audit rows and every event back on a grant-used failure", () => {
    const { store, agent } = setupDepthStore();
    const { parent } = grantedParentCase(store, agent.id);
    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") events.push(entry?.action ?? "");
    });
    const injection = failOnGrantUsedOnce();
    let thrown: Error | null = null;
    try {
      store.updateIssue(parent.id, { status: "done", actorType: "agent", actorId: agent.id });
    } catch (err) {
      thrown = err as Error;
    } finally {
      injection.restore();
      unsubscribe();
    }
    expect(injection.fired()).toBe(true);
    expect(thrown?.message).toBe("grant-used injection");
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    const types = store.listIssueActivity(parent.id).map((entry) => entry.type);
    expect(types).not.toContain("issue_updated");
    expect(types).not.toContain("parent_done_grant_used");
    expect(events).toHaveLength(0);

    // Retrying after the injected failure settles exactly once.
    store.updateIssue(parent.id, { status: "done", actorType: "agent", actorId: agent.id });
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "issue_updated")).toHaveLength(1);
    expect(store.listIssueActivity(parent.id).filter((e) => e.type === "parent_done_grant_used")).toHaveLength(1);
  });

  it("emits the API grant-used events exactly once and only after COMMIT", () => {
    const { store, agent } = setupDepthStore();
    const { parent } = grantedParentCase(store, agent.id);
    const events: Array<{ action: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      if (event.type !== "activity:created") return;
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      events.push({ action: entry?.action ?? "", inTransaction: db!.inTransaction });
    });
    try {
      store.updateIssue(parent.id, { status: "done", actorType: "agent", actorId: agent.id });
    } finally {
      unsubscribe();
    }
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(events.filter((event) => event.action === "issue_updated")).toHaveLength(1);
    expect(events.filter((event) => event.action === "parent_done_grant_used")).toHaveLength(1);
    expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
  });
});

describe("MUL-400 S1 — the replay walks the whole ancestor chain", () => {
  /**
   * QA round 4: the hook used to return the parent's own re-derivation and the
   * direct write path dropped it, so only one level moved. The chain below is
   * grandparent <- parent <- child, all agent-owned with a still-open sibling,
   * and each entry point that ends the child must walk both hops.
   */
  function threeLayerChain(store: Store, agentId: string) {
    const grandparent = store.createIssue({
      title: "Grandparent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agentId,
    });
    const parent = store.createIssue({
      title: "Parent",
      status: "in_progress",
      parentIssueId: grandparent.id,
      assigneeType: "agent",
      assigneeId: agentId,
    });
    const child = store.createIssue({
      title: "Child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agentId,
    });
    // Each level keeps an open sibling, so the derived in_progress is the only
    // legal move and no parent can fall through to a terminal status. The
    // siblings must exist BEFORE the parents are parked at in_review: creating a
    // child under an in_review parent re-derives that parent immediately (that
    // is E1 working), which would collapse the chain before the probe starts.
    store.createIssue({ title: "Sibling gp", parentIssueId: grandparent.id, status: "in_progress" });
    store.createIssue({ title: "Sibling p", parentIssueId: parent.id, status: "in_progress" });
    store.updateIssue(parent.id, { status: "in_review", force: true });
    store.updateIssue(grandparent.id, { status: "in_review", force: true });
    expect(store.getIssue(parent.id)?.status).toBe("in_review");
    expect(store.getIssue(grandparent.id)?.status).toBe("in_review");
    return { grandparent, parent, child };
  }

  function assertChainWalked(store: Store, chain: ReturnType<typeof threeLayerChain>) {
    expect(store.getIssue(chain.parent.id)?.status).toBe("in_progress");
    expect(store.getIssue(chain.grandparent.id)?.status).toBe("in_progress");
    expect(store.listIssueActivity(chain.parent.id).filter((e) => e.type === "parent_status_derived"))
      .toHaveLength(1);
    expect(store.listIssueActivity(chain.grandparent.id).filter((e) => e.type === "parent_status_derived"))
      .toHaveLength(1);
  }

  it("walks child -> parent -> grandparent on updateIssue", () => {
    const { store, agent } = setupDepthStore();
    const chain = threeLayerChain(store, agent.id);
    const counter = wrapStore(store);
    counter.reset();
    store.updateIssue(chain.child.id, { status: "done" });
    expect(counter.max, "updateIssue chain depth").toBe(1);
    assertChainWalked(store, chain);
  });

  it("walks child -> parent -> grandparent on completeTask", () => {
    const { store, runtime, agent } = setupDepthStore();
    const chain = threeLayerChain(store, agent.id);
    const task = store.createTask({ agentId: agent.id, issueId: chain.child.id, prompt: "finish the child" });
    runTask(store, runtime.id, task.id);
    const counter = wrapStore(store);
    counter.reset();
    store.completeTask(task.id, { output: "child slice finished" });
    expect(counter.max, "completeTask chain depth").toBe(1);
    assertChainWalked(store, chain);
  });

  it("walks child -> parent -> grandparent on an SCM merge", () => {
    const { store, agent } = setupDepthStore();
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
    const connection = store.createScmConnection({
      workspaceId: "local",
      name: "GitHub chain",
      provider: "github",
      mode: "hybrid",
      accessToken: "ghp_chain_token",
      webhookSecret: "chain-webhook-secret",
      repositoryIds: ["repo_widgets"],
    });
    const chain = threeLayerChain(store, agent.id);
    store.advanceScmEntitySnapshot({
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      entityType: "change_request",
      externalId: "77",
      revisionAt: "2026-08-21T10:00:00.000Z",
      revision: "v-77",
      contentHash: "change-77",
      payload: {
        number: 77,
        title: `${chain.child.key}: deliver one slice`,
        state: "merged",
        source_branch: "agent/chain",
        url: "https://github.com/acme/widgets/pull/77",
      },
    });
    const counter = wrapStore(store);
    counter.reset();
    store.recordScmCanonicalEvent({
      workspaceId: "local",
      connectionId: connection.id,
      repositoryId: "repo_widgets",
      type: "change.merged",
      subjectType: "change_request",
      subjectId: "77",
      logicalKey: "change.merged:77:chain",
      fidelity: "inferred",
      payload: { id: "provider-change-77", number: 77, branch: "main", mergeSha: "def" },
      evidence: { source: "poll", dedupeKey: "poll:change.merged:77", providerEventId: null },
    });
    expect(counter.max, "scm merge chain depth").toBe(1);
    expect(store.getIssue(chain.child.id)?.status).toBe("done");
    assertChainWalked(store, chain);
  });

  it("walks four levels, so the replay is not capped at one extra hop", () => {
    const { store, agent } = setupDepthStore();
    // The whole point of the case: a chain deeper than the QA repro must walk
    // past the first hop, so every level keeps an open child of its own.
    const top = store.createIssue({
      title: "Top",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const mid = store.createIssue({
      title: "Mid",
      status: "in_progress",
      parentIssueId: top.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const low = store.createIssue({
      title: "Low",
      status: "in_progress",
      parentIssueId: mid.id,
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const leaf = store.createIssue({
      title: "Leaf",
      parentIssueId: low.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    for (const holder of [top, mid, low]) {
      store.createIssue({ title: `Sibling ${holder.id}`, parentIssueId: holder.id, status: "in_progress" });
    }
    for (const holder of [low, mid, top]) {
      store.updateIssue(holder.id, { status: "in_review", force: true });
      expect(store.getIssue(holder.id)?.status).toBe("in_review");
    }

    const events: string[] = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (entry?.action) events.push(entry.action);
    });
    const counter = wrapStore(store);
    counter.reset();
    try {
      store.updateIssue(leaf.id, { status: "done" });
    } finally {
      unsubscribe();
    }
    expect(counter.max, "four-level chain depth").toBe(1);
    // Each of the three ancestors derived, so the replay is not capped at one
    // extra hop. Only the leaf's own ending is an E2 report; the intermediate
    // hops moved in_review -> in_progress, which is a derivation, not a child
    // terminal outcome, so they must NOT file a notification round.
    expect(events.filter((action) => action === "parent_status_derived")).toHaveLength(3);
    expect(events.filter((action) => action === "child_done_parent_triggered")).toHaveLength(1);
    for (const holder of [low, mid, top]) {
      expect(store.getIssue(holder.id)?.status).toBe("in_progress");
      expect(store.listIssueActivity(holder.id).filter((e) => e.type === "parent_status_derived"))
        .toHaveLength(1);
    }
  });

  it("emits every chain event after the commit, and reports one line per level", () => {
    const { store, agent } = setupDepthStore();
    const chain = threeLayerChain(store, agent.id);
    const events: Array<{ type: string; action: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      events.push({ type: event.type, action: entry?.action ?? "", inTransaction: db!.inTransaction });
    });
    try {
      store.updateIssue(chain.child.id, { status: "done" });
    } finally {
      unsubscribe();
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
    // Each level reports its own derivation; the round is queued once per level
    // that had a report to deliver.
    expect(events.filter((event) => event.action === "parent_status_derived")).toHaveLength(2);
    expect(events.filter((event) => event.action === "child_done_parent_triggered")).toHaveLength(1);
    // One `issue:updated` realtime patch per derived level, plus the child's own
    // PATCH audit line.
    expect(events.filter((event) => event.type === "issue:updated")).toHaveLength(2);
    expect(events.filter((event) => event.action === "issue_updated")).toHaveLength(1);
  });
});

describe("MUL-400 S1 — no activity is broadcast before its transaction commits", () => {
  /**
   * QA round 4, blocker 2: the closed-parent activity and the re-derivation
   * activity were written on the transaction but pushed immediately. The probe
   * is `db.inTransaction` at delivery time plus a rollback that must leave both
   * the row and the client-side event at zero.
   */
  function closedParentCase(store: Store, status: "done" | "cancelled") {
    const parent = store.createIssue({ title: `Closed parent ${status}`, status: "in_progress" });
    const child = store.createIssue({
      title: `Late child ${status}`,
      parentIssueId: parent.id,
      status: "in_progress",
    });
    store.updateIssue(parent.id, { status, force: true });
    return { parent, child };
  }

  for (const parentStatus of ["done", "cancelled"] as const) {
    it(`delivers the ${parentStatus}-parent activity only after COMMIT`, () => {
      const store = createStore();
      store.ensureLocalWorkspace();
      const { parent, child } = closedParentCase(store, parentStatus);

      const events: Array<{ action: string; inTransaction: boolean }> = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
        if (event.type === "activity:created") {
          events.push({ action: entry?.action ?? "", inTransaction: db!.inTransaction });
        }
      });
      try {
        store.updateIssue(child.id, { status: "done" });
      } finally {
        unsubscribe();
      }

      expect(store.listIssueActivity(parent.id).filter((e) => e.type === "child_status_after_parent_closed"))
        .toHaveLength(1);
      const closedEvents = events.filter((event) => event.action === "child_status_after_parent_closed");
      expect(closedEvents).toHaveLength(1);
      expect(closedEvents[0]?.inTransaction).toBe(false);
      // Every activity on the way is post-commit, not just the one under test.
      expect(events.filter((event) => event.inTransaction)).toHaveLength(0);
    });

    it(`leaves zero rows and zero events when the ${parentStatus}-parent write rolls back`, () => {
      const store = createStore();
      store.ensureLocalWorkspace();
      const { parent, child } = closedParentCase(store, parentStatus);

      const events: string[] = [];
      const unsubscribe = store.onWorkspaceEvent((event) => {
        const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
        if (event.type === "activity:created") events.push(entry?.action ?? "");
      });
      // Inject the failure AFTER the closed-parent activity row is written.
      // The repo writes through `StoreContext`, so the prototype is the seam.
      const original = StoreContext.prototype.appendIssueActivity;
      let injected = false;
      StoreContext.prototype.appendIssueActivity = function patched(
        this: StoreContext,
        issueId: string,
        input: { type: string },
        ...rest: unknown[]
      ) {
        const result = original.call(this, issueId, input as never, ...rest as [never]);
        if (input.type === "child_status_after_parent_closed") {
          injected = true;
          throw new Error("closed-parent rollback injection");
        }
        return result;
      } as typeof StoreContext.prototype.appendIssueActivity;
      let threw = false;
      try {
        store.updateIssue(child.id, { status: "done" });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toBe("closed-parent rollback injection");
      } finally {
        StoreContext.prototype.appendIssueActivity = original;
        unsubscribe();
      }

      // The child's own status change is committed (ADR 0003), but the hook's
      // activity rolled back and the listener never heard about it.
      expect(injected).toBe(true);
      expect(threw).toBe(true);
      expect(store.listIssueActivity(parent.id).filter((e) => e.type === "child_status_after_parent_closed"))
        .toHaveLength(0);
      // The child's own committed `issue_updated` activity may still appear; the
      // rolled-back hook event must not.
      expect(events.filter((action) => action === "child_status_after_parent_closed")).toHaveLength(0);
    });
  }

  it("delivers `parent_status_derived` only after COMMIT", () => {
    const { store, agent } = setupDepthStore();
    const chain = (() => {
      const parent = store.createIssue({
        title: "Derive parent",
        status: "in_progress",
        assigneeType: "agent",
        assigneeId: agent.id,
      });
      const child = store.createIssue({
        title: "Derive child",
        parentIssueId: parent.id,
        status: "in_progress",
      });
      store.createIssue({ title: "Open sibling", parentIssueId: parent.id, status: "in_progress" });
      store.updateIssue(parent.id, { status: "in_review", force: true });
      return { parent, child };
    })();

    const events: Array<{ action: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") {
        events.push({ action: entry?.action ?? "", inTransaction: db!.inTransaction });
      }
    });
    try {
      store.updateIssue(chain.child.id, { status: "cancelled" });
    } finally {
      unsubscribe();
    }
    expect(store.getIssue(chain.parent.id)?.status).toBe("in_progress");
    expect(events.filter((event) => event.action === "parent_status_derived")).toHaveLength(1);
    expect(events.filter((event) => event.action === "parent_status_derived")[0]?.inTransaction).toBe(false);
  });

  it("keeps the self-transactional system-comment wrapper's activity inside its own COMMIT", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const issue = store.createIssue({ title: "Wrapper issue", status: "in_progress" });

    const events: Array<{ action: string; inTransaction: boolean }> = [];
    const unsubscribe = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") {
        events.push({ action: entry?.action ?? "", inTransaction: db!.inTransaction });
      }
    });
    try {
      store.createTaskFailureSystemComment(issue.id, null, "tsk_wrapper", "wrapper body");
    } finally {
      unsubscribe();
    }
    expect(events.filter((event) => event.action === "comment_created")).toHaveLength(1);
    expect(events.filter((event) => event.action === "comment_created")[0]?.inTransaction).toBe(false);

    // And on rollback: no row, no event.
    const eventsDuringRollback: string[] = [];
    const unsubscribeRollback = store.onWorkspaceEvent((event) => {
      const entry = (event.payload as { entry?: { action?: string } } | undefined)?.entry;
      if (event.type === "activity:created") eventsDuringRollback.push(entry?.action ?? "");
    });
    const original = StoreContext.prototype.appendIssueActivity;
    StoreContext.prototype.appendIssueActivity = function patched(
      this: StoreContext,
      issueId: string,
      input: { type: string },
      ...rest: unknown[]
    ) {
      const result = original.call(this, issueId, input as never, ...rest as [never]);
      if (input.type === "comment_created") throw new Error("wrapper rollback injection");
      return result;
    } as typeof StoreContext.prototype.appendIssueActivity;
    let threw = false;
    try {
      store.createTaskFailureSystemComment(issue.id, null, "tsk_wrapper_2", "wrapper body 2");
    } catch (err) {
      threw = true;
      expect((err as Error).message).toBe("wrapper rollback injection");
    } finally {
      StoreContext.prototype.appendIssueActivity = original;
      unsubscribeRollback();
    }
    expect(threw).toBe(true);
    expect(eventsDuringRollback).toHaveLength(0);
    const wrapperComments = store.listIssueComments(issue.id)
      .filter((comment) => comment.type === "system" && comment.body === "wrapper body 2");
    expect(wrapperComments).toHaveLength(0);
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

    // Fail after the unified round is inserted, before its native audit is
    // appended. The inbox writer owns this statement rather than the retired
    // child-status activity facade.
    const ctx = (store as unknown as {
      ctx: import("@multiremi/store/context.js").StoreContext;
    }).ctx;
    const original = ctx.db.run.bind(ctx.db);
    const failOn = ["turn_created"];
    ctx.db.run = (sql, params) => {
      if (/INSERT\s+INTO\s+multiremi_issue_activity/i.test(sql) && Array.isArray(params) && failOn.includes(String(params[2]))) {
        throw new Error("injected hook failure");
      }
      return original(sql, params);
    };

    let thrown: Error | null = null;
    try {
      store.updateIssue(child.id, { status: "done" });
    } catch (err) {
      thrown = err as Error;
    }
    ctx.db.run = original;

    // ADR 0012: the source status and wake belong to the same transaction.
    expect(store.getIssue(child.id)?.status).toBe("in_progress");
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
