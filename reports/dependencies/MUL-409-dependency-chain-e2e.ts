#!/usr/bin/env bun
/**
 * MUL-400 E3 acceptance 2 — the dependency chain end to end, on real PostgreSQL.
 *
 * What this drives (no stubs on the server side):
 *   - the real `MultiremiStore` over `PostgresSyncDatabase` (the production
 *     Postgres bridge), so dependency rows, the gate and the automatic start
 *     all execute as shipped SQL against a real server;
 *   - the real HTTP app (`createMultiremiApp`) for creation, status writes and
 *     the detail/children/child-progress reads, so the acceptance path is the
 *     route layer rather than the store in isolation.
 *
 * The only test doubles are the execution agent and the worker: the platform
 * never runs a real provider here. A "round" is simulated by walking the queued
 * task the platform itself created through claim -> start -> complete, which is
 * exactly the state machine a daemon would drive.
 *
 * Scenario (acceptance 2):
 *   1. one parent with three serially dependent children (C1 <- C2 <- C3,
 *      i.e. C2 and C3 each declare `blocked_by`), all owned by one agent;
 *   2. create with `status: todo` — C2/C3 must park in `backlog` while C1 runs;
 *   3. a human comments on waiting C3, which force-starts exactly one C3 round;
 *   4. C3 may finish early while C1 -> C2 still advances normally;
 *   5. the parent must not reach `in_review` until the last child is done.
 *
 * Usage (points at a throwaway database on an existing server):
 *
 *   MULTIREMI_TEST_POSTGRES_URL=postgres://user@127.0.0.1:5432/postgres \
 *     bun run reports/dependencies/MUL-409-dependency-chain-e2e.ts [--backend postgres|sqlite] [--out <path>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openSqliteDatabase } from "@multiremi/store/db/sqlite.js";
import { PostgresSyncDatabase } from "@multiremi/store/db/postgres.js";
import { MultiremiStore } from "@multiremi/store/store.js";
import { createMultiremiApp } from "@multiremi/api.js";

const ADMIN_URL = process.env.MULTIREMI_TEST_POSTGRES_URL ?? "postgres://multimira:multimira@localhost:5432/postgres";
const TEST_DB = `multiremi_dep_e2e_${process.pid}_${Math.floor(Math.random() * 1e6)}`;
const REPO_ROOT = resolve(import.meta.dir, "../..");
const backendIndex = process.argv.indexOf("--backend");
const BACKEND = backendIndex >= 0 ? process.argv[backendIndex + 1] : "postgres";
if (BACKEND !== "postgres" && BACKEND !== "sqlite") {
  throw new Error("--backend must be postgres or sqlite");
}

const outIndex = process.argv.indexOf("--out");
const OUT_PATH = outIndex >= 0 && process.argv[outIndex + 1]
  ? resolve(process.argv[outIndex + 1])
  : resolve(REPO_ROOT, `reports/dependencies/MUL-409-dependency-chain-e2e-${BACKEND}.json`);

interface Step {
  step: string;
  status: string;
  detail?: Record<string, unknown>;
}

const steps: Step[] = [];
function record(step: string, status: string, detail?: Record<string, unknown>): void {
  steps.push({ step, status, detail });
  console.log(`  ${status.padEnd(8)} ${step}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
}

function pgDatabaseUrl(database: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function main(): Promise<void> {
  if (BACKEND === "postgres") {
    const admin = new Bun.SQL(ADMIN_URL, { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await admin.end();
  }

  const db = BACKEND === "postgres"
    ? new PostgresSyncDatabase(pgDatabaseUrl(TEST_DB))
    : openSqliteDatabase(":memory:");
  const store = new MultiremiStore(db);
  const app = createMultiremiApp({ store });
  const failures: string[] = [];
  const check = (label: string, ok: boolean, detail?: Record<string, unknown>): void => {
    record(label, ok ? "ok" : "FAIL", detail);
    if (!ok) failures.push(label);
  };

  // MUL-409 fix round 4 (QA round 3, blocker 4): the automatic start has to
  // publish `issue:updated`, or an open issue page keeps rendering the stale
  // `backlog` status. Capture the real realtime events the store emits.
  const issueUpdatedEvents: Array<{ issueId: string; status: string; prevStatus: string }> = [];
  store.onWorkspaceEvent((event) => {
    if (event.type !== "issue:updated") return;
    const issue = event.payload.issue as { id?: string; status?: string } | undefined;
    if (!issue?.id || !issue.status) return;
    issueUpdatedEvents.push({
      issueId: issue.id,
      status: issue.status,
      prevStatus: String(event.payload.prev_status ?? ""),
    });
  });

  try {
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_e2e", name: "E2E worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ id: "agt_e2e", name: "E2E executor", provider: "claude", runtimeId: runtime.id });

    const json = async (path: string, init?: RequestInit) => {
      const response = await app.request(path, init);
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const post = (path: string, body: unknown) => json(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    // ── scenario setup ────────────────────────────────────────────────────────
    // The parent is owned by a person: the platform must never close it while
    // children are open, and a person is the one who reviews each child. The
    // children are owned by the executor agent, so the platform starts them.
    const human = store.listWorkspaceMembers("local").find((entry) => entry.userId === "local")
      ?? store.listWorkspaceMembers("local")[0]!;
    const parent = await post("/api/issues", {
      title: "E2E parent",
      status: "in_progress",
      assignee_type: "member",
      assignee_id: human.id,
    });
    const parentId = parent.body.id as string;
    record("create parent", "ok", { key: parent.body.identifier, status: parent.body.status });

    const createChild = async (title: string, blockedBy?: string) => post("/api/issues", {
      title,
      status: "todo",
      parent_issue_id: parentId,
      assignee_type: "agent",
      assignee_id: agent.id,
      ...(blockedBy ? { blocked_by: [blockedBy] } : {}),
    });
    const first = await createChild("C1");
    const firstId = first.body.id as string;
    const second = await createChild("C2", firstId);
    const secondId = second.body.id as string;
    const third = await createChild("C3", secondId);
    const thirdId = third.body.id as string;
    record("create chain C1 <- C2 <- C3", "ok", { c1: firstId, c2: secondId, c3: thirdId });

    // ── step 1: only C1 is dispatched, the rest wait ─────────────────────────
    check("C1 created as todo", first.body.status === "todo", { status: first.body.status });
    check("C1 dispatched", first.body.dispatch_status === "dispatched", {
      reason: first.body.dispatch_skipped_reason,
    });
    for (const [label, created] of [["C2", second], ["C3", third]] as const) {
      check(`${label} parked at backlog`, created.body.status === "backlog", { status: created.body.status });
      check(`${label} reports dependencies_unmet`, created.body.dispatch_skipped_reason === "dependencies_unmet", {
        reason: created.body.dispatch_skipped_reason,
      });
    }

    const tasksOf = (issueId: string) => store.listTasksForIssue(issueId).filter((task) => task.status !== "cancelled");
    const pendingRounds = (issueId: string) => tasksOf(issueId)
      .filter((task) => task.status === "queued" || task.status === "dispatched");
    check("only C1 has a task", tasksOf(firstId).length === 1
      && tasksOf(secondId).length === 0
      && tasksOf(thirdId).length === 0, {
      c1: tasksOf(firstId).length, c2: tasksOf(secondId).length, c3: tasksOf(thirdId).length,
    });

    // ── while the chain waits, the page data must say so ─────────────────────
    const waitingProgress = await json("/api/issues/child-progress");
    const waitingRow = (waitingProgress.body.progress as Array<Record<string, number | string>>)
      .find((row) => row.parentIssueId === parentId);
    check("child-progress counts the two waiting children", waitingRow?.waiting === 2 && waitingRow?.active === 1, {
      progress: waitingRow ?? null,
    });
    const waitingDetail = await json(`/api/multiremi/issues/${thirdId}`);
    check("C3 detail lists its unmet prerequisite", (waitingDetail.body.waiting_on?.unmet as unknown[])?.length === 1, {
      waitingOn: waitingDetail.body.waiting_on,
    });
    const waitingChildren = await json(`/api/issues/${parentId}/children`);
    // The children endpoint returns rows newest-first, so compare per child
    // rather than by position.
    const waitingRows = waitingChildren.body.issues as Array<Record<string, unknown>>;
    const blockedByOf = (issueId: string) => waitingRows.find((row) => row.id === issueId)?.blocked_by;
    check("children rows carry the prerequisite keys",
      JSON.stringify(blockedByOf(firstId)) === "[]"
      && JSON.stringify(blockedByOf(secondId)) === JSON.stringify([first.body.identifier])
      && JSON.stringify(blockedByOf(thirdId)) === JSON.stringify([second.body.identifier]), {
      c1: blockedByOf(firstId), c2: blockedByOf(secondId), c3: blockedByOf(thirdId),
    });

    // ── the parent must not be closable while children are open ──────────────
    const held = await json(`/api/issues/${parentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_review" }),
    });
    check("parent in_review held while children are open", held.status === 409, {
      status: held.status, code: held.body.code, reason: held.body.reason,
    });

    const snapshot = (step: number) => ({
      step,
      c1: store.getIssue(firstId)?.status,
      c2: store.getIssue(secondId)?.status,
      c3: store.getIssue(thirdId)?.status,
      parent: store.getIssue(parentId)?.status,
    });

    // ── MUL-458: a human explicitly starts the third waiting child ───────────
    const earlyComment = await post(`/api/issues/${thirdId}/comments`, {
      body: "Start C3 now; re-check its unfinished prerequisite before proceeding.",
    });
    check("human comment on waiting C3 is accepted", earlyComment.status === 201, {
      status: earlyComment.status,
    });
    const earlyC3Rounds = tasksOf(thirdId);
    check("human comment starts exactly one C3 round", earlyC3Rounds.length === 1, {
      rounds: earlyC3Rounds.length,
    });
    check("human comment moves C3 to todo", store.getIssue(thirdId)?.status === "todo", snapshot(1));
    const c3Force = store.listIssueActivity(thirdId).filter((entry) => entry.type === "dependency_force_started");
    check("human comment records one comment force-start", c3Force.length === 1
      && (c3Force[0]!.data as Record<string, unknown>)?.source === "comment", {
      activities: c3Force.map((entry) => entry.data),
    });
    check("C2 remains waiting while C3 starts early", store.getIssue(secondId)?.status === "backlog", snapshot(1));
    check("parent stays out of in_review after the early start", store.getIssue(parentId)?.status !== "in_review", snapshot(1));

    /**
     * Drive the one round the platform queued for `issueId`, the way a daemon
     * would: claim, start, complete. Then review the child the way a person
     * would, which is what releases the next link in the chain.
     */
    const runChildRound = async (issueId: string, label: string) => {
      const rounds = pendingRounds(issueId);
      if (rounds.length !== 1) {
        failures.push(`${label}: expected exactly one queued round`);
        record(`${label}: expected exactly one queued round`, "FAIL", { rounds: rounds.length });
        return;
      }
      const claimed = store.claimTask(runtime.id);
      if (!claimed || claimed.id !== rounds[0]!.id) {
        failures.push(`${label}: round not claimable`);
        record(`${label}: round not claimable`, "FAIL", { taskId: rounds[0]!.id, claimed: claimed?.id ?? null });
        return;
      }
      store.startTask(claimed.id);
      store.completeTask(claimed.id, { output: `${label} finished` });
      record(`${label}: round completed`, "ok", { taskId: claimed.id });
      const review = await json(`/api/issues/${issueId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      check(`${label} reviewed to done`, review.status === 200 && store.getIssue(issueId)?.status === "done", {
        status: store.getIssue(issueId)?.status, http: review.status, code: review.body.code,
      });
    };

    await runChildRound(firstId, "C1");
    check("C2 auto-started after C1 finished", store.getIssue(secondId)?.status === "todo", snapshot(2));
    check("C2 reports dependency_auto_started",
      store.listIssueActivity(secondId).some((entry) => entry.type === "dependency_auto_started"), {});
    // Blocker 4: every automatic start must be visible as a status event on the
    // dependent, with the new status and the status it moved from.
    const c2Events = issueUpdatedEvents.filter((event) => event.issueId === secondId);
    check("C2 published issue:updated as todo",
      c2Events.some((event) => event.status === "todo" && event.prevStatus === "backlog"),
      { events: c2Events });
    check("C3 stays independently active after C1", store.getIssue(thirdId)?.status === "todo", snapshot(2));
    check("parent still held after C1", store.getIssue(parentId)?.status !== "in_review", snapshot(2));

    // C3's forced round was queued before C2's automatic round. It can finish
    // while its direct prerequisite C2 is still unfinished.
    await runChildRound(thirdId, "C3 early");
    check("C3 can finish before its prerequisite", store.getIssue(thirdId)?.status === "done", snapshot(3));
    check("parent remains held after early C3", store.getIssue(parentId)?.status !== "in_review", snapshot(3));

    await runChildRound(secondId, "C2");
    check("C2 completion does not add a second C3 round", tasksOf(thirdId).length === 1, {
      rounds: tasksOf(thirdId).length,
    });
    check("C3 has no automatic start after its human force-start",
      !store.listIssueActivity(thirdId).some((entry) => entry.type === "dependency_auto_started"), {});
    check("every child reached done", [firstId, secondId, thirdId]
      .every((id) => store.getIssue(id)?.status === "done"), snapshot(4));

    // ── after the last child, the parent becomes reviewable ─────────────────
    const reviewable = await json(`/api/issues/${parentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_review" }),
    });
    check("parent reaches in_review only after the last child", reviewable.status === 200, {
      status: reviewable.status, code: reviewable.body.code, reason: reviewable.body.reason,
    });

    // ── surfaces reflect the same state ─────────────────────────────────────
    const detail = await json(`/api/multiremi/issues/${thirdId}`);
    check("C3 detail has no unmet prerequisites after running", Array.isArray(detail.body.waiting_on?.unmet)
      && detail.body.waiting_on.unmet.length === 0, { waitingOn: detail.body.waiting_on });
    const children = await json(`/api/issues/${parentId}/children`);
    const childRows = children.body.issues as Array<Record<string, unknown>>;
    check("children rows carry blocked_by", childRows.length === 3 && childRows.every((row) => Array.isArray(row.blocked_by)), {
      blockedBy: childRows.map((row) => row.blocked_by),
    });
    const progress = await json("/api/issues/child-progress");
    const parentRow = (progress.body.progress as Array<Record<string, number | string>>)
      .find((row) => row.parentIssueId === parentId);
    check("child-progress reports the parent", Boolean(parentRow), { progress: parentRow ?? null });

    // ── idempotency: re-entering done must not start anything twice ─────────
    const beforeReplay = tasksOf(secondId).length;
    await json(`/api/issues/${firstId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_review" }),
    });
    await json(`/api/issues/${firstId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    check("replaying done does not create a second round", tasksOf(secondId).length === beforeReplay, {
      before: beforeReplay, after: tasksOf(secondId).length,
    });
    check("replaying done leaves the dependent done", store.getIssue(secondId)?.status === "done", {
      c2: store.getIssue(secondId)?.status,
    });

    // ── MUL-409 fix round: the four scenarios QA found ──────────────────────
    //
    // (a) A member forced start must produce a real round. The dependent parks
    // in backlog because its prerequisite is unfinished; the override starts it
    // anyway, and the dependency row stays so the page still explains why.
    const prereqA = await post("/api/issues", {
      title: "Force prerequisite",
      status: "in_progress",
    });
    const forced = await post("/api/issues", {
      title: "Forced child",
      status: "todo",
      parent_issue_id: parentId,
      assignee_type: "agent",
      assignee_id: agent.id,
      blocked_by: [prereqA.body.id],
    });
    const forcedId = forced.body.id as string;
    check("forced child starts parked", forced.body.status === "backlog", { status: forced.body.status });
    const forceWrite = await json(`/api/issues/${forcedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo", force: true }),
    });
    check("member override is accepted", forceWrite.status === 200, { status: forceWrite.status, code: forceWrite.body.code });
    const forcedRounds = pendingRounds(forcedId);
    check("forced child owns exactly one round", forcedRounds.length === 1, { rounds: forcedRounds.length });
    check("forced child status is todo", store.getIssue(forcedId)?.status === "todo", { status: store.getIssue(forcedId)?.status });
    check("forced child keeps its dependency row", store.listUnmetPrerequisites(forcedId).length === 1, {});
    check("forced start is audited",
      store.listIssueActivity(forcedId).some((entry) => entry.type === "dependency_force_started"), {});
    // Once the prerequisite finishes, the forced child must not gain a second
    // round: it is already running, so the automatic start has nothing to do.
    const forcedClaim = store.claimTask(runtime.id);
    check("the forced round is claimable", forcedClaim?.id === forcedRounds[0]!.id, {
      claimed: forcedClaim?.id ?? null, expected: forcedRounds[0]!.id,
    });
    if (forcedClaim) {
      store.startTask(forcedClaim.id);
      store.completeTask(forcedClaim.id, { output: "Forced child finished" });
    }
    const roundsBeforePrereqDone = tasksOf(forcedId).length;
    await json(`/api/issues/${prereqA.body.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    check("a finished prerequisite adds no second round to a forced child",
      tasksOf(forcedId).length === roundsBeforePrereqDone, {
      before: roundsBeforePrereqDone, after: tasksOf(forcedId).length,
    });

    // (b) A dependency rejection must leave nothing behind: no orphan issue, no
    // consumed number, no half-written dependency row. The creation must also
    // stay a single transaction on this bridge: Postgres has no savepoints, so a
    // nested `BEGIN` would commit the issue row early and survive the rollback.
    const issuesBefore = store.listIssues({ workspaceId: "local" }).length;
    const childrenBefore = store.listChildIssues(parentId).length;
    const rejected = await post("/api/issues", {
      title: "Rejected child",
      status: "todo",
      parent_issue_id: parentId,
      blocked_by: [parentId],
    });
    check("depending on an ancestor is refused", rejected.status === 409 && rejected.body.code === "dependency_on_ancestor", {
      status: rejected.status, code: rejected.body.code,
    });
    check("the rejected creation leaves no orphan issue",
      store.listIssues({ workspaceId: "local" }).length === issuesBefore, {
      before: issuesBefore, after: store.listIssues({ workspaceId: "local" }).length,
    });
    check("the rejected creation leaves no child row",
      store.listChildIssues(parentId).length === childrenBefore, {
      before: childrenBefore, after: store.listChildIssues(parentId).length,
    });
    const afterRejection = await post("/api/issues", { title: "After the rejection", status: "todo" });
    check("the rejected creation consumes no issue number",
      afterRejection.body.identifier === `MUL-${issuesBefore + 1}`, {
      expected: `MUL-${issuesBefore + 1}`, actual: afterRejection.body.identifier,
    });
    // A successful creation with a prerequisite exercises the same wrapper.
    if (db instanceof PostgresSyncDatabase) db.resetTransactionDepthStats();
    await post("/api/issues", {
      title: "Depth probe",
      status: "todo",
      parent_issue_id: parentId,
      blocked_by: [firstId],
    });
    if (db instanceof PostgresSyncDatabase) {
      check("issue creation stays a single transaction on Postgres",
        db.maxTransactionDepth === 1, { maxTransactionDepth: db.maxTransactionDepth });
    }

    // (c) A readiness report for an unowned dependent that shares the
    // prerequisite's parent must not queue a round of its own.
    const sharedParent = await post("/api/issues", {
      title: "Shared parent",
      status: "in_progress",
      assignee_type: "agent",
      assignee_id: agent.id,
    });
    const sharedParentId = sharedParent.body.id as string;
    const donePrereq = await post("/api/issues", {
      title: "Sibling prerequisite",
      status: "in_progress",
      parent_issue_id: sharedParentId,
    });
    const readySibling = await post("/api/issues", {
      title: "Ready sibling",
      status: "backlog",
      parent_issue_id: sharedParentId,
      assignee_type: "member",
      assignee_id: human.id,
      blocked_by: [donePrereq.body.id],
    });
    const sharedRoundsBefore = tasksOf(sharedParentId).filter((task) => task.status === "queued").length;
    await json(`/api/issues/${donePrereq.body.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    const sharedRounds = tasksOf(sharedParentId).filter((task) => task.status === "queued");
    // The parent owner already had one queued round (its own assign-on-create
    // dispatch). The readiness line must ride along in that round's report
    // rather than queuing a second one.
    check("a shared-parent readiness report adds no extra round",
      sharedRounds.length === sharedRoundsBefore, {
      before: sharedRoundsBefore, after: sharedRounds.length,
    });
    check("exactly one round is queued on the shared parent", sharedRounds.length === 1, {
      rounds: sharedRounds.length,
    });
    // System comments store `type = "system"`; the notification kind lives in the
    // session-event metadata, so filter on the body instead.
    const sharedReports = store.listIssueComments(sharedParentId)
      .filter((comment) => comment.type === "system");
    check("the merged report mentions the ready sibling",
      sharedReports.some((comment) => comment.body.includes(readySibling.body.identifier)), {
      bodies: sharedReports.map((comment) => comment.body.slice(0, 120)),
    });
    check("the merged report mentions the prerequisite",
      sharedReports.some((comment) => comment.body.includes(donePrereq.body.identifier)), {});
    check("the ready sibling records the merge",
      store.listIssueActivity(readySibling.body.id)
        .some((entry) => entry.type === "dependency_satisfied"
          && (entry.data as Record<string, unknown>)?.mergedIntoPrerequisiteReport === true), {});
    check("the ready sibling stays parked",
      store.getIssue(readySibling.body.id)?.status === "backlog", {
      status: store.getIssue(readySibling.body.id)?.status,
    });

    // ── MUL-409 fix round 2: the task-creation gate ────────────────────────
    //
    // (d) A waiting issue cannot acquire a first round from any path, and the
    // only override is the audited member force on the status write.
    const gatedPrereq = await post("/api/issues", { title: "Gate prerequisite", status: "in_progress" });
    const gated = await post("/api/issues", {
      title: "Gated child",
      status: "todo",
      parent_issue_id: parentId,
      assignee_type: "agent",
      assignee_id: agent.id,
      blocked_by: [gatedPrereq.body.id],
    });
    const gatedId = gated.body.id as string;
    check("gated child parks in backlog", gated.body.status === "backlog", { status: gated.body.status });

    const rerun = await json(`/api/issues/${gatedId}/rerun`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Agent-ID": agent.id },
      body: JSON.stringify({ agent_id: agent.id }),
    });
    check("agent rerun on a waiting issue answers 409 dependencies_unmet",
      rerun.status === 409 && rerun.body.code === "dependencies_unmet", {
      status: rerun.status, code: rerun.body.code,
    });
    const taskCreate = await post("/api/multiremi/tasks", {
      agentId: agent.id,
      issueId: gatedId,
      prompt: "start the gated issue",
    });
    check("task create on a waiting issue answers 409 dependencies_unmet",
      taskCreate.status === 409 && taskCreate.body.code === "dependencies_unmet", {
      status: taskCreate.status, code: taskCreate.body.code,
    });
    check("no round was created by either attempt", tasksOf(gatedId).length === 0, {
      tasks: tasksOf(gatedId).length,
    });

    // The assign route ignores a body-supplied force: still waiting, still no
    // round, and no override record.
    const assignForced = await post(`/api/multiremi/issues/${gatedId}/assign`, {
      assigneeType: "agent",
      assigneeId: agent.id,
      force: true,
    });
    check("assign with a body force leaves the issue waiting",
      store.getIssue(gatedId)?.status === "backlog", { status: store.getIssue(gatedId)?.status });
    check("assign with a body force creates no round", tasksOf(gatedId).length === 0, {
      tasks: tasksOf(gatedId).length,
    });
    check("assign with a body force records no override",
      !store.listIssueActivity(gatedId).some((entry) => entry.type === "dependency_force_started"), {});

    // The one supported override: the member status write, which dispatches and
    // records the decision.
    const forcedOver = await json(`/api/issues/${gatedId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "todo", force: true }),
    });
    check("the member status override is accepted", forcedOver.status === 200, {
      status: forcedOver.status, code: forcedOver.body.code,
    });
    check("the override dispatches exactly one round", tasksOf(gatedId).length === 1, {
      tasks: tasksOf(gatedId).length,
    });
    check("the override is audited exactly once",
      store.listIssueActivity(gatedId).filter((entry) => entry.type === "dependency_force_started").length === 1, {});

    // (d2) A forged structural exemption must not open the gate either. This
    // needs an issue that is still waiting, so build a fresh one: the issue
    // above was already force-started.
    const forgedPrereq = await post("/api/issues", { title: "Forged prerequisite", status: "in_progress" });
    const forgedTarget = await post("/api/issues", {
      title: "Forged target",
      status: "todo",
      parent_issue_id: parentId,
      assignee_type: "agent",
      assignee_id: agent.id,
      blocked_by: [forgedPrereq.body.id],
    });
    const forgedId = forgedTarget.body.id as string;
    check("forged target starts parked", forgedTarget.body.status === "backlog", { status: forgedTarget.body.status });

    for (const forged of [{ attempt: 2 }, { preserveIssueStatus: true }, { preserve_issue_status: true }]) {
      const attempt = await post("/api/multiremi/tasks", {
        agentId: agent.id,
        issueId: forgedId,
        prompt: "forged exemption",
        ...forged,
      });
      check(`task create with ${Object.keys(forged)[0]} is refused`,
        attempt.status === 409 && attempt.body.code === "dependencies_unmet", {
        status: attempt.status, code: attempt.body.code,
      });
    }
    check("no forged exemption created a round", tasksOf(forgedId).length === 0, {
      tasks: tasksOf(forgedId).length,
    });

    // Batch force must not cross the gate either; the member PATCH still does.
    const batchedForce = await post("/api/issues/batch-update", {
      issue_ids: [forgedId],
      updates: { status: "todo", force: true },
    });
    check("batch force leaves a waiting issue parked",
      batchedForce.status === 200 && store.getIssue(forgedId)?.status === "backlog", {
      http: batchedForce.status, status: store.getIssue(forgedId)?.status,
    });
    check("batch force creates no round", tasksOf(forgedId).length === 0, { tasks: tasksOf(forgedId).length });
    check("batch force records no override",
      !store.listIssueActivity(forgedId).some((entry) => entry.type === "dependency_force_started"), {});

    // (e) A comment on a waiting issue lands, but the round it would have
    // queued is held and reported.
    const commentResponse = await post(`/api/issues/${gatedPrereq.body.id}/comments`, {
      body: "a plain comment on a prerequisite",
      author_type: "member",
      author_id: human.id,
    });
    check("a comment on a prerequisite still lands", commentResponse.status < 300, { status: commentResponse.status });

    // (f) The forced issue's prerequisite finishing must not add a second round.
    const roundsBeforeGatedPrereqDone = tasksOf(gatedId).length;
    await json(`/api/issues/${gatedPrereq.body.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    check("a finished prerequisite adds no second round to a forced-over child",
      tasksOf(gatedId).length === roundsBeforeGatedPrereqDone, {
      before: roundsBeforeGatedPrereqDone, after: tasksOf(gatedId).length,
    });

  } finally {
    db.close();
    if (BACKEND === "postgres") {
      const cleanup = new Bun.SQL(ADMIN_URL, { max: 1 });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      await cleanup.end();
    }
  }

  const report = {
    issue: "MUL-409",
    acceptance: "MUL-400 E3 acceptance 2 + MUL-458 early human comment — parent + 3 serially dependent children",
    database: BACKEND === "postgres" ? "throwaway PG database, dropped after the run" : "in-memory SQLite database",
    serverCode: `real MultiremiStore over ${BACKEND === "postgres" ? "PostgresSyncDatabase" : "bun:sqlite"} + real HTTP app`,
    testDoubles: "execution agent and worker only (no provider is run)",
    ranAt: new Date().toISOString(),
    steps,
    failures,
    result: failures.length === 0 ? "pass" : "fail",
  };
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n${report.result.toUpperCase()}: ${steps.length} steps, ${failures.length} failures`);
  console.log(`report: ${OUT_PATH}`);
  if (failures.length) {
    console.error(`failed steps:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  }
}

await main();
