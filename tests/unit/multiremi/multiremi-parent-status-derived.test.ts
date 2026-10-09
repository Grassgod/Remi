import { createResponsibleTestIssue, createHistoricalTestIssue, seedHistoricalIssueFacts, acceptTestIssueDelivery, prepareTestIssueDelivery, replayHistoricalTestChildDone } from './helpers.js';
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

function childStatusMessages(store: Store, parentId: string, childId?: string) {
  const session = store.getOrCreateDefaultIssueSession(parentId);
  return store.listMessages(session.id).filter(message => message.message_kind === "status" && message.to_ref === "parent_owner"
    && (!childId || message.metadata.child_issue_id === childId));
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
    const parent = createResponsibleTestIssue(store, {
      title: "Parent with open children",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Open child", parentIssueId: parent.id, status: "in_progress" });

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
    const parent = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Guarded parent", status: "in_progress" });
    const [first, second] = [
      createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Child A", parentIssueId: parent.id, status: "in_progress" }),
      createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Child B", parentIssueId: parent.id, status: "blocked" }),
    ];

    for (const status of ["in_review", "done"] as const) {
      const error = catchError(() => store.updateIssue(parent.id, { status }));
      expect(error.message, status).toContain(status==='done'?"accepting its specific delivery":"unfinished child issue");
      expect(error.code, status).toBe(status==='done'?"issue_delivery_acceptance_required":"issue_status_held");
      expect(status==='done'?store.countOpenChildIssues(parent.id):error.details?.openChildren, status).toBe(2);
      expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    }

    // A blocked child counts as unfinished: closing the others is not enough.
    acceptTestIssueDelivery(store, first!.id);
    expect(catchError(() => store.updateIssue(parent.id, { status: "in_review" })).details?.openChildren).toBe(1);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");

    // With every child closed the guard stops applying.
    store.updateIssue(second!.id, { status: "cancelled" });
    expect(store.updateIssue(parent.id, { status: "in_review" }).status).toBe("in_review");
  });

  it("lets field-only edits through on parents with children, for both identities", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Field editor owner", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Field editor", role: "member" });

    for (const [label, status] of [["in_review", "in_review"], ["done", "done"]] as const) {
      // The QA probe used the stored shape directly: a parent already sitting in
      // the target status with an open child. Build the child first, then put
      // the parent there, so the create-time re-derivation does not fight the
      // arrangement under test.
      const parent = createResponsibleTestIssue(store, {
        title: `${label} parent`,
        status: "in_progress",
        assigneeType: "agent",
        assigneeId: agent.id,
      });
      const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id,
        title: `${label} child`,
        parentIssueId: parent.id,
        status: "in_progress",
      });
      seedHistoricalIssueFacts(store,parent.id,{status});
      expect(store.getIssue(parent.id)?.status, label).toBe(status);

      // Member identity: title, description and priority are not status writes.
      const renamed = store.updateIssue(parent.id, {
        title: `${label} parent renamed`,
        description: "edited",
        priority: "urgent",
        actorType: "member",
        actorId: "local",
      });
      expect(renamed.title, label).toBe(`${label} parent renamed`);
      expect(renamed.priority, label).toBe("urgent");
      expect(renamed.status, label).toBe(status);

      // Task identity: the same edits must not trip A4, which is about `done`.
      const task = store.createTask({ agentId: agent.id, prompt: `edit ${label}` });
      const taskEdited = store.updateIssue(parent.id, {
        title: `${label} parent renamed by task`,
        priority: "low",
        actorType: "agent",
        actorId: agent.id,
        parentTaskId: task.id,
      });
      expect(taskEdited.title, label).toBe(`${label} parent renamed by task`);
      expect(taskEdited.priority, label).toBe("low");
      expect(taskEdited.status, label).toBe(status);
      expect(child.id).toBeTruthy();
    }
  });

  it("keeps the auto-retitle and merge-completion paths working on a parent", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "System writer owner", provider: "codex" });
    const inReviewParent = createResponsibleTestIssue(store, {
      title: "Auto retitle parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Open child", parentIssueId: inReviewParent.id, status: "in_progress" });
    store.updateIssue(inReviewParent.id, { status: "in_review", force: true });
    expect(store.getIssue(inReviewParent.id)?.status).toBe("in_review");

    // issue-title/service.ts: a bare title write, exactly like the retitler.
    const retitled = store.updateIssue(inReviewParent.id, { title: "Luna generated title" });
    expect(retitled.title).toBe("Luna generated title");
    expect(retitled.status).toBe("in_review");

    // A server-only parent guard bypass cannot substitute for a delivery receipt.
    const mergeParent = createResponsibleTestIssue(store, {
      title: "Merge parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    store.updateIssue(mergeParent.id, { status: "in_review", force: true });
    expect(catchError(()=>store.updateIssue(mergeParent.id,{status:'done'},{allowParentStatusGuardBypass:true})).code).toBe('issue_delivery_acceptance_required');
    const merged = acceptTestIssueDelivery(store, mergeParent.id);
    expect(merged.status).toBe("done");
    // The arrangement above reached in_review through a member force, which is
    // itself audited; the merge write must not add a second one.
    expect(activityOf(store, mergeParent.id, "issue_status_forced")).toHaveLength(1);
  });

  it("derives an in_review parent back to in_progress when a child changes, and never moves done/cancelled", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const parent = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Deriving parent", status: "in_review" });
    const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Late child", parentIssueId: parent.id, status: "in_progress" });

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
      const terminalParent = createHistoricalTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: `Terminal ${status} parent`, status });
      const lateChild = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id,
        title: `Late child of ${status}`,
        parentIssueId: terminalParent.id,
        status: "in_progress",
      });
      store.updateIssue(lateChild.id,{status:'cancelled'});
      expect(store.getIssue(terminalParent.id)?.status, status).toBe(status);
      expect(activityOf(store, terminalParent.id, "parent_status_derived")).toHaveLength(0);
    }
  });

  it("lets a member force the guard and audits it, while refusing a task identity on every writer", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Frozen owner", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Owner", role: "member" });
    const parent = createHistoricalTestIssue(store, {
      title: "Force parent",
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Open child", parentIssueId: parent.id, status: "in_progress" });

    // A member force cannot replace specific delivery acceptance, including legacy execution.
    expect(catchError(() => store.updateIssue(parent.id, { status: "done" })).code).toBe("issue_delivery_acceptance_required");
    expect(catchError(()=>store.updateIssue(parent.id, { status: "done", force: true })).code).toBe('issue_delivery_acceptance_required');
    expect(store.getIssue(parent.id)?.status).toBe('in_progress');
    const forced = activityOf(store, parent.id, "issue_status_forced");
    expect(forced).toHaveLength(0);
    expect(store.countOpenChildIssues(parent.id)).toBe(1);

    // The same fields through the API: a task identity is refused, a member is not.
    const otherParent = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Task identity parent", status: "in_progress" });
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Task identity child", parentIssueId: otherParent.id, status: "in_progress" });
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
    expect(plainDone.status).toBe(409);
    expect((await plainDone.json()).code).toBe("issue_delivery_acceptance_required");

    // A4 through BOTH batch routes: the batch writer now carries the caller's
    // identity, so a task cannot close a parent by taking the long way round.
    for (const path of ["/api/multiremi/issues/batch-update", "/api/issues/batch-update"]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ issue_ids: [otherParent.id], updates: { status: "done" } }),
      });
      expect(response.status, path).toBe(403);
      expect((await response.json()).code, path).toBe("parent_done_requires_member");
      expect(store.getIssue(otherParent.id)?.status, path).toBe("in_progress");
    }

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

    // The override reached through HTTP is audited like the store-level one.
    const apiForced = activityOf(store, otherParent.id, "issue_status_forced");
    expect(apiForced).toHaveLength(1);
    expect(apiForced[0]?.data).toMatchObject({
      status: "in_review",
      previousStatus: "in_progress",
      openChildren: 1,
    });

    // A member may force through batch update as well, with the same audit.
    const batchForced = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { Authorization: `Bearer ${memberCredential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [otherParent.id], updates: { status: "done", force: true } }),
    });
    expect(batchForced.status).toBe(409);
    expect((await batchForced.json()).code).toBe('issue_delivery_acceptance_required');
    expect(store.getIssue(otherParent.id)?.status).toBe("in_review");
    expect(activityOf(store, otherParent.id, "issue_status_forced")).toHaveLength(1);
  });

  it("ignores every injected parent-status bypass spelling on all four write routes", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Injection caller", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Injection owner", role: "member" });
    const callerTask = store.createTask({ agentId: agent.id, prompt: "caller" });
    const credential = await store.createTaskAccessToken(callerTask, "local");
    const app = createMultiremiApp({ store });

    // Every shape QA's probes used, plus the `options` nesting the store reads
    // as its own third argument — none of them may reach the guard.
    const injectedFields = [
      { bypass_parent_status_guard: true },
      { bypassParentStatusGuard: true },
      { allowParentStatusGuardBypass: true },
      { allow_parent_status_guard_bypass: true },
      { holdParentStatus: true },
      { hold_parent_status: true },
      { holdParentStatus: false, bypass_parent_status_guard: true },
      { options: { allowParentStatusGuardBypass: true } },
      { options: { holdParentStatus: true, allowParentStatusGuardBypass: true } },
      { acceptedDeliveryId: 'forged-receipt' },
      { accepted_delivery_id: 'forged-receipt' },
      { options: { acceptedDeliveryId: 'forged-receipt', allowParentStatusGuardBypass: true } },
    ];

    const patchRoutes = ["/api/multiremi/issues", "/api/issues"];
    const batchRoutes = ["/api/multiremi/issues/batch-update", "/api/issues/batch-update"];

    let index = 0;
    for (const injected of injectedFields) {
      // A fresh parent per attempt, so a prior partial write cannot mask the next.
      const parent = createHistoricalTestIssue(store, {
        title: `Injection parent ${index++}`,
        status: "in_progress",
        assigneeType: "member",
        assigneeId: member.id,
      });
      createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Injection child", parentIssueId: parent.id, status: "in_progress" });
      const label = JSON.stringify(injected);

      // The two PATCH routes, task identity: A4 refuses before anything else.
      for (const path of patchRoutes) {
        const response = await app.request(`${path}/${parent.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done", ...injected }),
        });
        expect(response.status, `${path} ${label}`).toBe(409);
        expect((await response.json()).code, `${path} ${label}`).toBe("issue_delivery_acceptance_required");
        expect(store.getIssue(parent.id)?.status, `${path} ${label}`).toBe("in_progress");
      }

      // The two batch routes, same identity, same refusal.
      for (const path of batchRoutes) {
        const response = await app.request(path, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ issue_ids: [parent.id], updates: { status: "done", ...injected } }),
        });
        expect(response.status, `${path} ${label}`).toBe(403);
        expect((await response.json()).code, `${path} ${label}`).toBe("parent_done_requires_member");
        expect(store.getIssue(parent.id)?.status, `${path} ${label}`).toBe("in_progress");
      }

      // A member may not take the guard out through the body either. The child
      // here is still open, so the stored decision is refused by the open-children
      // rule; the A1 variant below covers the closed-children case.
      const memberAttempt = await app.request(`/api/multiremi/issues/${parent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", ...injected }),
      });
      expect(memberAttempt.status, `member ${label}`).toBe(409);
      expect((await memberAttempt.json()).code, `member ${label}`).toBe("issue_delivery_acceptance_required");
      expect(store.getIssue(parent.id)?.status, `member ${label}`).toBe("in_progress");
      expect(activityOf(store, parent.id, "parent_status_held"), label).toHaveLength(0);
      expect(activityOf(store, parent.id, "issue_status_forced"), label).toHaveLength(0);

      // The other half of QA's finding: an AGENT-owned parent whose children are
      // all finished but which has no result-bearing round yet. A member request
      // is refused by A1, and the injected bypass must not lift that either.
      const agentParent = createResponsibleTestIssue(store, {
        title: `Injection A1 parent ${index++}`,
        status: "in_progress",
        assigneeType: "agent",
        assigneeId: agent.id,
      });
      acceptTestIssueDelivery(store, createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Injection A1 child", parentIssueId: agentParent.id, status: "in_progress" }).id);
      const memberA1 = await app.request(`/api/multiremi/issues/${agentParent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done", ...injected }),
      });
      expect(memberA1.status, `member A1 ${label}`).toBe(409);
      expect((await memberA1.json()).code, `member A1 ${label}`).toBe("issue_delivery_acceptance_required");
      expect(store.getIssue(agentParent.id)?.status, `member A1 ${label}`).toBe("in_progress");
      expect(activityOf(store, agentParent.id, "issue_status_forced"), `member A1 ${label}`).toHaveLength(0);
    }
  });

  it("refuses a body that claims a member identity on all four write routes", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Identity caller", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Identity owner", role: "member" });
    const callerTask = store.createTask({ agentId: agent.id, prompt: "caller" });
    const credential = await store.createTaskAccessToken(callerTask, "local");
    const app = createMultiremiApp({ store });

    // The route stamps `actorType`/`actorId` from the token, so both the
    // camelCase and the snake_case spellings of a forged member identity are
    // server-owned fields and get stripped before the store sees them.
    const forgedIdentities = [
      { actorType: "member" },
      { actor_type: "member" },
      { actorType: "member", actorId: "local" },
      { actor_type: "member", actor_id: "local" },
      { actorType: "member", force: true },
      { actor_type: "member", force: true },
    ];

    let index = 0;
    for (const forged of forgedIdentities) {
      const parent = createHistoricalTestIssue(store, {
        title: `Identity parent ${index++}`,
        status: "in_progress",
        assigneeType: "member",
        assigneeId: member.id,
      });
      createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Identity child", parentIssueId: parent.id, status: "in_progress" });
      const label = JSON.stringify(forged);

      for (const path of ["/api/multiremi/issues", "/api/issues"]) {
        const response = await app.request(`${path}/${parent.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status: "done", ...forged }),
        });
        // A task identity sending `force` is refused outright by the route (403
        // `issue_force_requires_member`); without `force` A4 refuses it (403
        // `parent_done_requires_member`). Either way it is 403, never a write.
        expect(response.status, `${path} ${label}`).toBe('force' in forged && forged.force ? 403 : 409);
        expect(store.getIssue(parent.id)?.status, `${path} ${label}`).toBe("in_progress");
      }

      for (const path of ["/api/multiremi/issues/batch-update", "/api/issues/batch-update"]) {
        const response = await app.request(path, {
          method: "POST",
          headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ issue_ids: [parent.id], updates: { status: "done", ...forged } }),
        });
        expect(response.status, `${path} ${label}`).toBe(403);
        expect(store.getIssue(parent.id)?.status, `${path} ${label}`).toBe("in_progress");
      }

      expect(activityOf(store, parent.id, "issue_status_forced"), label).toHaveLength(0);
      expect(activityOf(store, parent.id, "parent_status_held"), label).toHaveLength(0);
    }
  });

  it("strips a forged snake_case parent_task_id from every write route", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Forge caller", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Forge owner", role: "member" });
    const callerTask = store.createTask({ agentId: agent.id, prompt: "caller" });
    const credential = await store.createTaskAccessToken(callerTask, "local");
    // An unrelated task an attacker would like to blame in the audit record.
    const innocentTask = store.createTask({ agentId: agent.id, prompt: "innocent" });
    const app = createMultiremiApp({ store });

    const forgeBodies = [
      { parent_task_id: innocentTask.id },
      { parentTaskId: innocentTask.id },
      { parent_task_id: innocentTask.id, actor_type: "member", actor_id: "local" },
      { parent_task_id: innocentTask.id, actorType: "member", actorId: "local", force: true },
    ];

    let index = 0;
    for (const forged of forgeBodies) {
      for (const route of [
        { path: `/api/multiremi/issues/{id}`, batch: false },
        { path: `/api/issues/{id}`, batch: false },
        { path: "/api/multiremi/issues/batch-update", batch: true },
        { path: "/api/issues/batch-update", batch: true },
      ]) {
        const parent = createHistoricalTestIssue(store, {
          title: `Forge parent ${index++}`,
          status: "in_progress",
          assigneeType: "member",
          assigneeId: member.id,
        });
        createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Forge child", parentIssueId: parent.id, status: "in_progress" });
        const url = route.path.replace("{id}", parent.id);
        const response = await app.request(url, {
          method: route.batch ? "POST" : "PATCH",
          headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(route.batch
            ? { issue_ids: [parent.id], updates: { status: "done", ...forged } }
            : { status: "done", ...forged }),
        });
        // The task identity is still refused, so the forgery buys nothing.
        expect(response.status, `${url} ${JSON.stringify(forged)}`).toBe(route.batch || ('force' in forged && forged.force) ? 403 : 409);

        // A member can legitimately force; the audit must name the request's own
        // task (where present) and never the forged one.
        const memberForce = await app.request(url, {
          method: route.batch ? "POST" : "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(route.batch
            ? { issue_ids: [parent.id], updates: { status: "done", force: true, ...forged } }
            : { status: "done", force: true, ...forged }),
        });
        expect(memberForce.status, `${url} member ${JSON.stringify(forged)}`).toBe(409);
        expect((await memberForce.json()).code).toBe('issue_delivery_acceptance_required');
        const forced = activityOf(store, parent.id, "issue_status_forced");
        expect(forced, url).toHaveLength(0);
        expect(forced[0]?.data?.sourceTaskId, `${url} ${JSON.stringify(forged)}`).toBeUndefined();
        expect(forced[0]?.data?.parentTaskId, `${url} ${JSON.stringify(forged)}`).toBeUndefined();
        // ... and the wakeup round the child report queues carries no forged
        // lineage either.
        const rounds = store.listTasksForIssue(parent.id);
        expect(rounds.every((task) => task.parentTaskId !== innocentTask.id), url).toBe(true);
      }
    }
  });

  it("refuses the whole batch without writing any row when one row is guarded", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Batch caller", provider: "codex" });
    const member = store.createWorkspaceMember({ name: "Batch owner", role: "member" });
    const callerTask = store.createTask({ agentId: agent.id, prompt: "caller" });
    const credential = await store.createTaskAccessToken(callerTask, "local");
    const app = createMultiremiApp({ store });

    for (const path of ["/api/multiremi/issues/batch-update", "/api/issues/batch-update"]) {
      // [plain, guarded parent, plain]: only the middle row is refused, and no
      // row may be written.
      const plainA = createHistoricalTestIssue(store, { title: `Batch plain A ${path}`, status: "in_progress", assigneeType: "member", assigneeId: member.id });
      const parent = createHistoricalTestIssue(store, { title: `Batch parent ${path}`, status: "in_progress", assigneeType: "member", assigneeId: member.id });
      createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Batch parent child", parentIssueId: parent.id, status: "in_progress" });
      const plainB = createHistoricalTestIssue(store, { title: `Batch plain B ${path}`, status: "in_progress", assigneeType: "member", assigneeId: member.id });

      const response = await app.request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ issue_ids: [plainA.id, parent.id, plainB.id], updates: { status: "done" } }),
      });
      expect(response.status, path).toBe(403);
      const body = await response.json();
      expect(body.code, path).toBe("parent_done_requires_member");
      expect(body.rejected_issue_ids, path).toEqual([parent.id]);

      // All-or-nothing: neither the rows before nor after the refused one moved.
      expect(store.getIssue(plainA.id)?.status, path).toBe("in_progress");
      expect(store.getIssue(parent.id)?.status, path).toBe("in_progress");
      expect(store.getIssue(plainB.id)?.status, path).toBe("in_progress");
      expect(activityOf(store, plainA.id, "issue_status_forced"), path).toHaveLength(0);
      expect(activityOf(store, parent.id, "issue_status_forced"), path).toHaveLength(0);
    }
  });

  it("keeps a batch update that clears the guard to a status the rows may enter", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Batch mover", provider: "codex" });
    const callerTask = store.createTask({ agentId: agent.id, prompt: "caller" });
    const credential = await store.createTaskAccessToken(callerTask, "local");
    const app = createMultiremiApp({ store });

    // `in_review` is not a member-only terminal, so the pre-flight lets the
    // batch through; only `done` on a parent is A4's business.
    const parent = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Non-terminal batch parent", status: "in_progress" });
    const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Non-terminal child", parentIssueId: parent.id, status: "in_progress" });
    const response = await app.request("/api/issues/batch-update", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ issue_ids: [child.id], updates: { status: "blocked" } }),
    });
    expect(response.status).toBe(200);
    expect(store.getIssue(child.id)?.status).toBe("blocked");
  });

  it("records one activity and nothing else when a child ends after the parent closed", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_closed_parent", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Closed parent owner", provider: "claude", runtimeId: runtime.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Already closed parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const failingChild = createResponsibleTestIssue(store, {
      title: "Child that fails late",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    seedHistoricalIssueFacts(store,parent.id,{status:'done'});
    expect(store.getIssue(parent.id)?.status).toBe("done");

    // The child fails through the task path: the parent must be told ONCE, by
    // activity only — no comment, no round, no status change.
    const failingTask = store.createTask({ agentId: agent.id, issueId: failingChild.id, prompt: "explode" });
    runTask(store, runtime.id, failingTask.id);
    store.failTask(failingTask.id, { error: "boom" });
    expect(store.getIssue(failingChild.id)?.status).toBe("blocked");

    const commentsBefore = store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system").length;
    const roundsBefore = store.listTasksForIssue(parent.id).length;
    expect(activityOf(store, parent.id, "child_status_after_parent_closed")).toHaveLength(1);
    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system")).toHaveLength(commentsBefore);
    expect(store.listTasksForIssue(parent.id)).toHaveLength(roundsBefore);

    // Cancellation is still a legal terminal transition after parent closure.
    const doneChild = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id,
      title: "Child that finishes late",
      parentIssueId: parent.id,
      status: "in_progress",
    });
    store.updateIssue(doneChild.id,{status:'cancelled'});
    expect(store.getIssue(parent.id)?.status).toBe("done");
    const late = activityOf(store, parent.id, "child_status_after_parent_closed");
    expect(late).toHaveLength(2);
    expect(late.map((entry) => entry.data?.outcome)).toEqual(["failed", "cancelled"]);
    expect(store.listIssueComments(parent.id).filter((comment) => comment.authorType === "system"))
      .toHaveLength(commentsBefore);
    expect(store.listTasksForIssue(parent.id)).toHaveLength(roundsBefore);
  });

  it("does not apply A4 to an agent closing an issue without children", async () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Plain closer", provider: "codex" });
    const plain = createResponsibleTestIssue(store, {
      title: "Childless issue",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const callerTask = store.createTask({ agentId: agent.id, prompt: "caller" });
    const credential = await store.createTaskAccessToken(callerTask, "local");
    const app = createMultiremiApp({ store });

    const response = await app.request(`/api/issues/${plain.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('issue_delivery_acceptance_required');
    expect(store.getIssue(plain.id)?.status).toBe("in_progress");
    expect(acceptTestIssueDelivery(store,plain.id).status).toBe('done');
  });

  it.each(["/api/issues", "/api/multiremi/issues"])("requires configuration and concrete human acceptance for unassigned parents on %s", async (path) => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const memberCredential = await store.createAccessToken({ name: "Closing member", type: "pat", workspaceId: "local", userId: "local" });
    const agent = store.createAgent({ name: "Unassigned parent caller", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "Try closing an unassigned parent" });
    const taskCredential = await store.createTaskAccessToken(task, "local");
    const app = createMultiremiApp({ store });

    for (const batch of [false, true]) {
      const human = store.findWorkspaceMemberForUser('local','local')!;
      const parent = createResponsibleTestIssue(store, { title: `Unassigned parent ${batch}`, status: "in_progress", responsibleMemberId:human.id });
      const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Unfinished child", parentIssueId: parent.id, status: "in_progress" });
      const blockedChild = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Blocked child", parentIssueId: parent.id, status: "blocked" });
      const close = (token: string) => app.request(batch ? `${path}/batch-update` : `${path}/${parent.id}`, {
        method: batch ? "POST" : "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(batch ? { issue_ids: [parent.id], updates: { status: "done" } } : { status: "done" }),
      });

      const held = await close(memberCredential.token);
      expect(held.status).toBe(409);
      expect(await held.json()).toMatchObject(batch ? {code:'issue_status_held',reason:'children_open',open_children:2} : {code:'issue_delivery_acceptance_required'});
      expect(store.countOpenChildIssues(parent.id)).toBe(2);
      expect(()=>prepareTestIssueDelivery(store,child.id)).toThrow('complete test Issue responsibility');
      expect(store.resolveIssueResponsibility(parent.id).executionOwner).toBeNull();
      store.updateIssue(parent.id,{assigneeType:'agent',assigneeId:agent.id,actorType:'member',actorId:human.id});
      acceptTestIssueDelivery(store, child.id);
      const stillHeld = await close(memberCredential.token);
      expect(stillHeld.status).toBe(409);
      expect(await stillHeld.json()).toMatchObject(batch ? {code:'issue_status_held',reason:'children_open',open_children:1} : {code:'issue_delivery_acceptance_required'});
      expect(store.countOpenChildIssues(parent.id)).toBe(1);
      store.updateIssue(blockedChild.id, { status: "cancelled" });

      const agentAttempt = await close(taskCredential.token);
      expect(agentAttempt.status).toBe(batch ? 403 : 409);
      expect(await agentAttempt.json()).toMatchObject({ code: batch ? "parent_done_requires_member" : 'issue_delivery_acceptance_required' });
      expect(store.getIssue(parent.id)?.status).toBe("in_progress");

      const completed = await close(memberCredential.token);
      expect(completed.status).toBe(409);
      expect((await completed.json()).code).toBe('issue_delivery_acceptance_required');
      const pending = prepareTestIssueDelivery(store,parent.id);
      const accepted = await app.request(`/api/issues/${parent.id}/deliveries/${pending.delivery.id}/respond`, {
        method:'POST',headers:{Authorization:`Bearer ${memberCredential.token}`,'Content-Type':'application/json'},
        body:JSON.stringify({action:'accept',revision:pending.delivery.responsibilityRevision}),
      });
      expect(accepted.status).toBe(200);
      expect(store.getIssue(parent.id)).toMatchObject({ status: "done", assigneeType:'agent',assigneeId:agent.id });
      expect(activityOf(store, parent.id, "issue_status_forced")).toHaveLength(0);
    }
  });

  it("requires formal summaries and keeps legacy member execution unresolved until explicitly configured", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_summary", name: "Worker", provider: "claude", maxConcurrency: 4 });
    const agent = store.createAgent({ name: "Summary owner", provider: "claude", runtimeId: runtime.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Summary parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Only child", parentIssueId: parent.id, status: "in_progress" });
    acceptTestIssueDelivery(store, child.id);

    // No result-bearing round since the child closed: `done` is refused.
    expect(catchError(() => store.updateIssue(parent.id, { status: "done" })).code).toBe("issue_delivery_acceptance_required");

    // Finish the report round E2 queued for the owner; its result is the
    // "final summary" signal A1 looks for.
    const round = store.listTasksForIssue(parent.id).find((task) => task.status === "queued")!;
    runTask(store, runtime.id, round.id);
    store.completeTask(round.id, { output: "the last child is merged and verified" });
    expect(catchError(() => store.updateIssue(parent.id, { status: "done" })).code).toBe('issue_delivery_acceptance_required');
    expect(acceptTestIssueDelivery(store,parent.id,'the last child is merged and verified').status).toBe('done');

    // A member owner needs no machine-checked summary.
    const member = store.createWorkspaceMember({ name: "Human owner", role: "member" });
    const memberParent = createHistoricalTestIssue(store, {
      title: "Member summary parent",
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
      responsibleMemberId:member.id,
    });
    const memberChild = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id,
      title: "Member child",
      parentIssueId: memberParent.id,
      status: "in_progress",
    });
    expect(catchError(() => store.updateIssue(memberParent.id, { status: "done" })).code).toBe("issue_delivery_acceptance_required");
    expect(()=>prepareTestIssueDelivery(store,memberChild.id)).toThrow('complete test Issue responsibility');
    expect(store.resolveIssueResponsibility(memberParent.id).executionOwner).toBeNull();
    store.updateIssue(memberParent.id,{assigneeType:'agent',assigneeId:agent.id,actorType:'member',actorId:member.id});
    acceptTestIssueDelivery(store, memberChild.id);
    expect(acceptTestIssueDelivery(store,memberParent.id).status).toBe("done");
  });

  it("does not touch done/cancelled parents and writes no held noise on them", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_done_parent", name: "Worker", provider: "claude" });
    const agent = store.createAgent({ name: "Done parent owner", provider: "claude", runtimeId: runtime.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Done parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Open child", parentIssueId: parent.id, status: "in_progress" });
    seedHistoricalIssueFacts(store,parent.id,{status:'done'});

    // A task finishing on that Issue derives in_review; the Issue is a settled
    // human decision, so nothing may move AND no misleading held row appears.
    const task = store.createTask({ agentId: agent.id, issueId: parent.id, prompt: "round" });
    runTask(store, runtime.id, task.id);
    store.completeTask(task.id, { output: "done anyway" });

    expect(store.getIssue(parent.id)?.status).toBe("done");
    expect(activityOf(store, parent.id, "parent_status_held")).toHaveLength(0);
  });

  it("keeps the human-request in_review transient out of guard B", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_ask", name: "Worker", provider: "claude",daemonId:'parent-question-host' });
    const agent = store.createAgent({ name: "Asking owner", provider: "claude", runtimeId: runtime.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Asking parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Open child", parentIssueId: parent.id, status: "in_progress" });

    const task = store.createTask({ agentId: agent.id, issueId: parent.id, prompt: "ask the human" });
    runTask(store, runtime.id, task.id);
    const turn = store.getTurnForAttempt(task.id)!;
    const request = store.getDaemonTurnBridge().rpc('turn.decision',{
      turn_id:turn.id,attempt_id:task.id,dedupe_key:`parent-question:${task.id}`,wait_id:`wait:${task.id}`,
      body_md:'Which one?',options:[],metadata:{kind:'question',questions:[{question:'Which one?'}]},
    },{runtimeId:runtime.id,daemonId:'parent-question-host',workspaceId:'local'});
    expect(request.ok).toBeTrue();
    const question = store.getQuestion(String(request.message_id))!;

    // ADR 0003: waiting for an answer legitimately parks the Issue in review.
    expect(question.status).toBe("pending");
    expect(store.getIssue(parent.id)?.status).toBe("in_review");
    expect(activityOf(store, parent.id, "parent_status_held")).toHaveLength(0);

    // Answering puts it back to in_progress, as the resume path always did.
    store.answerQuestion(question.id,{expected_route_revision:question.route_revision,response:{answer:'that one'}},
      {type:'member',id:store.resolveIssueResponsibility(parent.id).rootHuman!.id});
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
  });

  it("derives an in_review parent when a child is created under it, and when a child is moved away", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const parent = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Creation parent", status: "in_review" });

    // createIssue is the third entry point the plan names.
    const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id,
      title: "New child",
      parentIssueId: parent.id,
      status: "backlog",
    });
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    expect(activityOf(store, parent.id, "parent_status_derived")).toHaveLength(1);

    // Moving a child away is a child event for the family it LEFT. Park the old
    // parent back at in_review with another open child, then move one child out:
    // the old parent re-derives, and so does the new parent that just gained a
    // child while sitting at in_review.
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Sibling that stays", parentIssueId: parent.id, status: "in_progress" });
    store.updateIssue(parent.id, { status: "in_review", force: true });
    expect(store.getIssue(parent.id)?.status).toBe("in_review");

    const otherParent = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Other parent", status: "in_progress" });
    store.updateIssue(otherParent.id, { status: "in_review" });
    expect(store.getIssue(otherParent.id)?.status).toBe("in_review");

    store.updateIssue(child.id, { parentIssueId: otherParent.id });
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
    expect(store.getIssue(otherParent.id)?.status).toBe("in_progress");
    // One from the create under the old parent, one from this move.
    expect(activityOf(store, parent.id, "parent_status_derived")).toHaveLength(2);
    expect(activityOf(store, otherParent.id, "parent_status_derived")).toHaveLength(1);
  });

  it("does not park a parent at todo when a member closes a child by hand", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const agent = store.createAgent({ name: "Parent owner", provider: "codex" });
    const parent = createResponsibleTestIssue(store, {
      title: "In-review parent",
      status: "in_review",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Manual child", parentIssueId: parent.id, status: "in_progress" });
    // A second child stays open, so the parent is still mid-flight when the
    // wakeup round is created — the case that used to reset it to todo.
    createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: "Still open child", parentIssueId: parent.id, status: "in_progress" });

    acceptTestIssueDelivery(store, child.id);

    // The wakeup round exists and the parent stays open rather than going to todo.
    const tasks = store.listTasksForIssue(parent.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("queued");
    expect(store.getIssue(parent.id)?.status).not.toBe("todo");
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
  });
});

describe("MUL-400 hook ordering — the notification cannot roll back a status change", () => {
  it("commits the task terminal state and the child status even when the hook throws", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_hook_fail", name: "Worker", provider: "claude" });
    const agent = store.createAgent({ name: "Hook victim", provider: "claude", runtimeId: runtime.id });
    const parentRuntime = store.registerRuntime({ name: "Parent notifications", provider: "claude" });
    const parentAgent = store.createAgent({ name: "Parent notifier", provider: "claude", runtimeId: parentRuntime.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Hook parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: parentAgent.id,
    });
    const child = createResponsibleTestIssue(store, {
      title: "Hook child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    // Break the notification hook the way a DB/comment failure would.
    const original = store.notifyChildStatusChange.bind(store);
    let calls = 0;
    store.notifyChildStatusChange = ((...args: Parameters<typeof original>) => {
      calls += 1;
      throw new Error("notification exploded");
    }) as typeof original;

    const task = store.createTask({ agentId: agent.id, issueId: child.id, prompt: "finish" });
    runTask(store, runtime.id, task.id);
    store.completeTask(task.id, { output: "child round finished" });
    expect(calls).toBeGreaterThan(0);

    // The task and the child's own status are committed regardless.
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(store.getIssue(child.id)?.status).toBe("in_review");

    // And the same holds for the failure path.
    const failing = createResponsibleTestIssue(store, {
      title: "Hook failure child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const failingTask = store.createTask({ agentId: agent.id, issueId: failing.id, prompt: "explode" });
    runTask(store, runtime.id, failingTask.id);
    store.failTask(failingTask.id, { error: "boom" });
    expect(store.getTask(failingTask.id)?.status).toBe("failed");
    expect(store.getIssue(failing.id)?.status).toBe("blocked");

    store.notifyChildStatusChange = original as typeof store.notifyChildStatusChange;
  });

  it("still notifies after a terminal transition commits", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_hook_ok", name: "Worker", provider: "claude" });
    const agent = store.createAgent({ name: "Hook owner", provider: "claude", runtimeId: runtime.id });
    const parentRuntime = store.registerRuntime({ name: "Parent notifications", provider: "claude" });
    const parentAgent = store.createAgent({ name: "Parent notifier", provider: "claude", runtimeId: parentRuntime.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Ordered parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: parentAgent.id,
    });
    const child = createResponsibleTestIssue(store, {
      title: "Ordered child",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    // A task failure is the ending the task path itself produces (the child
    // Issue lands on `blocked`), so it exercises the moved hook end to end.
    const task = store.createTask({ agentId: agent.id, issueId: child.id, prompt: "explode" });
    runTask(store, runtime.id, task.id);
    store.failTask(task.id, { error: "boom" });

    expect(store.getIssue(child.id)?.status).toBe("blocked");
    const messages = childStatusMessages(store, parent.id, child.id);
    expect(messages).toHaveLength(3);
    expect(messages.map(message => message.metadata.child_status)).toEqual(["todo", "in_progress", "blocked"]);
    expect(messages.at(-1)?.body_md).toContain("failed");
    expect(messages.at(-1)?.metadata.outcome).toBe("failed");
    const rounds = store.listTasksForIssue(parent.id);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.status).toBe("queued");
    expect(messages.every(message => message.to_agent_id === parentAgent.id)).toBeTrue();
    const offered = store.getDaemonTurnBridge().offerInput(store.getTaskWithAgent(rounds[0]!.id)!);
    expect(offered.input_messages.some(message => message.id === messages.at(-1)!.id)).toBeTrue();
  });
});

describe("MUL-400 E2 — child endings notify the parent owner", () => {
  it("notifies an agent owner for all four endings, distinguishing failed from a human block", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_notify", name: "Worker", provider: "claude", maxConcurrency: 8 });
    const agent = store.createAgent({ name: "Notified owner", provider: "claude", runtimeId: runtime.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Notification parent",
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    const childRuntime = store.registerRuntime({ name: "Child worker", provider: "claude" });
    const childAgent = store.createAgent({ name: "Child owner", provider: "claude", runtimeId: childRuntime.id });
    const cases: Array<{ outcome: string; issueId: string; apply: () => void }> = [];
    // The task-failure ending runs first: the parent wakeup round it queues would
    // otherwise be the natural target of `runTask`'s claim loop.
    const failingChild = createResponsibleTestIssue(store, {
      title: "Child failed",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: childAgent.id,
    });
    cases.push({
      outcome: "failed",
      issueId: failingChild.id,
      apply: () => {
        const task = store.createTask({ agentId: childAgent.id, issueId: failingChild.id, prompt: "explode" });
        runTask(store, childRuntime.id, task.id);
        store.failTask(task.id, { error: "boom" });
      },
    });
    for (const [label, status] of [["done", "done"], ["cancelled", "cancelled"], ["blocked", "blocked"]] as const) {
      const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id,
        title: `Child ${label}`,
        parentIssueId: parent.id,
        status: "in_progress",
      });
      cases.push({ outcome: label, issueId: child.id, apply: () => status==='done' ? acceptTestIssueDelivery(store,child.id) : store.updateIssue(child.id, { status }) });
    }

    for (const testCase of cases) {
      const before = childStatusMessages(store, parent.id).length;
      testCase.apply();
      const messages = childStatusMessages(store, parent.id);
      expect(messages.length, testCase.outcome).toBe(before + (['failed','done'].includes(testCase.outcome) ? 3 : 1));
      const latest = messages.at(-1)!;
      expect(latest.to_agent_id, testCase.outcome).toBe(agent.id);
      expect(latest.body_md, testCase.outcome).toContain(`mention://agent/${agent.id}`);
      expect(latest.metadata.outcome, testCase.outcome).toBe(testCase.outcome);
    }

    // todo/running/blocked from the failed child, plus three manual endings.
    const parentTasks = store.listTasksForIssue(parent.id);
    expect(parentTasks).toHaveLength(1);
    expect(parentTasks[0]).toMatchObject({ agentId: agent.id, status: "queued" });
    expect(activityOf(store, parent.id, "turn_created")).toHaveLength(1);
    expect(activityOf(store, parent.id, "turn_merged")).toHaveLength(8);
    const reports = childStatusMessages(store, parent.id);
    expect(reports).toHaveLength(8);
    expect(reports.some(message => message.body_md.includes("failed"))).toBeTrue();
    expect(parentTasks[0]?.prompt).toBe(reports[0]!.body_md);
    expect(store.getIssue(parent.id)?.status).toBe("in_progress");
  });

  it("files a child_issue_terminal inbox item for a member owner with the right severity", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const member = store.createWorkspaceMember({ name: "Human owner", role: "member" });
    const parent = createHistoricalTestIssue(store, {
      title: "Human parent",
      responsibleMemberId:member.id,
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });

    const severities: Array<[string, string, string]> = [];
    for (const status of ["done", "cancelled", "blocked"] as const) {
      const child = createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: `Human child ${status}`, parentIssueId: parent.id, status: "in_progress" });
      // The historical member assignee is retained for notification migration;
      // replaying its old done fact grants no current acceptance authority.
      if(status==='done')replayHistoricalTestChildDone(store,child.id);
      else store.updateIssue(child.id, { status });
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
      expect(item?.issue_parent_id).toBe(parent.id);
      expect(item?.issue_parent_key).toBe(parent.key);
      expect(item?.issue_parent_title).toBe(parent.title);
    }
    expect(store.markInboxItemRead(items[0]!.id).issue_parent_key).toBe(parent.key);
    expect(store.archiveInboxItem(items[1]!.id).issue_parent_title).toBe(parent.title);

    // A member receives status messages in a member lane, without an agent round.
    expect(store.listTasksForIssue(parent.id)).toHaveLength(0);
    expect(childStatusMessages(store, parent.id)).toHaveLength(3);
    expect(childStatusMessages(store, parent.id).every(message => message.to_member_id === member.id)).toBeTrue();
  });

  it("reports a failed child to a member owner as a warning", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_member_failed", name: "Worker", provider: "claude" });
    const agent = store.createAgent({ name: "Failing child owner", provider: "claude", runtimeId: runtime.id });
    const member = store.createWorkspaceMember({ name: "Human parent", role: "member" });
    const parent = createHistoricalTestIssue(store, {
      title: "Human failure parent",
      responsibleMemberId:member.id,
      status: "in_progress",
      assigneeType: "member",
      assigneeId: member.id,
    });
    const child = createResponsibleTestIssue(store, {
      title: "Child that fails",
      parentIssueId: parent.id,
      status: "in_progress",
      assigneeType: "agent",
      assigneeId: agent.id,
    });

    const task = store.createTask({ agentId: agent.id, issueId: child.id, prompt: "explode" });
    runTask(store, runtime.id, task.id);
    store.failTask(task.id, { error: "boom" });

    // The failure blocks the child; the human owner must see it as a warning.
    expect(store.getIssue(child.id)?.status).toBe("blocked");
    const items = store.listInboxItems(member.id).filter((item) => item.type === "child_issue_terminal");
    expect(items).toHaveLength(3);
    const failed = items.find(item => (item.details as any)?.outcome === "failed");
    expect(failed?.severity).toBe("warning");
    expect(failed?.details).toMatchObject({ outcome: "failed", childIssueId: child.id });
    expect(childStatusMessages(store, parent.id, child.id).map(message => message.metadata.child_status))
      .toEqual(["todo", "in_progress", "blocked"]);
  });

  it("reports done, failed and cancelled children of an unowned parent to subscribers", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ id: "rt_no_owner", name: "Worker", provider: "claude" });
    const agent = store.createAgent({ name: "Unowned child owner", provider: "claude", runtimeId: runtime.id });
    const watcher = store.createWorkspaceMember({ name: "Watcher", role: "member" });

    const outcomes: Array<{ outcome: string; severity: string; run: (parentId: string) => string }> = [
      {
        outcome: "done",
        severity: "info",
        run: (parentId) => {
          const child = createResponsibleTestIssue(store, { title: "Unowned done", parentIssueId: parentId, status: "in_progress" });
          replayHistoricalTestChildDone(store,child.id);
          return child.id;
        },
      },
      {
        outcome: "failed",
        severity: "warning",
        run: (parentId) => {
          const child = createResponsibleTestIssue(store, {
            title: "Unowned failed",
            parentIssueId: parentId,
            status: "in_progress",
            assigneeType: "agent",
            assigneeId: agent.id,
          });
          const task = store.createTask({ agentId: agent.id, issueId: child.id, prompt: "explode" });
          runTask(store, runtime.id, task.id);
          store.failTask(task.id, { error: "boom" });
          return child.id;
        },
      },
      {
        outcome: "cancelled",
        severity: "info",
        run: (parentId) => {
          const child = createResponsibleTestIssue(store, { title: "Unowned cancelled", parentIssueId: parentId, status: "in_progress" });
          store.updateIssue(child.id, { status: "cancelled" });
          return child.id;
        },
      },
    ];

    for (const testCase of outcomes) {
      const parent = createResponsibleTestIssue(store, { title: `Unowned ${testCase.outcome} parent`, status: "in_progress" });
      store.addIssueSubscriber(parent.id, watcher.id, "manual");
      const childId = testCase.run(parent.id);

      // A system comment plus a skip record, and the subscriber hears about it.
      const comments = childStatusMessages(store, parent.id);
      expect(comments, testCase.outcome).toHaveLength(testCase.outcome === "failed" ? 3 : 1);
      expect(activityOf(store, parent.id, "child_done_parent_skipped")[0]?.data, testCase.outcome)
        .toMatchObject({ reason: "no_assignee", outcome: testCase.outcome });
      const item = store.listInboxItems(watcher.id)
        .filter((entry) => entry.type === "child_issue_terminal")
        .find((entry) => (entry.details as Record<string, unknown> | null)?.childIssueId === childId);
      expect(item, testCase.outcome).toBeDefined();
      expect(item?.severity, testCase.outcome).toBe(testCase.severity);
      expect(item?.details, testCase.outcome).toMatchObject({ noAssignee: true });
    }
  });

  it("coalesces several child endings into one queued round while the owner is busy", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const runtime = store.registerRuntime({ name: "Busy runtime", provider: "claude" });
    const leader = store.createAgent({ name: "Busy leader", provider: "claude", runtimeId: runtime.id });
    const squad = store.createSquad({ name: "Busy squad", leaderId: leader.id });
    const parent = createResponsibleTestIssue(store, {
      title: "Busy parent",
      status: "in_progress",
      assigneeType: "squad",
      assigneeId: squad.id,
    });
    const running = store.createTask({ agentId: leader.id, issueId: parent.id, prompt: "current round" });
    runTask(store, runtime.id, running.id);

    const children = ["done", "failed", "blocked", "cancelled"].map((status) =>
      createResponsibleTestIssue(store, { assigneeType:'agent',assigneeId:store.createAgent({name:'Explicit execution fixture',provider:'codex'}).id, title: `Ending ${status}`, parentIssueId: parent.id, status: "in_progress" })
    );
    const [doneChild, blockedChild] = [children[0]!, children[2]!];
    acceptTestIssueDelivery(store, doneChild.id);

    expect(store.listTasksForIssue(parent.id).filter(task => task.status === "queued")).toHaveLength(0);
    expect(store.getTask(running.id)?.status).toBe("running");
    expect(activityOf(store, parent.id, "message_delivered_running")).toHaveLength(4);
    expect(activityOf(store, parent.id, "child_done_parent_skipped")).toHaveLength(0);

    for (const child of [children[1]!, blockedChild, children[3]!]) {
      store.updateIssue(child.id, { status: "blocked" });
    }

    expect(store.listTasksForIssue(parent.id).filter(task => task.status === "queued")).toHaveLength(0);
    expect(activityOf(store, parent.id, "message_delivered_running")).toHaveLength(7);
    const notifications = childStatusMessages(store, parent.id);
    expect(notifications).toHaveLength(6);
    expect(notifications.every(message => message.to_agent_id === leader.id && message.wake_applied === "now")).toBeTrue();
    expect(notifications.some(message => message.body_md.includes("is blocked"))).toBeTrue();
    // Unacknowledged running input must become exactly one successor turn.
    store.completeTask(running.id, { output: "Current round finished." });
    const queued = store.listTasksForIssue(parent.id).filter(task => task.status === "queued");
    expect(queued).toHaveLength(1);
    expect(store.claimTask(runtime.id)?.id).toBe(queued[0]!.id);
    const offered = store.getDaemonTurnBridge().offerInput(store.getTaskWithAgent(queued[0]!.id)!);
    expect(offered.input_messages.filter(message => message.message_kind === "status")).toHaveLength(6);

  });

  it("keeps the no-assignee comment and skip record, and reaches subscribers", () => {
    const store = createStore();
    store.ensureLocalWorkspace();
    const subscriber = store.createWorkspaceMember({ name: "Watcher", role: "member" });
    const parent = createResponsibleTestIssue(store, { title: "Unassigned parent", status: "in_progress" });
    store.addIssueSubscriber(parent.id, subscriber.id, "manual");
    const child = createResponsibleTestIssue(store, { title: "Unassigned child", parentIssueId: parent.id, status: "in_progress" });

    store.updateIssue(child.id, { status: "blocked" });

    expect(childStatusMessages(store, parent.id)).toHaveLength(1);
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
