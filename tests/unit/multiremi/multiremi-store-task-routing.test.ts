// Store-level task scheduling: which runtime may claim which task.
// Covers provider/agent-binding routing, private-runtime visibility, cross-workspace
// guards, re-pooling on runtime changes, and the execution-engine session snapshots.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store/store.js";
import { PostgresSyncDatabase, type SqlDatabase } from "@multiremi/store/db/postgres.js";
import { createStore, createLocalStore, db, readyArchiveBinding, resetMultiremiTestEnv } from "./helpers.js";
import { prepareFeishuIssueTopic } from "../../fixtures/multiremi-feishu-topic.js";
import { MUL449_CLAIM_SQL_GOLDEN } from "../../fixtures/mul449-claim-sql-golden.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — task claim, routing, and workspace scoping", () => {
  it("enforces project device bindings and dedicated device admission in both directions", () => {
    const store = createStore();
    const personal = store.registerRuntime({
      id: "rt_personal",
      name: "personal codex",
      provider: "codex",
      daemonId: "device-personal",
    });
    const devbox = store.registerRuntime({
      id: "rt_devbox",
      name: "devbox codex",
      provider: "codex",
      daemonId: "device-devbox",
    });
    const agent = store.createAgent({ name: "Routing agent", provider: "codex" });

    const unrestricted = store.createProject({ title: "Unrestricted" });
    const unrestrictedIssue = store.createIssue({ title: "Ordinary work", projectId: unrestricted.id });
    const unrestrictedTask = store.createTask({ agentId: agent.id, issueId: unrestrictedIssue.id, prompt: "ordinary" });
    expect(store.claimTask(personal.id)?.id).toBe(unrestrictedTask.id);
    store.startTask(unrestrictedTask.id);
    store.completeTask(unrestrictedTask.id, { output: "done" });

    const bound = store.createProject({ title: "Personal-only" });
    store.createProjectDevice(bound.id, { daemonId: "device-personal", createdBy: "local" });
    const boundIssue = store.createIssue({ title: "Independent work", projectId: bound.id });
    const boundTask = store.createTask({ agentId: agent.id, issueId: boundIssue.id, prompt: "independent" });
    expect(store.claimTask(devbox.id)).toBeNull();
    expect(store.claimTask(personal.id)?.id).toBe(boundTask.id);
    store.startTask(boundTask.id);
    store.completeTask(boundTask.id, { output: "done" });

    store.updateDaemonDedicated("local", "device-personal", true, "local");
    const ordinaryAfterDedicated = store.createTask({
      agentId: agent.id,
      issueId: unrestrictedIssue.id,
      prompt: "ordinary after dedicated",
    });
    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.claimTask(devbox.id)?.id).toBe(ordinaryAfterDedicated.id);
    store.startTask(ordinaryAfterDedicated.id);
    store.completeTask(ordinaryAfterDedicated.id, { output: "done" });

    const exclusive = store.createTask({ agentId: agent.id, issueId: boundIssue.id, prompt: "exclusive" });
    expect(store.claimTask(devbox.id)).toBeNull();
    expect(store.claimTask(personal.id)?.id).toBe(exclusive.id);
  });

  it("rejects projectless tasks and unidentified runtimes on constrained devices", () => {
    const store = createStore();
    const dedicated = store.registerRuntime({
      id: "rt_dedicated",
      name: "dedicated",
      provider: "codex",
      daemonId: "device-dedicated",
    });
    const unidentified = store.registerRuntime({
      id: "rt_unidentified",
      name: "unidentified",
      provider: "codex",
    });
    const fallback = store.registerRuntime({
      id: "rt_fallback",
      name: "fallback",
      provider: "codex",
      daemonId: "device-fallback",
    });
    const agent = store.createAgent({ name: "Boundary agent", provider: "codex" });
    const project = store.createProject({ title: "Bound" });
    store.createProjectDevice(project.id, { daemonId: "device-dedicated" });
    store.updateDaemonDedicated("local", "device-dedicated", true, "local");

    const projectless = store.createTask({ agentId: agent.id, prompt: "chat-like" });
    expect(store.claimTask(dedicated.id)).toBeNull();
    expect(store.claimTask(fallback.id)?.id).toBe(projectless.id);
    store.startTask(projectless.id);
    store.completeTask(projectless.id, { output: "done" });

    const issue = store.createIssue({ title: "Bound issue", projectId: project.id });
    const constrained = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "bound" });
    expect(store.claimTask(unidentified.id)).toBeNull();
    expect(store.claimTask(dedicated.id)?.id).toBe(constrained.id);
  });

  for (const ownerDedicated of [false, true]) {
    for (const otherDedicated of [false, true]) {
      it(`admits an explicit workspace only on its owner (owner dedicated=${ownerDedicated}, other dedicated=${otherDedicated})`, () => {
        const store = createLocalStore();
        const owner = store.registerRuntime({
          name: "Workspace owner", provider: "codex", daemonId: "workspace-owner",
          metadata: { runtime_workspaces: 1 },
        });
        const other = store.registerRuntime({
          name: "Other device", provider: "codex", daemonId: "workspace-other",
          metadata: { runtime_workspaces: 1 },
        });
        store.updateDaemonDedicated("local", owner.daemonId!, ownerDedicated, "local");
        store.updateDaemonDedicated("local", other.daemonId!, otherDedicated, "local");
        const workspace = store.runtimeWorkspaces.create(owner.id, { name: "Local files", root_path: "/local/files" });
        const agent = store.createAgent({ name: "Local worker", provider: "codex" });
        const task = store.createTask({ agentId: agent.id, runtimeWorkspaceId: workspace.id, prompt: "Use local files" });

        const verdicts = store.describeTaskPlacement(task.id);
        expect(verdicts).toHaveLength(2);
        expect(verdicts.find((v) => v.runtimeId === owner.id)).toMatchObject({ placementOk: true, routingOk: true });
        expect(verdicts.find((v) => v.runtimeId === other.id)).toMatchObject({ placementOk: false, routingOk: !otherDedicated });
        expect(store.claimTask(other.id)).toBeNull();
        expect(store.claimTask(owner.id)?.id).toBe(task.id);
      });
    }
  }

  it("preserves explicit-workspace Chat sessions and retained directories on a dedicated device", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({
      name: "Local Chat", provider: "codex", daemonId: "workspace-chat", metadata: { runtime_workspaces: 1 },
    });
    const other = store.registerRuntime({
      name: "Other Chat", provider: "codex", daemonId: "workspace-chat-other", metadata: { runtime_workspaces: 1 },
    });
    const agent = store.createAgent({ name: "Workspace Chat", provider: "codex" });
    const workspace = store.runtimeWorkspaces.create(runtime.id, { name: "Chat files", root_path: "/local/chat" });
    const chat = store.createChatSession({ agentId: agent.id, runtime_workspace_id: workspace.id });
    const first = store.sendChatMessage(chat.id, { body: "first" }).task;
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_workspace_chat", workDir: "/local/chat" });
    const second = store.sendChatMessage(chat.id, { body: "queued before dedicated" }).task;
    expect(second).toMatchObject({ runtimeId: runtime.id, sessionId: "sess_workspace_chat", workDir: "/local/chat" });
    store.updateDaemonDedicated("local", runtime.daemonId!, true, "local");

    expect(store.claimTask(other.id)).toBeNull();
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: runtime.id, sessionId: "sess_workspace_chat", workDir: "/local/chat" });
    expect(store.claimTask(runtime.id)).toMatchObject({ id: second.id, sessionId: "sess_workspace_chat" });
    store.startTask(second.id);
    store.completeTask(second.id, { output: "ok", sessionId: "sess_workspace_chat", workDir: "/local/chat" });

    const third = store.sendChatMessage(chat.id, { body: "created while dedicated" }).task;
    expect(third).toMatchObject({ runtimeId: runtime.id, sessionId: "sess_workspace_chat", workDir: "/local/chat" });
    expect(store.claimTask(runtime.id)?.sessionId).toBe("sess_workspace_chat");
    store.startTask(third.id);
    store.completeTask(third.id, { output: "ok", sessionId: "sess_workspace_chat", workDir: "/local/chat" });

    db!.run("UPDATE multiremi_chat_sessions SET session_id = NULL WHERE id = ?", [chat.id]);
    const reset = store.sendChatMessage(chat.id, { body: "retain files after provider reset" }).task;
    expect(reset).toMatchObject({ runtimeId: runtime.id, sessionId: null, workDir: "/local/chat" });
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.claimTask(runtime.id)).toMatchObject({ id: reset.id, workDir: "/local/chat" });
  });

  it("keeps an explicit-workspace Issue lane when its owning device becomes dedicated", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({
      name: "Local Issue", provider: "codex", daemonId: "workspace-issue", metadata: { runtime_workspaces: 1 },
    });
    const agent = store.createAgent({ name: "Workspace Issue", provider: "codex" });
    const workspace = store.runtimeWorkspaces.create(runtime.id, { name: "Issue files", root_path: "/local/issue" });
    const issue = store.createIssue({ title: "Local Issue", runtimeWorkspaceId: workspace.id });
    const session = store.getOrCreateDefaultIssueSession(issue.id);
    const first = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_workspace_issue" });
    const lane = store.getSessionAgentLane(session.id, agent.id)!;
    const second = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second" });
    store.updateDaemonDedicated("local", runtime.daemonId!, true, "local");
    expect(store.claimTask(runtime.id)).toMatchObject({ id: second.id, sessionId: "sess_workspace_issue" });
    store.startTask(second.id);
    store.completeTask(second.id, { output: "ok", sessionId: "sess_workspace_issue" });

    const third = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "third" });
    expect(third).toMatchObject({ runtimeId: runtime.id, sessionId: "sess_workspace_issue" });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({
      runtimeId: runtime.id, providerSessionId: "sess_workspace_issue", generation: lane.generation,
    });
    expect(store.claimTask(runtime.id)?.id).toBe(third.id);
  });

  // MUL-449: device routing must gate EVERY task. `holds_workspace` may stay
  // decoupled from the Issue workspace, but it must never decouple the device.
  it("keeps dedicated devices away from tasks that hold no Issue workspace", () => {
    const store = createStore();
    const personal = store.registerRuntime({
      id: "rt_holds_personal",
      name: "personal",
      provider: "codex",
      daemonId: "device-holds-personal",
    });
    const devbox = store.registerRuntime({
      id: "rt_holds_devbox",
      name: "devbox",
      provider: "codex",
      daemonId: "device-holds-devbox",
    });
    const agent = store.createAgent({ name: "No-lease agent", provider: "codex" });
    store.updateDaemonDedicated("local", "device-holds-personal", true, "local");

    // A Project bound to the dedicated device may still use it.
    const bound = store.createProject({ title: "Bound to personal" });
    store.createProjectDevice(bound.id, { daemonId: "device-holds-personal" });
    const boundIssue = store.createIssue({ title: "Bound work", projectId: bound.id });
    const boundSide = store.createIssueSession(boundIssue.id, { title: "Discussion", holdsWorkspace: false });
    const boundTask = store.createTask({
      agentId: agent.id,
      issueId: boundIssue.id,
      issueSessionId: boundSide.id,
      prompt: "bound without workspace",
    });
    expect(store.getTask(boundTask.id)?.holdsWorkspace).toBe(false);
    expect(store.claimTask(personal.id)?.id).toBe(boundTask.id);
    store.startTask(boundTask.id);
    store.completeTask(boundTask.id, { output: "done" });

    // A Project bound to another device must be refused even without a lease.
    const foreign = store.createProject({ title: "Bound to devbox" });
    store.createProjectDevice(foreign.id, { daemonId: "device-holds-devbox" });
    const foreignIssue = store.createIssue({ title: "Foreign work", projectId: foreign.id });
    const foreignSide = store.createIssueSession(foreignIssue.id, { title: "Discussion", holdsWorkspace: false });
    const foreignTask = store.createTask({
      agentId: agent.id,
      issueId: foreignIssue.id,
      issueSessionId: foreignSide.id,
      prompt: "foreign without workspace",
    });
    expect(store.getTask(foreignTask.id)?.holdsWorkspace).toBe(false);
    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.claimTask(devbox.id)?.id).toBe(foreignTask.id);
    store.startTask(foreignTask.id);
    store.completeTask(foreignTask.id, { output: "done" });

    // A Project-less task has no binding, so a dedicated device is not allowed.
    const projectless = store.createTask({ agentId: agent.id, prompt: "chat-like" });
    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.claimTask(devbox.id)?.id).toBe(projectless.id);
  });

  it("keeps unbound devices working for tasks without an Issue workspace", () => {
    const store = createStore();
    const pooled = store.registerRuntime({
      id: "rt_holds_pooled",
      name: "pooled",
      provider: "codex",
      daemonId: "device-holds-pooled",
    });
    const other = store.registerRuntime({
      id: "rt_holds_other",
      name: "other",
      provider: "codex",
      daemonId: "device-holds-other",
    });
    const agent = store.createAgent({ name: "Pooled agent", provider: "codex" });

    const unbound = store.createProject({ title: "Unbound project" });
    const unboundIssue = store.createIssue({ title: "Unbound work", projectId: unbound.id });
    const unboundSide = store.createIssueSession(unboundIssue.id, { title: "Discussion", holdsWorkspace: false });
    const unboundTask = store.createTask({
      agentId: agent.id,
      issueId: unboundIssue.id,
      issueSessionId: unboundSide.id,
      prompt: "unbound without workspace",
    });
    expect(store.claimTask(pooled.id)?.id).toBe(unboundTask.id);
    store.startTask(unboundTask.id);
    store.completeTask(unboundTask.id, { output: "done" });

    const projectless = store.createTask({ agentId: agent.id, prompt: "chat-like" });
    expect(store.claimTask(pooled.id)?.id).toBe(projectless.id);
    store.startTask(projectless.id);
    store.completeTask(projectless.id, { output: "done" });

    const elsewhere = store.createProject({ title: "Elsewhere" });
    store.createProjectDevice(elsewhere.id, { daemonId: "device-holds-other" });
    const elsewhereIssue = store.createIssue({ title: "Elsewhere work", projectId: elsewhere.id });
    const elsewhereSide = store.createIssueSession(elsewhereIssue.id, { title: "Discussion", holdsWorkspace: false });
    const elsewhereTask = store.createTask({
      agentId: agent.id,
      issueId: elsewhereIssue.id,
      issueSessionId: elsewhereSide.id,
      prompt: "elsewhere without workspace",
    });
    expect(store.getTask(elsewhereTask.id)?.holdsWorkspace).toBe(false);
    // Intentional change in MUL-449: a task bound to a Project that names
    // another device no longer bypasses that binding by not holding a lease.
    expect(store.claimTask(pooled.id)).toBeNull();
    expect(store.claimTask(other.id)?.id).toBe(elsewhereTask.id);
  });

  it("routes the claim and the recheck identically across the device matrix", () => {
    const store = createStore();
    const personal = store.registerRuntime({
      id: "rt_matrix_personal",
      name: "personal",
      provider: "codex",
      daemonId: "device-matrix-personal",
    });
    const devbox = store.registerRuntime({
      id: "rt_matrix_devbox",
      name: "devbox",
      provider: "codex",
      daemonId: "device-matrix-devbox",
    });
    const agent = store.createAgent({ name: "Matrix agent", provider: "codex" });
    const boundHere = store.createProject({ title: "Bound to devbox" });
    store.createProjectDevice(boundHere.id, { daemonId: "device-matrix-devbox" });
    const boundElsewhere = store.createProject({ title: "Bound to personal" });
    store.createProjectDevice(boundElsewhere.id, { daemonId: "device-matrix-personal" });
    const unbound = store.createProject({ title: "Unbound" });
    store.updateDaemonDedicated("local", "device-matrix-personal", true, "local");

    const projects = [
      { label: "none", projectId: null },
      { label: "unbound", projectId: unbound.id },
      { label: "bound-here", projectId: boundHere.id },
      { label: "bound-elsewhere", projectId: boundElsewhere.id },
    ];
    const runtimes = [
      // A named binding excludes every other device; the dedicated device is
      // additionally refused for project-less / unbound work.
      { label: "dedicated/personal", runtime: personal, eligibleFor: new Set(["bound-elsewhere"]) },
      { label: "free/devbox", runtime: devbox, eligibleFor: new Set(["unbound", "bound-here", "none"]) },
    ];
    let index = 0;
    for (const project of projects) {
      for (const holdsWorkspace of [true, false]) {
        for (const runtime of runtimes) {
          index += 1;
          const issue = project.projectId
            ? store.createIssue({ title: `${project.label} ${index}`, projectId: project.projectId })
            : null;
          const session = issue
            ? store.createIssueSession(issue.id, {
              title: `Session ${index}`,
              holdsWorkspace,
            })
            : null;
          const task = store.createTask({
            agentId: agent.id,
            issueId: issue?.id,
            issueSessionId: session?.id,
            prompt: `matrix ${project.label} holds=${holdsWorkspace}`,
          });
          // A Project-less task has no Session to opt out with: it always holds
          // the workspace, and it can never reach a dedicated device.
          expect(store.getTask(task.id)?.holdsWorkspace).toBe(issue ? holdsWorkspace : true);
          const expected = runtime.eligibleFor.has(project.label);
          const claimed = store.claimTask(runtime.runtime.id);
          // Claim and the dispatch-recovery recheck must agree on every cell.
          if (expected) {
            expect(claimed?.id).toBe(task.id);
            // The allowed cells must also satisfy the JS eligibility recheck
            // that guards dispatch recovery, not just the SQL claim predicate:
            // a stale dispatch on the same machine is handed back, never pooled.
            db!.run(
              "UPDATE multiremi_tasks SET status = 'dispatched', dispatched_at = ? WHERE id = ?",
              ["2000-01-01T00:00:00.000Z", task.id],
            );
            expect(store.claimTask(runtime.runtime.id)?.id).toBe(task.id);
            store.startTask(task.id);
            store.completeTask(task.id, { output: "done" });
          } else {
            expect(claimed).toBeNull();
            // The dispatch-recovery recheck must agree with the claim predicate:
            // a stale dispatch on the same rejected runtime re-pools instead of
            // being handed back.
            db!.run(
              "UPDATE multiremi_tasks SET status = 'dispatched', runtime_id = ?, dispatched_at = ? WHERE id = ?",
              [runtime.runtime.id, "2000-01-01T00:00:00.000Z", task.id],
            );
            expect(store.claimTask(runtime.runtime.id)).toBeNull();
            expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: null });
            store.cancelTask(task.id);
          }
        }
      }
    }
  });

  it("keeps resuming a chat session on a device its Project still allows", () => {
    const store = createLocalStore();
    const allowed = store.registerRuntime({
      id: "rt_allowed_personal",
      name: "allowed personal",
      provider: "codex",
      workspaceId: "local",
      daemonId: "device-allowed-personal",
    });
    const other = store.registerRuntime({
      id: "rt_allowed_other",
      name: "other",
      provider: "codex",
      workspaceId: "local",
      daemonId: "device-allowed-other",
    });
    const agent = store.createAgent({ name: "Allowed chat", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Stays on personal", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "device-allowed-personal" });
    store.updateDaemonDedicated("local", "device-allowed-personal", true, "local");
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id, workspaceId: "local" });

    const first = store.sendChatMessage(chat.id, { body: "first" }).task;
    expect(store.claimTask(allowed.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_allowed_chat" });
    expect(store.getChatSession(chat.id)?.sessionRuntimeId).toBe(allowed.id);

    const second = store.sendChatMessage(chat.id, { body: "second" }).task;
    // The dedicated device is still bound to this Project, so the resume is
    // kept: the routing guard must not over-reject and strand the turn.
    expect(second).toMatchObject({ runtimeId: allowed.id, sessionId: "sess_allowed_chat" });
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.claimTask(allowed.id)?.id).toBe(second.id);
  });

  it("clears a queued chat pin when the Project moves to another device before the claim", () => {
    const store = createLocalStore();
    const personal = store.registerRuntime({
      id: "rt_requeue_personal",
      name: "personal",
      provider: "codex",
      workspaceId: "local",
      daemonId: "device-requeue-personal",
    });
    const devbox = store.registerRuntime({
      id: "rt_requeue_devbox",
      name: "devbox",
      provider: "codex",
      workspaceId: "local",
      daemonId: "device-requeue-devbox",
    });
    const agent = store.createAgent({ name: "Queued chat", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Moves before the claim", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "device-requeue-personal" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id, workspaceId: "local" });

    const first = store.sendChatMessage(chat.id, { body: "first" }).task;
    expect(store.claimTask(personal.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_requeued_chat" });

    // The follow-up is queued while the personal device is still allowed, so it
    // inherits that pin. The Project then moves away before any claim happens.
    const second = store.sendChatMessage(chat.id, { body: "second" }).task;
    expect(second).toMatchObject({ runtimeId: personal.id, sessionId: "sess_requeued_chat" });
    store.deleteProjectDevice(project.id, "device-requeue-personal");
    store.createProjectDevice(project.id, { daemonId: "device-requeue-devbox" });
    store.updateDaemonDedicated("local", "device-requeue-personal", true, "local");

    // The queued-affinity refresh must drop the now-rejected pin; otherwise the
    // turn stays parked on a device that can never claim it. The provider
    // session belongs to that machine, so it is abandoned with the pin.
    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null });
    expect(store.claimTask(devbox.id)?.id).toBe(second.id);
  });

  // MUL-449 QA follow-up: device routing must gate Issue lane inheritance too.
  // A lane pinned to a machine the Project no longer allows used to be resumed
  // there, while the claim predicate rejected that machine: neither machine
  // could claim the turn, so it queued forever.
  // MUL-449 QA round 3: a live Issue workspace outranks a cached provider
  // session. When the workspace moved to B while the lane still named A, the
  // claim predicate demanded B (workspace) and A (pin) at once, so neither
  // machine could take the turn and nothing explained the wait.
  function workspaceConflictFixture(devices: string[]) {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_wsconf_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "dev-wsconf-a",
    });
    const b = store.registerRuntime({
      id: "rt_wsconf_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-wsconf-b",
    });
    const agent = store.createAgent({ name: "Workspace conflict", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Workspace conflict", workspaceId: "local" });
    for (const daemonId of devices) store.createProjectDevice(project.id, { daemonId });
    const issue = store.createIssue({ title: "Conflicting workspace", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Work", holdsWorkspace: true });
    return { store, a, b, agent, project, issue, session };
  }

  // MUL-449 follow-up: one machine normally runs one Runtime per provider, and
  // the claim SQL admits a workspace through daemon aliases. Comparing Runtime
  // ids alone called a same-machine sibling provider a conflict and threw away
  // a perfectly resumable session on every turn.
  it("keeps a sibling provider's lane on the machine that holds the workspace", () => {
    const store = createLocalStore();
    const codex = store.registerRuntime({
      id: "rt_sib_codex", name: "codex", provider: "codex", workspaceId: "local", daemonId: "dev-sib",
    });
    const claude = store.registerRuntime({
      id: "rt_sib_claude", name: "claude", provider: "claude", workspaceId: "local", daemonId: "dev-sib",
    });
    const codexAgent = store.createAgent({ name: "Sibling codex", provider: "codex", workspaceId: "local" });
    const claudeAgent = store.createAgent({ name: "Sibling claude", provider: "claude", workspaceId: "local" });
    const project = store.createProject({ title: "Sibling project", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-sib" });
    const issue = store.createIssue({ title: "Sibling issue", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Shared", holdsWorkspace: true });

    // The codex Runtime on the machine builds the workspace.
    const built = store.createTask({
      agentId: codexAgent.id, issueId: issue.id, issueSessionId: session.id, prompt: "build",
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: codex.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    expect(store.claimTask(codex.id)?.id).toBe(built.id);
    store.startTask(built.id);
    store.completeTask(built.id, { output: "ok", sessionId: "sess_sib_codex" });

    // The claude Agent gets its own lane on the SAME machine.
    const claudeTurn = store.createTask({
      agentId: claudeAgent.id, issueId: issue.id, issueSessionId: session.id, prompt: "claude turn",
    });
    expect(store.claimTask(claude.id)?.id).toBe(claudeTurn.id);
    store.startTask(claudeTurn.id);
    store.completeTask(claudeTurn.id, { output: "ok", sessionId: "sess_sib_claude" });
    expect(store.getSessionAgentLane(session.id, claudeAgent.id)).toMatchObject({
      runtimeId: claude.id, providerSessionId: "sess_sib_claude",
    });

    // A later claude turn must keep that lane: the machine matches the
    // workspace even though the Runtime id does not.
    const followUp = store.createTask({
      agentId: claudeAgent.id, issueId: issue.id, issueSessionId: session.id, prompt: "claude again",
    });
    expect(store.getTask(followUp.id)).toMatchObject({
      runtimeId: claude.id, sessionId: "sess_sib_claude",
    });
    // Any claim runs the refresh first; it must not treat this pin as a conflict.
    expect(store.claimTask(codex.id)).toBeNull();
    expect(store.getSessionAgentLane(session.id, claudeAgent.id)).toMatchObject({
      runtimeId: claude.id, providerSessionId: "sess_sib_claude",
    });
    expect(db!.query(
      `SELECT COUNT(*) AS count FROM multiremi_issue_activity
        WHERE issue_id = ? AND type = 'session_agent_lane_reset'
          AND data LIKE '%issue_workspace_elsewhere%'`,
    ).get(issue.id)).toEqual({ count: 0 });
    expect(store.claimTask(claude.id)?.id).toBe(followUp.id);
  });

  it("lets a discussion turn keep its lane while the Issue workspace lives elsewhere", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_disc_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "dev-disc-a",
    });
    const b = store.registerRuntime({
      id: "rt_disc_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-disc-b",
    });
    const agent = store.createAgent({ name: "Discussion", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Discussion project", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-disc-a" });
    const issue = store.createIssue({ title: "Discussion issue", projectId: project.id, workspaceId: "local" });
    // A discussion session holds no workspace, so the workspace clause does
    // not apply to its turns (the claim SQL guards it with holds_workspace).
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });

    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_disc" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });

    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    expect(second).toMatchObject({ holdsWorkspace: false, runtimeId: a.id, sessionId: "sess_disc" });
    expect(store.claimTask(a.id)?.id).toBe(second.id);
  });

  it("names the Issue workspace machine, not the stale pin, when only A is allowed", () => {
    const { store, a, b, agent, issue, session } = workspaceConflictFixture(["dev-wsconf-a"]);
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    store.claimTask(a.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_wsconf_onlyA" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    const now = Date.now();
    db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), second.id]);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    // The wait belongs to the workspace machine B; naming the stale pin A
    // would send the reader to the wrong device.
    expect(store.getTask(second.id)?.waitReason).toContain("B");
    expect(store.getTask(second.id)?.waitReason).toContain("Issue 工作区");
    expect(store.getTask(second.id)?.waitReason).not.toContain("钉在 A");
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)).toBeNull();

    // Restoring the binding clears the reason and lets B take the turn.
    store.createProjectDevice(issue.projectId!, { daemonId: "dev-wsconf-b" });
    expect(store.refreshQueuedCapabilityWaitReasons(now + 300_000).updated).toBe(1);
    expect(store.getTask(second.id)?.waitReason).toBeNull();
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  it("lets the workspace machine claim when only B is allowed", () => {
    const { store, a, b, agent, issue, session } = workspaceConflictFixture(["dev-wsconf-b"]);
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    expect(store.claimTask(b.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_wsconf_onlyB" });
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    const now = Date.now();
    db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), second.id]);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(second.id)?.waitReason).toBeNull();
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  it("keeps normal lane inheritance when the Issue workspace was cleaned", () => {
    const { store, a, b, agent, issue, session } = workspaceConflictFixture(["dev-wsconf-a", "dev-wsconf-b"]);
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: a.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_wsconf_cleaned" });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id, runtimeId: a.id, ...readyArchiveBinding(store, issue.id, a.id),
    });

    // With no live workspace there is no machine constraint, so the lane is
    // still resumable and must not be reset.
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    expect(store.getTask(second.id)).toMatchObject({
      runtimeId: a.id, sessionId: "sess_wsconf_cleaned",
    });
    const now = Date.now();
    db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), second.id]);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(second.id)?.waitReason).toBeNull();
    expect(store.claimTask(a.id)?.id).toBe(second.id);
    // B remains a valid fallback for later turns.
    expect(store.getTask(second.id)?.runtimeId).not.toBe(b.id);
  });

  it("does not inherit a lane that sits off the machine holding the Issue workspace", () => {
    const { store, a, b, agent, issue, session } = workspaceConflictFixture(["dev-wsconf-a", "dev-wsconf-b"]);
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    // A legitimately holds the workspace for the first turn.
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: a.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_wsconf" });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({ runtimeId: a.id });

    // The workspace migrates to B: A's row is cleaned, B reports a live one.
    store.markIssueWorkspaceCleaned({
      issueId: issue.id, runtimeId: a.id, ...readyArchiveBinding(store, issue.id, a.id),
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });

    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    // The lane named A, but the workspace lives on B: drop the lineage.
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({
      runtimeId: null, providerSessionId: null,
    });
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  it("re-pools a queued turn whose pin conflicts with the live Issue workspace", () => {
    const { store, a, b, agent, issue, session } = workspaceConflictFixture(["dev-wsconf-a", "dev-wsconf-b"]);
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: a.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_wsconf_q" });

    // Queue the follow-up while A still holds the workspace, then migrate.
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: a.id, sessionId: "sess_wsconf_q" });
    store.markIssueWorkspaceCleaned({
      issueId: issue.id, runtimeId: a.id, ...readyArchiveBinding(store, issue.id, a.id),
    });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });

    expect(store.claimTask(a.id)).toBeNull();
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  it("does not strand a workspace-backed turn when A and B are both allowed", () => {
    const { store, a, b, agent, issue, session } = workspaceConflictFixture(["dev-wsconf-a", "dev-wsconf-b"]);
    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    store.claimTask(a.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_wsconf_both" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: b.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });

    // Both machines satisfy the binding, so the observer must stay silent and
    // the workspace machine must win the claim.
    const now = Date.now();
    db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), second.id]);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(second.id)?.waitReason).toBeNull();
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  // MUL-449 ruling 2: the claim predicate and the wait-reason observer must be
  // one body of SQL. MUL-466 only adds the explicit-workspace dedicated clause
  // to the golden; every other byte still guards the original claim contract.
  it("keeps the claim SELECT byte-identical to the routing golden", () => {
    const store = createLocalStore();
    const runtime = store.registerRuntime({
      id: "rt_golden", name: "golden", provider: "codex", workspaceId: "local", daemonId: "dev-golden",
    });
    const agent = store.createAgent({ name: "golden", provider: "codex", workspaceId: "local" });
    store.createTask({ agentId: agent.id, prompt: "golden" });
    const queries: string[] = [];
    const db = (store as unknown as { ctx: { db: { query: (sql: string) => unknown } } }).ctx.db;
    const original = db.query.bind(db);
    (db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
      queries.push(sql);
      return original(sql);
    };
    try {
      store.claimTask(runtime.id);
    } finally {
      (db as unknown as { query: (sql: string) => unknown }).query = original;
    }
    const claim = queries.find((sql) => sql.includes("SET status = 'dispatched'"));
    expect(claim).toBeDefined();
    expect(claim).toBe(MUL449_CLAIM_SQL_GOLDEN);
  });

  // The invariant: the observer's verdict per Runtime is the claim's own
  // structural predicate, so no combination of hard constraints can produce a
  // silent queue or a wait for a task some machine can take.
  function placementFixture() {
    const store = createLocalStore();
    const machine = store.registerRuntime({
      id: "rt_inv_codex", name: "machine codex", provider: "codex", workspaceId: "local", daemonId: "dev-inv",
    });
    const sibling = store.registerRuntime({
      id: "rt_inv_claude", name: "machine claude", provider: "claude", workspaceId: "local", daemonId: "dev-inv",
    });
    const legacy = store.registerRuntime({
      id: "rt_inv_legacy", name: "legacy host", provider: "codex", workspaceId: "local", daemonId: "dev-inv-legacy",
    });
    const agent = store.createAgent({ name: "invariant", provider: "codex", workspaceId: "local" });
    return { store, machine, sibling, legacy, agent };
  }

  it("agrees with the claim predicate whenever an Agent binding and a workspace disagree", () => {
    const { store, machine, legacy, agent } = placementFixture();
    const project = store.createProject({ title: "Invariant project", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-inv" });
    store.createProjectDevice(project.id, { daemonId: "dev-inv-legacy" });
    const issue = store.createIssue({ title: "Invariant issue", projectId: project.id, workspaceId: "local" });
    // The workspace lives on the codex machine; bind the Agent to the OTHER
    // machine so the two hard constraints cannot both hold.
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: machine.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    const bound = store.createAgent({ name: "bound elsewhere", provider: "codex", workspaceId: "local", runtimeId: legacy.id });
    const task = store.createTask({ agentId: bound.id, issueId: issue.id, prompt: "conflict" });

    const verdicts = store.describeTaskPlacement(task.id);
    const claimable = verdicts.filter((verdict) => verdict.placementOk && verdict.routingOk);
    // No machine satisfies both, so nothing may claim and the observer must say so.
    expect(claimable).toEqual([]);
    for (const verdict of verdicts) expect(store.claimTask(verdict.runtimeId)).toBeNull();
    const now = Date.now();
    db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), task.id]);
    expect(store.refreshQueuedCapabilityWaitReasons(now).updated).toBe(1);
    const reason = store.getTask(task.id)!.waitReason!;
    expect(reason).toContain("等待任务落点：");
    expect(reason).toContain("Agent 绑定");
    expect(reason).toContain(`remi agent update ${bound.id} --runtime ${machine.id}`);
    void agent;
  });

  it("stays silent whenever some registered Runtime can take the task", () => {
    const { store, machine, sibling } = placementFixture();
    const project = store.createProject({ title: "Reachable project", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-inv" });
    const issue = store.createIssue({ title: "Reachable issue", projectId: project.id, workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id, runtimeId: machine.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1", status: "ready", repos: [],
    });
    // The sibling Runtime sits on the SAME machine as the workspace, so it can
    // take the turn even though its Runtime id differs.
    const siblingAgent = store.createAgent({ name: "sibling", provider: "claude", workspaceId: "local" });
    const task = store.createTask({ agentId: siblingAgent.id, issueId: issue.id, prompt: "reachable" });
    const verdicts = store.describeTaskPlacement(task.id);
    expect(verdicts.filter((verdict) => verdict.placementOk && verdict.routingOk)
      .map((verdict) => verdict.runtimeId)).toContain(sibling.id);

    const now = Date.now();
    db!.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [new Date(now - 200_000).toISOString(), task.id]);
    expect(store.refreshQueuedCapabilityWaitReasons(now)).toEqual({ updated: 0, alerted: 0 });
    expect(store.getTask(task.id)?.waitReason).toBeNull();
    expect(store.claimTask(sibling.id)?.id).toBe(task.id);
  });

  // ───────────────────────────────────────────────────────────────────────
  // MUL-449 ruling 2 § 4: one programmatically generated invariant case.
  //
  // The observer must agree with the claim's own placement predicate for every
  // combination of task shape, pin and device binding. Cells are generated, so
  // a new hard constraint that is wired into only one of the two paths shows up
  // as a red cell instead of a silent queue.
  // ───────────────────────────────────────────────────────────────────────
  for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !process.env.MULTIREMI_TEST_POSTGRES_URL)(`placement invariant matrix (${dialect})`, () => {
    let matrixDb: SqlDatabase;
    let admin: PostgresSyncDatabase;
    let cellDatabase: string | null = null;
    let sequence = 0;
    const template = `mul449_matrix_${process.pid}_${Math.floor(Math.random() * 1e6)}`;

    beforeAll(() => {
      if (dialect !== "postgres") return;
      admin = new PostgresSyncDatabase(process.env.MULTIREMI_TEST_POSTGRES_URL!);
      admin.exec(`CREATE DATABASE ${template}`);
      const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
      url.pathname = `/${template}`;
      const db = new PostgresSyncDatabase(url.toString());
      try {
        new MultiremiStore(db).ensureLocalWorkspace();
      } finally {
        db.close();
      }
    });

    afterAll(() => {
      if (dialect !== "postgres" || !admin) return;
      matrixDb?.close();
      try {
        if (cellDatabase) admin.exec(`DROP DATABASE ${cellDatabase} WITH (FORCE)`);
        admin.exec(`DROP DATABASE ${template} WITH (FORCE)`);
      } finally {
        admin.close();
      }
    });

    function createCellStore(): MultiremiStore {
      matrixDb?.close();
      if (dialect === "sqlite") {
        const store = createLocalStore();
        matrixDb = db!;
        return store;
      }
      if (cellDatabase) admin.exec(`DROP DATABASE ${cellDatabase} WITH (FORCE)`);
      cellDatabase = `${template}_${++sequence}`;
      // Clone only the migrated, empty fixture; each cell still owns all its rows.
      admin.exec(`CREATE DATABASE ${cellDatabase} TEMPLATE ${template}`);
      const url = new URL(process.env.MULTIREMI_TEST_POSTGRES_URL!);
      url.pathname = `/${cellDatabase}`;
      matrixDb = new PostgresSyncDatabase(url.toString());
      return new MultiremiStore(matrixDb);
    }
    const M = "dev-inv-m";
    const M_LEGACY = "dev-inv-m-legacy";
    const U = "dev-inv-u";           // named only in data; no Runtime row

    type Shape =
      | "chat" | "issue-no-workspace" | "issue-workspace-on-M" | "issue-holds-zero"
      | "with-code-on-M" | "frozen-retry-on-M" | "runtime-workspace-on-M" | "runtime-workspace-on-U"
      | "runtime-workspace-on-M-legacy" | "runtime-workspace-archived-on-M"
      | "workspace-runtime-gone";
    type Pin = "none" | "agent-bound-M-legacy" | "agent-bound-M-legacy-unpinned" | "task-pinned-M-legacy";
    type Devices = "unbound" | "bound-M" | "bound-M-legacy" | "bound-M-and-M-legacy";

    const SHAPES: Shape[] = [
      "chat", "issue-no-workspace", "issue-workspace-on-M", "issue-holds-zero",
      "with-code-on-M", "frozen-retry-on-M", "runtime-workspace-on-M", "runtime-workspace-on-U",
      "runtime-workspace-on-M-legacy", "runtime-workspace-archived-on-M",
      "workspace-runtime-gone",
    ];
    const PINS: Pin[] = ["none", "agent-bound-M-legacy", "agent-bound-M-legacy-unpinned", "task-pinned-M-legacy"];
    const DEVICES: Devices[] = ["unbound", "bound-M", "bound-M-legacy", "bound-M-and-M-legacy"];

    interface Fixture {
      store: ReturnType<typeof createLocalStore>;
      codexId: string; claudeId: string; legacyId: string;
      taskId: string; issueId: string | null; projectId: string | null;
      shape: Shape; pin: Pin; devices: Devices; dedicated: boolean;
      label: string;
    }

    /**
     * Build one cell. Every cell gets its own store, so a claim cannot leak into
     * another cell and the assertions do not depend on test order.
     */
    function cell(shape: Shape, pin: Pin, devices: Devices, dedicated: boolean): Fixture {
      const label = `${shape} / ${pin} / ${devices} / ${dedicated ? "dedicated" : "shared"}`;
      const store = createCellStore();
      const codex = store.registerRuntime({
        id: "rt_inv_m_codex", name: "M codex", provider: "codex", workspaceId: "local", daemonId: M,
        metadata: { runtime_workspaces: 1 },
      });
      const claude = store.registerRuntime({
        id: "rt_inv_m_claude", name: "M claude", provider: "claude", workspaceId: "local", daemonId: M,
        metadata: { runtime_workspaces: 1 },
      });
      // M and M' are the two registrations of ONE machine: M is current and
      // keeps M' daemon's name as its legacy alias, while M' still registers
      // under that older daemon id. This is the shape that makes the
      // `legacy_daemon_id` joins load-bearing — a workspace recorded on M must
      // still admit M' even though M' s daemon id differs from M's.
      matrixDb.run("UPDATE multiremi_runtimes SET legacy_daemon_id = ? WHERE id = ?", [M_LEGACY, codex.id]);
      const legacy = store.registerRuntime({
        id: "rt_inv_m_legacy", name: "M prime", provider: "codex", workspaceId: "local", daemonId: M_LEGACY,
        metadata: { runtime_workspaces: 1 },
      });
      // Same workspace — the claim-time refresh only scans the claimant's
      // workspace — but a provider no cell's Agent uses, so it runs the refresh
      // and then cannot take the task. That leaves the row queued in exactly the
      // state a real claimant would find it.
      store.registerRuntime({
        id: "rt_inv_settler", name: "settler", provider: "claude", workspaceId: "local",
        daemonId: "dev-inv-settler",
      });
      store.updateDaemonDedicated("local", "dev-inv-settler", true, "local");
      if (shape === "runtime-workspace-on-U") {
        matrixDb.run(
          `INSERT INTO multiremi_daemon_profiles (workspace_id, daemon_id, display_name, dedicated, updated_at)
           VALUES ('local', ?, 'U', ?, ?)`,
          [U, dedicated ? 1 : 0, new Date().toISOString()],
        );
      } else if (dedicated) {
        store.updateDaemonDedicated("local", M, true, "local");
        if (shape === "runtime-workspace-on-M-legacy") {
          store.updateDaemonDedicated("local", M_LEGACY, true, "local");
        }
      }

      const provider = shape === "issue-workspace-on-M" && pin === "none" && devices === "bound-M"
        ? "claude" : "codex";
      const agent = store.createAgent({
        name: `matrix ${shape}`, provider, workspaceId: "local",
        ...(pin.startsWith("agent-bound-M-legacy") ? { runtimeId: legacy.id } : {}),
      });

      const hasProject = shape !== "chat";
      const project = hasProject ? store.createProject({ title: `matrix ${label}`, workspaceId: "local" }) : null;
      if (project) {
        if (devices === "bound-M" || devices === "bound-M-and-M-legacy") {
          store.createProjectDevice(project.id, { daemonId: M });
        }
        if (devices === "bound-M-legacy" || devices === "bound-M-and-M-legacy") {
          store.createProjectDevice(project.id, { daemonId: M_LEGACY });
        }
      }

      let taskId: string;
      let issueId: string | null = null;
      if (shape === "chat") {
        const chat = store.createChatSession({ agentId: agent.id, projectId: null, workspaceId: "local" });
        taskId = store.sendChatMessage(chat.id, { body: "matrix" }).task.id;
      } else {
        const issue = store.createIssue({
          title: `matrix ${label}`, projectId: project!.id, workspaceId: "local",
        });
        issueId = issue.id;
        let sessionId: string | undefined;
        if (shape === "issue-holds-zero") {
          sessionId = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false }).id;
        } else if (shape === "with-code-on-M") {
          // The snapshot needs a parent lane that recorded a Runtime. Seed it by
          // driving the lane directly, so the cell does not depend on whether
          // this cell's device routing happens to admit the seeding Runtime.
          const parent = store.createIssueSession(issue.id, { title: "Main", holdsWorkspace: true });
          store.getOrCreateSessionAgentLane(parent.id, agent.id);
          matrixDb.run(
            `UPDATE multiremi_session_agent_lanes SET runtime_id = ?, provider = 'codex',
               provider_session_id = 'sess_matrix_code', updated_at = ?
             WHERE session_id = ? AND agent_id = ?`,
            [codex.id, "2026-01-01T00:00:00.000Z", parent.id, agent.id],
          );
          sessionId = store.createIssueSession(issue.id, {
            title: "Side", parentSessionId: parent.id, withCode: true, holdsWorkspace: false,
          }).id;
        }
        taskId = store.createTask({
          agentId: agent.id, issueId: issue.id, ...(sessionId ? { issueSessionId: sessionId } : {}),
          prompt: "matrix",
        }).id;
      }

      // Shape-specific state, applied after creation so the real creation path
      // stays the one under test.
      if (shape === "issue-workspace-on-M") {
        store.reportIssueWorkspace({
          issueId: issueId!, runtimeId: codex.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1",
          status: "ready", repos: [],
        });
      } else if (shape === "workspace-runtime-gone") {
        store.reportIssueWorkspace({
          issueId: issueId!, runtimeId: codex.id, rootPath: "/tmp/MUL-1", branchName: "agent/MUL-1",
          status: "ready", repos: [],
        });
        // ON DELETE SET NULL, the state `deleteRuntimeWithinTransaction` leaves.
        matrixDb.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL WHERE issue_id = ?", [issueId]);
      } else if (shape.startsWith("runtime-workspace-")) {
        const workspace = (store as unknown as {
          runtimeWorkspaces: { create(runtimeId: string, input: { name: string; root_path: string }): { id: string } };
        }).runtimeWorkspaces.create(codex.id, { name: `matrix ${label}`, root_path: "/tmp/matrix-rw" });
        if (shape === "runtime-workspace-on-U") {
          matrixDb.run("UPDATE multiremi_runtime_workspaces SET daemon_id = ? WHERE id = ?", [U, workspace.id]);
        } else if (shape === "runtime-workspace-on-M-legacy") {
          matrixDb.run("UPDATE multiremi_runtime_workspaces SET daemon_id = ? WHERE id = ?", [M_LEGACY, workspace.id]);
        } else if (shape === "runtime-workspace-archived-on-M") {
          matrixDb.run("UPDATE multiremi_runtime_workspaces SET archived_at = ? WHERE id = ?", [new Date().toISOString(), workspace.id]);
        }
        matrixDb.run("UPDATE multiremi_tasks SET runtime_workspace_id = ? WHERE id = ?", [workspace.id, taskId]);
      } else if (shape === "frozen-retry-on-M") {
        matrixDb.run(
          `UPDATE multiremi_tasks SET runtime_id = ?, attempt = 2, execution_fingerprint = 'matrix-fp' WHERE id = ?`,
          [codex.id, taskId],
        );
      }
      if (pin === "task-pinned-M-legacy") {
        matrixDb.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id = ?", [legacy.id, taskId]);
      } else if (pin === "agent-bound-M-legacy-unpinned") {
        // Isolate the Agent constraint from the task pin. With U's workspace,
        // removing agentBinding must now change (c) into the daemon fallback.
        matrixDb.run("UPDATE multiremi_tasks SET runtime_id = NULL WHERE id = ?", [taskId]);
      }
      return {
        store, codexId: codex.id, claudeId: claude.id, legacyId: legacy.id,
        taskId, issueId, projectId: project?.id ?? null, shape, pin, devices, dedicated, label,
      };
    }

    /** The Runtimes this matrix compares verdicts for. */
    function runtimeIds(fixture: Fixture): string[] {
      return [fixture.codexId, fixture.claudeId, fixture.legacyId];
    }

    /**
     * Run the claim-time refresh the way production does — a claim attempt by a
     * Runtime that cannot take the task — and leave the row queued.
     */
    function settle(fixture: Fixture): void {
      fixture.store.claimTask("rt_inv_settler");
    }

    /**
     * Claim the task for real and require the winner to be one the probe
     * predicted. Returns the winning Runtime, or null when nobody can take it.
     */
    function probeWinner(fixture: Fixture, probed: string[]): string | null {
      for (const runtimeId of runtimeIds(fixture)) {
        const claimed = fixture.store.claimTask(runtimeId);
        if (claimed?.id === fixture.taskId) {
          if (!probed.includes(runtimeId)) {
            throw new Error(`[${fixture.label}] claim won on ${runtimeId} outside probe ${JSON.stringify(probed)}`);
          }
          return runtimeId;
        }
      }
      return null;
    }

    /** Does the claim actually accept this Runtime, without leaking state? */
    function claimAccepts(fixture: Fixture, runtimeId: string): boolean {
      let accepted = false;
      try {
        matrixDb.transaction(() => {
          accepted = fixture.store.claimTask(runtimeId)?.id === fixture.taskId;
          throw new Error("__rollback__");
        })();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
      }
      return accepted;
    }

    it("keeps the probe verdict, the claim result and the wait text consistent in every cell", () => {
      const failures: string[] = [];
      let cells = 0;
      for (const shape of SHAPES) {
        for (const pin of PINS) {
          for (const devices of DEVICES) {
            // A Chat task has no Project, so the device columns collapse to the
            // "unbound" case and run once per dedicated flag.
            if ((shape === "chat" || shape === "runtime-workspace-on-U") && devices !== "unbound") continue;
            for (const dedicated of [false, true]) {
              cells++;
              const fixture = cell(shape, pin, devices, dedicated);
              const fail = (detail: string) => failures.push(`[${fixture.label}] ${detail}`);

              // 1. Let the claim-time refresh settle the row first. The claim
              // predicate is evaluated AFTER that refresh has had its chance to
              // re-pool a stale pin, so a verdict taken beforehand describes a
              // state no claimant ever sees.
              settle(fixture);
              // 2. Per-Runtime verdict vs the real claim, on the settled row and
              // with each claim rolled back, so verdicts do not depend on order.
              const verdicts = fixture.store.describeTaskPlacement(fixture.taskId);
              for (const verdict of verdicts) {
                const accepts = claimAccepts(fixture, verdict.runtimeId);
                const says = verdict.placementOk && verdict.routingOk;
                if (says !== accepts) {
                  fail(`per-Runtime mismatch on ${verdict.runtimeId}: probe says ${says}, claim says ${accepts}`);
                }
              }
              const probed = verdicts
                .filter((verdict) => verdict.placementOk && verdict.routingOk)
                .map((verdict) => verdict.runtimeId)
                .sort();

              // Absolute expectations for the cells where a shared fragment is
              // load-bearing. Consistency alone cannot catch a mutation that
              // changes BOTH paths the same way, so these pin the semantics: the
              // legacy-daemon columns are exactly what the `legacy_daemon_id`
              // joins exist for.
              const expectations: Array<[boolean, string]> = [];
              if (shape === "issue-workspace-on-M" && devices === "bound-M-legacy") {
                expectations.push([probed.includes(fixture.legacyId),
                  `workspace on M + binding on M's legacy alias must admit M' (probed ${JSON.stringify(probed)})`]);
              }
              if (shape === "issue-workspace-on-M" && devices === "bound-M" && pin === "none") {
                // A pin that conflicts with the workspace legitimately removes
                // every candidate, so this holds only without one.
                expectations.push([probed.includes(fixture.claudeId),
                  `workspace on M + binding on M must admit M (probed ${JSON.stringify(probed)})`]);
              }
              if (shape === "issue-no-workspace" && pin === "none" && devices === "bound-M" && !dedicated) {
                expectations.push([probed.includes(fixture.codexId),
                  `unbound Issue + binding on M must admit M (probed ${JSON.stringify(probed)})`]);
              }
              if (shape === "issue-no-workspace" && pin === "none" && devices === "bound-M-legacy") {
                expectations.push([probed.includes(fixture.legacyId),
                  `unbound Issue + binding on M's legacy alias must admit M' (probed ${JSON.stringify(probed)})`]);
              }
              // Dedicated admission lives in the routing fragment's second
              // clause: a dedicated machine must refuse work with no Project
              // binding, which only holds while its parameter is passed through.
              if (shape === "issue-no-workspace" && pin === "none" && devices === "unbound" && dedicated) {
                expectations.push([!probed.includes(fixture.codexId),
                  `dedicated M with no Project binding must not admit M (probed ${JSON.stringify(probed)})`]);
              }
              if (shape === "runtime-workspace-on-M" && pin === "none") {
                expectations.push([probed.includes(fixture.codexId),
                  `active explicit workspace on M must admit M regardless of bindings/dedicated (probed ${JSON.stringify(probed)})`]);
              }
              if (shape === "runtime-workspace-on-M-legacy" && pin === "none") {
                expectations.push([probed.includes(fixture.legacyId) && !probed.includes(fixture.codexId),
                  `explicit workspace on M' must admit only its exact daemon (probed ${JSON.stringify(probed)})`]);
                expectations.push([verdicts.find((v) => v.runtimeId === fixture.codexId)?.routingOk === !dedicated,
                  "a dedicated M must not use the explicit-workspace exception for M'"]);
              }
              if (shape === "runtime-workspace-archived-on-M") {
                expectations.push([probed.length === 0,
                  `archived explicit workspace must not be claimed (probed ${JSON.stringify(probed)})`]);
                expectations.push([verdicts.find((v) => v.runtimeId === fixture.codexId)?.routingOk === !dedicated,
                  "archived explicit workspace must not bypass dedicated admission"]);
              }
              for (const [ok, detail] of expectations) if (!ok) fail(detail);

              // Observe while still queued: claiming first would clear a wrong
              // wait reason and hide disagreement with an allowed routing state.
              const now = Date.now();
              matrixDb.run("UPDATE multiremi_tasks SET created_at = ? WHERE id = ?", [
                new Date(now - 200_000).toISOString(), fixture.taskId,
              ]);
              fixture.store.refreshQueuedCapabilityWaitReasons(now);
              const reason = fixture.store.getTask(fixture.taskId)!.waitReason ?? null;

              // 3. The real claim outcome must be one the probe predicted.
              const claimedBy = probeWinner(fixture, probed);
              const claimable = claimedBy !== null;
              if (!claimable && probed.length > 0) {
                fail(`probe listed ${JSON.stringify(probed)} but no claim won`);
              }

              if (claimable) {
                // (a) a machine can take it: never a placement or device reason.
                if (reason?.startsWith("等待任务落点：") || reason?.startsWith("等待项目设备：")) {
                  fail(`(a) claimable but labelled: ${reason}`);
                }
                continue;
              }
              // The task is settled and queued: what does the observer owe?
              const placementCandidates = verdicts.filter((verdict) => verdict.placementOk);
              if (placementCandidates.length > 0) {
                // (b) placement holds somewhere, every such machine is refused
                // by device routing. The text must name exactly those machines.
                if (!reason?.startsWith("等待项目设备：")) {
                  fail(`(b) expected a device wait, got: ${reason}`);
                  continue;
                }
                const expected = new Set(placementCandidates.map((verdict) => verdict.daemonId));
                const listed = reason.match(/^等待项目设备：任务钉在 (.*?)（/)?.[1]?.split(" / ") ?? [];
                const actual = new Set(listed.map((name) => {
                  const matching = [...runtimeIds(fixture), "rt_inv_settler"]
                    .map((id) => fixture.store.getRuntime(id))
                    .find((runtime) => runtime && (runtime.daemonDisplayName === name || runtime.name === name));
                  return matching?.daemonId ?? name;
                }));
                if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
                  fail(`(b) machine names ${JSON.stringify([...actual])} differ from placement ${JSON.stringify([...expected])}: ${reason}`);
                }
                continue;
              }
              // (c) nothing satisfies placement. Either the conflict text, or the
              // daemon fallback when every constraint names one unregistered machine.
              if (shape === "runtime-workspace-on-U" && pin === "none") {
                if (reason !== null) {
                  fail(`(c) active explicit workspace admits its unregistered owner even when dedicated, got: ${reason}`);
                }
              } else if (!reason?.startsWith("等待任务落点：")) {
                fail(`(c) expected placement wait, got: ${reason}`);
              }
            }
          }
        }
      }
      // Chat and explicit U workspaces use only the unbound device column.
      expect(cells).toBe(11 * 4 * 4 * 2 - 2 * 4 * 3 * 2);
      expect(failures).toEqual([]);
      console.info(`MUL-449 ${dialect} matrix: ${cells} combinations; per-Runtime rollback probes, real claims and wait-text checks passed`);
    },
    { timeout: dialect === "postgres" ? 600_000 : 120_000 });

  });
  }

  it("resets an Issue lane whose device the Project no longer allows", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_lane_reset_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "dev-lane-reset-a",
    });
    const b = store.registerRuntime({
      id: "rt_lane_reset_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-lane-reset-b",
    });
    const agent = store.createAgent({ name: "Lane reset", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Moves A to B", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-lane-reset-a" });
    const issue = store.createIssue({ title: "Lane issue", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });

    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_lane_reset" });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({
      runtimeId: a.id, providerSessionId: "sess_lane_reset",
    });

    // The Project moves to B. The lane may not be resumed on A any more.
    store.deleteProjectDevice(project.id, "dev-lane-reset-a");
    store.createProjectDevice(project.id, { daemonId: "dev-lane-reset-b" });
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({
      runtimeId: null, providerSessionId: null,
    });
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  it("resets a lane a previously-claiming dedicated device no longer qualifies for", () => {
    const store = createLocalStore();
    const personal = store.registerRuntime({
      id: "rt_lane_personal", name: "personal", provider: "codex", workspaceId: "local", daemonId: "dev-lane-personal",
    });
    const pooled = store.registerRuntime({
      id: "rt_lane_pooled", name: "pooled", provider: "codex", workspaceId: "local", daemonId: "dev-lane-pooled",
    });
    const agent = store.createAgent({ name: "Polluted lane", provider: "codex", workspaceId: "local" });
    // Project P1 legitimately binds the personal device.
    const p1 = store.createProject({ title: "P1 owns personal", workspaceId: "local" });
    store.createProjectDevice(p1.id, { daemonId: "dev-lane-personal" });
    const p1Issue = store.createIssue({ title: "P1 issue", projectId: p1.id, workspaceId: "local" });
    const p1Session = store.createIssueSession(p1Issue.id, { title: "Discussion", holdsWorkspace: false });
    const seeded = store.createTask({
      agentId: agent.id, issueId: p1Issue.id, issueSessionId: p1Session.id, prompt: "first",
    });
    expect(store.claimTask(personal.id)?.id).toBe(seeded.id);
    store.startTask(seeded.id);
    store.completeTask(seeded.id, { output: "ok", sessionId: "sess_polluted" });

    // The bug being fixed: P2's lane records the personal device (the MBP
    // really did claim other Projects' topic turns while the exemption was in
    // place). Once the device is dedicated, P2's next turn must not inherit it.
    const p2 = store.createProject({ title: "P2 must not use personal", workspaceId: "local" });
    const p2Issue = store.createIssue({ title: "P2 issue", projectId: p2.id, workspaceId: "local" });
    const p2Session = store.createIssueSession(p2Issue.id, { title: "Discussion", holdsWorkspace: false });
    db!.run(
      `INSERT INTO multiremi_session_agent_lanes
         (session_id, agent_id, execution_scope, provider_session_id, runtime_id, provider, generation, status, created_at, updated_at)
       VALUES (?, ?, '', 'sess_from_mbp', ?, 'codex', 1, 'active', ?, ?)`,
      [p2Session.id, agent.id, personal.id, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    store.updateDaemonDedicated("local", "dev-lane-personal", true, "local");

    const next = store.createTask({
      agentId: agent.id, issueId: p2Issue.id, issueSessionId: p2Session.id, prompt: "next",
    });
    expect(store.getTask(next.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.claimTask(pooled.id)?.id).toBe(next.id);
  });

  it("re-pools a queued Issue turn whose lane the Project now refuses", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_queued_lane_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "dev-queued-lane-a",
    });
    const b = store.registerRuntime({
      id: "rt_queued_lane_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-queued-lane-b",
    });
    const agent = store.createAgent({ name: "Queued lane", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Moves while queued", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-queued-lane-a" });
    const issue = store.createIssue({ title: "Queued issue", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });

    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_queued_lane" });

    // The next turn is queued while A is still allowed, so it inherits A.
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    expect(store.getTask(second.id)).toMatchObject({
      runtimeId: a.id, sessionId: "sess_queued_lane", status: "queued",
    });
    store.deleteProjectDevice(project.id, "dev-queued-lane-a");
    store.createProjectDevice(project.id, { daemonId: "dev-queued-lane-b" });

    // The claim-time refresh re-pools it before the candidate scan, so the
    // rejected machine cannot park it forever.
    expect(store.claimTask(a.id)).toBeNull();
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  it("re-pools a stale Issue lane on B when its Agent is bound to allowed A", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({ id: "rt_stale_a", name: "A", provider: "codex", daemonId: "dev-stale-a" });
    const b = store.registerRuntime({ id: "rt_stale_b", name: "B", provider: "codex", daemonId: "dev-stale-b" });
    const agent = store.createAgent({ name: "Bound A", provider: "codex", runtimeId: a.id });
    const project = store.createProject({ title: "A only" });
    store.createProjectDevice(project.id, { daemonId: "dev-stale-a" });
    const issue = store.createIssue({ title: "Stale lane", projectId: project.id });
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "resume" });
    // Simulate a historical lane and queued task left on B after the binding moved.
    db!.run("UPDATE multiremi_tasks SET runtime_id = ?, session_id = ? WHERE id = ?", [b.id, "sess_stale", task.id]);
    db!.run(
      `UPDATE multiremi_session_agent_lanes SET runtime_id = ?, provider_session_id = ?
       WHERE session_id = ? AND agent_id = ?`,
      [b.id, "sess_stale", session.id, agent.id],
    );
    expect(store.claimTask(b.id)).toBeNull();
    expect(store.claimTask(a.id)?.id).toBe(task.id);
    expect(store.getTask(task.id)).toMatchObject({ runtimeId: a.id, status: "dispatched" });
  });

  it("leaves a queued Issue turn alone while its Project still allows the device", () => {
    const store = createLocalStore();
    const allowed = store.registerRuntime({
      id: "rt_queued_kept", name: "Allowed", provider: "codex", workspaceId: "local", daemonId: "dev-queued-kept",
    });
    const other = store.registerRuntime({
      id: "rt_queued_kept_other", name: "Other", provider: "codex", workspaceId: "local", daemonId: "dev-queued-kept-other",
    });
    const agent = store.createAgent({ name: "Queued kept", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Stays allowed", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-queued-kept" });
    const issue = store.createIssue({ title: "Kept queued", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });

    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    expect(store.claimTask(allowed.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_queued_kept" });
    const laneBefore = store.getSessionAgentLane(session.id, agent.id)!;
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });

    // Another machine's claim runs the refresh first; it must not disturb a
    // lane whose routing is still valid, so the pin, session and generation stay.
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.getTask(second.id)).toMatchObject({
      runtimeId: allowed.id, sessionId: "sess_queued_kept", status: "queued",
    });
    expect(store.getSessionAgentLane(session.id, agent.id)).toMatchObject({
      runtimeId: allowed.id, providerSessionId: "sess_queued_kept", generation: laneBefore.generation,
    });
    expect(store.claimTask(allowed.id)?.id).toBe(second.id);
  });

  // MUL-449 QA round 2, blocker 1: a Project holding a local_directory does
  // not lend that directory to a discussion session. Treating it as a hard
  // affinity stranded `holds_workspace=false` turns on the directory machine
  // once device routing rejected it.
  it("re-pools a discussion turn of a directory-backed Project after a rebinding", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_dir_disc_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "dev-dir-disc-a",
    });
    const b = store.registerRuntime({
      id: "rt_dir_disc_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-dir-disc-b",
    });
    const agent = store.createAgent({ name: "Directory discussion", provider: "codex", workspaceId: "local" });
    const project = store.createProject({
      title: "Directory project", workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/dir-a", daemon_id: "dev-dir-disc-a" } }],
    });
    store.createProjectDevice(project.id, { daemonId: "dev-dir-disc-a" });
    const issue = store.createIssue({ title: "Directory issue", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });

    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    // A discussion task never inherits the Project directory.
    expect(first).toMatchObject({ holdsWorkspace: false, runtimeId: null });
    expect(store.claimTask(a.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_dir_disc" });

    // Queue the next turn while A is still allowed, then move the binding.
    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: a.id, sessionId: "sess_dir_disc" });
    store.deleteProjectDevice(project.id, "dev-dir-disc-a");
    store.createProjectDevice(project.id, { daemonId: "dev-dir-disc-b" });

    expect(store.claimTask(a.id)).toBeNull();
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.claimTask(b.id)?.id).toBe(second.id);
  });

  it("does not treat a discussion turn as a directory pin in the base retirement path", () => {
    const store = createLocalStore();
    const a = store.registerRuntime({
      id: "rt_dir_retire_a", name: "A", provider: "codex", workspaceId: "local", daemonId: "dev-dir-retire-a",
    });
    const b = store.registerRuntime({
      id: "rt_dir_retire_b", name: "B", provider: "codex", workspaceId: "local", daemonId: "dev-dir-retire-b",
    });
    const agent = store.createAgent({ name: "Retiring directory", provider: "codex", workspaceId: "local" });
    const project = store.createProject({
      title: "Retiring directory project", workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/retire-a", daemon_id: "dev-dir-retire-a" } }],
    });
    store.createProjectDevice(project.id, { daemonId: "dev-dir-retire-a" });
    const issue = store.createIssue({ title: "Retiring issue", projectId: project.id, workspaceId: "local" });
    const discussion = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });
    const holding = store.createIssueSession(issue.id, { title: "Work", holdsWorkspace: true });
    const discussionTask = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: discussion.id, prompt: "discuss",
    });
    const holdingTask = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: holding.id, prompt: "work",
    });
    db!.run("UPDATE multiremi_tasks SET runtime_id = ? WHERE id IN (?, ?)", [a.id, discussionTask.id, holdingTask.id]);

    // The base re-pool path reads the same helper: the discussion turn must be
    // released, while the workspace-holding turn keeps its directory pin.
    (store as unknown as { runtimes: { repoolQueuedTasksForRuntime(id: string): void } })
      .runtimes.repoolQueuedTasksForRuntime(a.id);
    expect(store.getTask(discussionTask.id)?.runtimeId).toBeNull();
    expect(store.getTask(holdingTask.id)?.runtimeId).toBe(a.id);
  });

  it("does not re-pool a queued turn whose machine holds the Issue workspace", () => {
    const store = createLocalStore();
    const devbox = store.registerRuntime({
      id: "rt_ws_a", name: "devbox", provider: "codex", workspaceId: "local", daemonId: "dev-ws-a",
    });
    const other = store.registerRuntime({
      id: "rt_ws_b", name: "other", provider: "codex", workspaceId: "local", daemonId: "dev-ws-b",
    });
    const agent = store.createAgent({ name: "Workspace holder", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Moves", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-ws-a" });
    const issue = store.createIssue({ title: "Workspace issue", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Work", holdsWorkspace: true });
    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "hold",
    });
    expect(store.claimTask(devbox.id)?.id).toBe(task.id);
    db!.run("UPDATE multiremi_tasks SET status = 'queued', runtime_id = ? WHERE id = ?", [devbox.id, task.id]);

    store.deleteProjectDevice(project.id, "dev-ws-a");
    store.createProjectDevice(project.id, { daemonId: "dev-ws-b" });
    // The workspace lives on the devbox, so re-pooling would run it elsewhere
    // without the data. It keeps queuing instead of being silently stranded.
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ runtimeId: devbox.id, status: "queued" });
  });

  it("keeps resuming an Issue lane while the Project still allows its device", () => {
    const store = createLocalStore();
    const personal = store.registerRuntime({
      id: "rt_lane_kept_personal", name: "personal", provider: "codex", workspaceId: "local", daemonId: "dev-lane-kept",
    });
    const other = store.registerRuntime({
      id: "rt_lane_kept_other", name: "other", provider: "codex", workspaceId: "local", daemonId: "dev-lane-kept-other",
    });
    const agent = store.createAgent({ name: "Kept lane", provider: "codex", workspaceId: "local" });
    const project = store.createProject({ title: "Stays on personal", workspaceId: "local" });
    store.createProjectDevice(project.id, { daemonId: "dev-lane-kept" });
    store.updateDaemonDedicated("local", "dev-lane-kept", true, "local");
    const issue = store.createIssue({ title: "Kept issue", projectId: project.id, workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });

    const first = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "first",
    });
    expect(store.claimTask(personal.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_lane_kept" });

    const second = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "second",
    });
    // The routing check must not over-reject: the device is still bound.
    expect(store.getTask(second.id)).toMatchObject({
      runtimeId: personal.id, sessionId: "sess_lane_kept",
    });
    expect(store.claimTask(other.id)).toBeNull();
    expect(store.claimTask(personal.id)?.id).toBe(second.id);
  });

  it("does not inherit a lane from a Project-less session on a dedicated device", () => {
    const store = createLocalStore();
    const personal = store.registerRuntime({
      id: "rt_lane_none_personal", name: "personal", provider: "codex", workspaceId: "local", daemonId: "dev-lane-none",
    });
    const pooled = store.registerRuntime({
      id: "rt_lane_none_pooled", name: "pooled", provider: "codex", workspaceId: "local", daemonId: "dev-lane-none-pooled",
    });
    const agent = store.createAgent({ name: "Project-less lane", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({ title: "No project", workspaceId: "local" });
    const session = store.createIssueSession(issue.id, { title: "Discussion", holdsWorkspace: false });
    db!.run(
      `INSERT INTO multiremi_session_agent_lanes
         (session_id, agent_id, execution_scope, provider_session_id, runtime_id, provider, generation, status, created_at, updated_at)
       VALUES (?, ?, '', 'sess_projectless', ?, 'codex', 1, 'active', ?, ?)`,
      [session.id, agent.id, personal.id, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    );
    store.updateDaemonDedicated("local", "dev-lane-none", true, "local");

    const task = store.createTask({
      agentId: agent.id, issueId: issue.id, issueSessionId: session.id, prompt: "project-less",
    });
    expect(store.getTask(task.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.claimTask(pooled.id)?.id).toBe(task.id);
  });

  it("re-pools a chat turn instead of pinning it to a device the Project rejects", () => {
    const store = createLocalStore();
    const personal = store.registerRuntime({
      id: "rt_pin_personal",
      name: "personal",
      provider: "codex",
      workspaceId: "local",
      daemonId: "device-pin-personal",
    });
    const devbox = store.registerRuntime({
      id: "rt_pin_devbox",
      name: "devbox",
      provider: "codex",
      workspaceId: "local",
      daemonId: "device-pin-devbox",
    });
    const agent = store.createAgent({ name: "Pinned chat", provider: "codex", workspaceId: "local" });
    const issue = store.createIssue({
      title: "Topic with a moving device",
      workspaceId: "local",
      assigneeType: "agent",
      assigneeId: agent.id,
    });
    const chat = prepareFeishuIssueTopic(store, {
      runtimeId: personal.id,
      agentId: agent.id,
      issueId: issue.id,
    });
    const project = store.createProject({ title: "Moves later", workspaceId: "local" });
    db!.run("UPDATE multiremi_issues SET project_id = ? WHERE id = ?", [project.id, issue.id]);
    store.createProjectDevice(project.id, { daemonId: "device-pin-personal" });

    // The first report runs on the allowed device and promotes its provider session.
    const first = store.createTask({
      agentId: agent.id, chatSessionId: chat.id, issueId: issue.id, holdsWorkspace: false, prompt: "first report",
    });
    expect(store.claimTask(personal.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_pinned_chat" });
    expect(store.getChatSession(chat.id)?.sessionRuntimeId).toBe(personal.id);

    // The Project moves to another device and the old one becomes dedicated
    // to other work. The established session may no longer be resumed there.
    store.deleteProjectDevice(project.id, "device-pin-personal");
    store.createProjectDevice(project.id, { daemonId: "device-pin-devbox" });
    store.updateDaemonDedicated("local", "device-pin-personal", true, "local");
    const second = store.createTask({
      agentId: agent.id, chatSessionId: chat.id, issueId: issue.id, holdsWorkspace: false, prompt: "second report",
    });

    // Without the device-routing guard the turn stays pinned to the rejected
    // device and queues forever: neither runtime can claim it.
    expect(store.getTask(second.id)).toMatchObject({ runtimeId: null, sessionId: null, status: "queued" });
    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.claimTask(devbox.id)?.id).toBe(second.id);
  });

  it("treats a missing daemon profile as non-dedicated", () => {
    const store = createStore();
    const runtime = store.registerRuntime({
      id: "rt_profile_default",
      name: "profile default",
      provider: "codex",
      daemonId: "device-no-profile",
    });
    db!.run(
      "DELETE FROM multiremi_daemon_profiles WHERE workspace_id = ? AND daemon_id = ?",
      ["local", "device-no-profile"],
    );
    const agent = store.createAgent({ name: "Default admission agent", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "unrestricted" });

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
  });

  it("re-pools a stale dispatch when the project becomes bound to another device", () => {
    const store = createStore();
    const devbox = store.registerRuntime({
      id: "rt_stale_devbox",
      name: "devbox",
      provider: "codex",
      daemonId: "device-stale-devbox",
    });
    const personal = store.registerRuntime({
      id: "rt_stale_personal",
      name: "personal",
      provider: "codex",
      daemonId: "device-stale-personal",
    });
    const agent = store.createAgent({ name: "Stale routing", provider: "codex" });
    const project = store.createProject({ title: "Becomes personal" });
    const issue = store.createIssue({ title: "Move after dispatch", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "move" });

    expect(store.claimTask(devbox.id)?.id).toBe(task.id);
    store.createProjectDevice(project.id, { daemonId: "device-stale-personal" });
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);

    expect(store.claimTask(devbox.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: null });
    expect(store.claimTask(personal.id)?.id).toBe(task.id);
  });

  it("re-pools a stale dispatch when its device becomes dedicated to other projects", () => {
    const store = createStore();
    const personal = store.registerRuntime({
      id: "rt_stale_dedicated",
      name: "personal",
      provider: "codex",
      daemonId: "device-stale-dedicated",
    });
    const devbox = store.registerRuntime({
      id: "rt_stale_fallback",
      name: "devbox",
      provider: "codex",
      daemonId: "device-stale-fallback",
    });
    const agent = store.createAgent({ name: "Stale dedicated", provider: "codex" });
    const ordinaryProject = store.createProject({ title: "Ordinary" });
    const ordinaryIssue = store.createIssue({ title: "Ordinary issue", projectId: ordinaryProject.id });
    const allowedProject = store.createProject({ title: "Allowed" });
    store.createProjectDevice(allowedProject.id, { daemonId: "device-stale-dedicated" });
    const task = store.createTask({ agentId: agent.id, issueId: ordinaryIssue.id, prompt: "fallback" });

    expect(store.claimTask(personal.id)?.id).toBe(task.id);
    store.updateDaemonDedicated("local", "device-stale-dedicated", true, "local");
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);

    expect(store.claimTask(personal.id)).toBeNull();
    expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: null });
    expect(store.claimTask(devbox.id)?.id).toBe(task.id);
  });

  it("runs one Issue across different agents and runtimes concurrently", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_issue_codex", name: "codex", provider: "codex" });
    const claude = store.registerRuntime({ id: "rt_issue_claude", name: "claude", provider: "claude" });
    const codexAgent = store.createAgent({ name: "Issue Codex", provider: "codex" });
    const claudeAgent = store.createAgent({ name: "Issue Claude", provider: "claude" });
    const issue = store.createIssue({ title: "One workspace", workspaceId: "local" });
    const first = store.createTask({ agentId: codexAgent.id, issueId: issue.id, prompt: "first" });
    const second = store.createTask({ agentId: claudeAgent.id, issueId: issue.id, prompt: "second" });

    expect(store.claimTask(codex.id)?.id).toBe(first.id);
    expect(store.claimTask(claude.id)?.id).toBe(second.id);

    store.startTask(first.id);
    store.completeTask(first.id, { output: "done" });
    expect(store.getTask(second.id)?.status).toBe("dispatched");
  });

  it("pins follow-up Issue tasks to the runtime that owns its workspace", () => {
    const store = createStore();
    const firstRuntime = store.registerRuntime({ id: "rt_workspace_a", name: "a", provider: "codex" });
    const otherRuntime = store.registerRuntime({ id: "rt_workspace_b", name: "b", provider: "codex" });
    const agent = store.createAgent({ name: "Workspace Agent", provider: "codex" });
    const issue = store.createIssue({ title: "Runtime affinity", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: firstRuntime.id,
      rootPath: "/tmp/MUL-1",
      branchName: "agent/MUL-1",
      status: "ready",
      repos: [],
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "continue" });

    expect(store.claimTask(otherRuntime.id)).toBeNull();
    expect(store.claimTask(firstRuntime.id)?.id).toBe(task.id);
  });

  it("MUL-467 never creates an orphaned workspace on deletion and releases its task after explicit abandonment", () => {
    const store = createStore();
    const source = store.registerRuntime({ id: "rt_mul467_source", name: "source", provider: "codex" });
    const target = store.registerRuntime({ id: "rt_mul467_target", name: "target", provider: "codex" });
    const agent = store.createAgent({ name: "Recovery", provider: "codex" });
    const issue = store.createIssue({ title: "Deletion invariant" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: source.id, rootPath: "/tmp/mul467",
      branchName: `agent/${issue.key}`, status: "dirty" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "continue" });
    expect(store.deleteRuntime(source.id)).toBe(false);
    expect(store.deleteRuntimeWithArchivedAgentCleanup(source.id).status).toBe("active_issue_workspaces");
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ status: "dirty", runtimeId: source.id });
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.claimTask(target.id)).toBeNull();
    expect(store.deleteRuntimeWithArchivedAgentCleanup(source.id, { abandonIssueWorkspaces: true })).toEqual({
      status: "deleted", issueWorkspacesAbandoned: 1,
    });
    expect(db!.query("SELECT issue_id FROM multiremi_issue_workspaces WHERE status != 'cleaned' AND runtime_id IS NULL").all()).toEqual([]);
    expect(store.claimTask(target.id)?.id).toBe(task.id);
  });

  it("MUL-467 gives historical orphaned workspaces a concrete recovery command and restores claiming", () => {
    const store = createStore();
    const source = store.registerRuntime({ id: "rt_mul467_legacy", name: "legacy", provider: "codex" });
    const target = store.registerRuntime({ id: "rt_mul467_recovery", name: "recovery", provider: "codex" });
    const agent = store.createAgent({ name: "Legacy recovery", provider: "codex" });
    const issue = store.createIssue({ title: "Historical orphan" });
    store.reportIssueWorkspace({ issueId: issue.id, runtimeId: source.id, rootPath: "/tmp/mul467-legacy",
      branchName: `agent/${issue.key}`, status: "ready" });
    db!.run("UPDATE multiremi_issue_workspaces SET runtime_id = NULL, status = 'runtime_offline' WHERE issue_id = ?", [issue.id]);
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "resume" });
    expect(store.claimTask(target.id)).toBeNull();
    store.refreshQueuedCapabilityWaitReasons(Date.now() + 120_000);
    expect(store.getTask(task.id)?.waitReason).toContain(`remi issue workspace abandon ${issue.id} --yes`);
    expect(store.abandonIssueWorkspace(issue.id, "local").status).toBe("abandoned");
    expect(store.claimTask(target.id)?.id).toBe(task.id);
  });

  it("lets another provider on the same daemon continue a persistent Issue workspace", () => {
    const store = createStore();
    const claude = store.registerRuntime({
      id: "rt_workspace_claude",
      name: "claude",
      provider: "claude",
      daemonId: "machine-a",
    });
    const codex = store.registerRuntime({
      id: "rt_workspace_codex",
      name: "codex",
      provider: "codex",
      daemonId: "machine-a",
    });
    const otherCodex = store.registerRuntime({
      id: "rt_workspace_codex_elsewhere",
      name: "codex elsewhere",
      provider: "codex",
      daemonId: "machine-b",
    });
    const agent = store.createAgent({ name: "Codex follower", provider: "codex" });
    const issue = store.createIssue({ title: "Cross-provider continuation", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: claude.id,
      rootPath: "/tmp/MUL-1",
      branchName: "agent/MUL-1",
      status: "ready",
      repos: [],
    });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "continue with Codex" });

    expect(store.claimTask(otherCodex.id)).toBeNull();
    expect(store.claimTask(codex.id)?.id).toBe(task.id);

    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: codex.id,
      rootPath: "/tmp/MUL-1",
      branchName: "agent/MUL-1",
      status: "in_use",
      repos: [],
    });
    expect(store.getIssueWorkspace(issue.id)?.runtimeId).toBe(codex.id);
    expect(store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: codex.id,
      ...readyArchiveBinding(store, issue.id, codex.id),
    }).status).toBe("cleaned");
  });

  it("rejects Issue workspace reports and cleanup from a different daemon", () => {
    const store = createStore();
    const owner = store.registerRuntime({
      id: "rt_workspace_owner",
      name: "owner",
      provider: "claude",
      daemonId: "machine-a",
    });
    const foreign = store.registerRuntime({
      id: "rt_workspace_foreign",
      name: "foreign",
      provider: "codex",
      daemonId: "machine-b",
    });
    const issue = store.createIssue({ title: "Machine affinity", workspaceId: "local" });
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: owner.id,
      rootPath: "/tmp/MUL-1",
      branchName: "agent/MUL-1",
      status: "ready",
      repos: [],
    });

    expect(() => store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: foreign.id,
      rootPath: "/tmp/MUL-1",
      branchName: "agent/MUL-1",
      status: "in_use",
      repos: [],
    })).toThrow("runtime does not own active issue workspace");
    const binding = readyArchiveBinding(store, issue.id, owner.id);
    expect(() => store.markIssueWorkspaceCleaned({
      issueId: issue.id,
      runtimeId: foreign.id,
      ...binding,
    }))
      .toThrow("runtime does not own issue workspace");
  });

  it("keeps Issue tasks off legacy runtimes without blocking ordinary tasks", () => {
    const store = createStore();
    const legacyRuntime = store.registerRuntime({
      id: "rt_legacy_issue_workspace",
      name: "legacy",
      provider: "codex",
      metadata: { cli_version: "v0.2.24" },
    });
    const currentRuntime = store.registerRuntime({
      id: "rt_current_issue_workspace",
      name: "current",
      provider: "codex",
      metadata: { cli_version: "v0.2.26", parallel_agent_execution: 1 },
    });
    const agent = store.createAgent({ name: "Workspace Agent", provider: "codex" });
    const issue = store.createIssue({ title: "Use persistent workspace", workspaceId: "local" });
    const issueTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "issue work" });
    const ordinaryTask = store.createTask({ agentId: agent.id, prompt: "ordinary work" });

    expect(store.claimTask(legacyRuntime.id)?.id).toBe(ordinaryTask.id);
    store.startTask(ordinaryTask.id);
    store.completeTask(ordinaryTask.id, { output: "done" });
    expect(store.claimTask(legacyRuntime.id)).toBeNull();
    expect(store.claimTask(currentRuntime.id)?.id).toBe(issueTask.id);
  });

  it("claims queued tasks by runtime provider and completes them", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex", maxConcurrentTasks: 2 });
    const other = store.createAgent({ name: "Claude", provider: "claude" });
    const issue = store.createIssue({ title: "Fix bug", workspaceId: "local" });
    const codexTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Fix the bug" });
    store.createTask({ agentId: other.id, issueId: issue.id, prompt: "Should not claim" });
    const runtime = store.registerRuntime({ name: "local-codex", provider: "codex", workspaceId: "local" });

    const claimed = store.claimTask(runtime.id);
    expect(claimed?.id).toBe(codexTask.id);
    expect(claimed?.status).toBe("dispatched");
    expect(claimed?.agent?.provider).toBe("codex");

    store.startTask(codexTask.id);
    store.appendTaskMessages(codexTask.id, [
      { type: "assistant", content: "done" },
      { type: "usage", content: "{}" },
    ]);
    store.reportTaskUsage(codexTask.id, [{
      provider: "codex",
      model: "test",
      inputTokens: 10,
      outputTokens: 4,
    }]);
    const completed = store.completeTask(codexTask.id, { output: "done", sessionId: "sess_1", workDir: "/tmp/work" });

    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("done");
    expect(completed.sessionId).toBe("sess_1");
    const rawResult = db!.query("SELECT result FROM multiremi_tasks WHERE id = ?").get(codexTask.id) as { result: string };
    expect(JSON.parse(rawResult.result)).toEqual({
      pr_url: "",
      output: "done",
      session_id: "sess_1",
      work_dir: "/tmp/work",
    });
    expect(store.listTaskMessages(codexTask.id)).toHaveLength(2);
    expect(store.getTask(codexTask.id)?.usage[0].inputTokens).toBe(10);

    const legacyTask = store.createTask({ agentId: agent.id, prompt: "legacy result row" });
    db!.run("UPDATE multiremi_tasks SET status = 'completed', result = ? WHERE id = ?", ["legacy done", legacyTask.id]);
    expect(store.getTask(legacyTask.id)?.result).toBe("legacy done");
  });

  it("routes tasks to an agent-bound runtime before falling back to provider matching", () => {
    const store = createStore();
    const firstRuntime = store.registerRuntime({ id: "rt_first_codex", name: "first", provider: "codex" });
    const secondRuntime = store.registerRuntime({ id: "rt_second_codex", name: "second", provider: "codex" });
    const boundAgent = store.createAgent({ name: "Bound Codex", provider: "codex", runtimeId: secondRuntime.id });
    const task = store.createTask({ agentId: boundAgent.id, prompt: "Run on the bound runtime" });

    expect(boundAgent.runtimeId).toBe(secondRuntime.id);
    expect(task.runtimeId).toBe(secondRuntime.id);
    expect(store.claimTask(firstRuntime.id)).toBeNull();
    expect(store.claimTask(secondRuntime.id)?.id).toBe(task.id);
  });

  it("claims unbound agents' tasks from any provider-matching runtime and stamps the claimer", () => {
    const store = createStore();
    const claude = store.registerRuntime({ id: "rt_pool_claude", name: "pool claude", provider: "claude" });
    const codexA = store.registerRuntime({ id: "rt_pool_codex_a", name: "pool codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_pool_codex_b", name: "pool codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Pool Codex", provider: "codex" });
    expect(agent.runtimeId).toBeNull();
    const task = store.createTask({ agentId: agent.id, prompt: "run anywhere" });
    expect(task.runtimeId).toBeNull();

    expect(store.claimTask(claude.id)).toBeNull();
    expect(store.claimTask(codexA.id)?.id).toBe(task.id);
    expect(store.getTask(task.id)?.runtimeId).toBe(codexA.id);

    const secondAgent = store.createAgent({ name: "Pool Codex 2", provider: "codex" });
    const secondTask = store.createTask({ agentId: secondAgent.id, prompt: "second machine" });
    expect(store.claimTask(codexB.id)?.id).toBe(secondTask.id);
    expect(store.getTask(secondTask.id)?.runtimeId).toBe(codexB.id);

    const anyRuntime = store.registerRuntime({ id: "rt_pool_any", name: "pool any", provider: "any" });
    const thirdAgent = store.createAgent({ name: "Pool Codex 3", provider: "codex" });
    const thirdTask = store.createTask({ agentId: thirdAgent.id, prompt: "any provider" });
    expect(store.claimTask(anyRuntime.id)?.id).toBe(thirdTask.id);
  });

  it("keeps private runtimes from claiming other members' agent tasks", () => {
    const store = createStore();
    const bobPrivate = store.registerRuntime({
      id: "rt_own_bob_private",
      name: "bob private",
      provider: "codex",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "private",
    });
    const bobPublic = store.registerRuntime({
      id: "rt_own_bob_public",
      name: "bob public",
      provider: "codex",
      workspaceId: "local",
      ownerId: "bob",
      visibility: "public",
    });
    const aliceAgent = store.createAgent({ name: "Alice codex", provider: "codex", workspaceId: "local", ownerId: "alice" });
    const issueA = store.createIssue({ title: "alice a", workspaceId: "local" });
    const task = store.createTask({ agentId: aliceAgent.id, issueId: issueA.id, prompt: "alice work", workspaceId: "local" });

    // Bob's private machine must not receive alice's agent (custom_env /
    // mcp_config ride along with a claim); his public one may.
    expect(store.claimTask(bobPrivate.id)).toBeNull();
    expect(store.claimTask(bobPublic.id)?.id).toBe(task.id);

    // A stamp is NOT an escape hatch: the unauthenticated /tasks API lets any
    // member stamp an arbitrary agent+runtime, so bob stamping alice's private
    // agent to his own private runtime must still be refused at claim time.
    const issueB = store.createIssue({ title: "alice b", workspaceId: "local" });
    store.createTask({
      agentId: aliceAgent.id,
      issueId: issueB.id,
      prompt: "stamped-steal",
      workspaceId: "local",
      runtimeId: bobPrivate.id,
    });
    expect(store.claimTask(bobPrivate.id)).toBeNull();

    // Bob's own agents still flow to his private machine.
    const bobAgent = store.createAgent({ name: "Bob codex", provider: "codex", workspaceId: "local", ownerId: "bob" });
    const bobTask = store.createTask({ agentId: bobAgent.id, prompt: "bob work", workspaceId: "local" });
    expect(store.claimTask(bobPrivate.id)?.id).toBe(bobTask.id);
  });

  it("pairs an owner-null private runtime with local agents but not multi-user ones", () => {
    const store = createStore();
    // Single-machine shape: runtime registered without auth (owner null),
    // default agent owner "local" — must still pair.
    const localRuntime = store.registerRuntime({ id: "rt_null_owner", name: "local box", provider: "codex", visibility: "private" });
    expect(localRuntime.ownerId).toBeNull();
    const localAgent = store.createAgent({ name: "Local codex", provider: "codex" });
    expect(localAgent.ownerId).toBe("local");
    const localTask = store.createTask({ agentId: localAgent.id, prompt: "local work" });
    expect(store.claimTask(localRuntime.id)?.id).toBe(localTask.id);
    store.startTask(localTask.id);
    store.completeTask(localTask.id, { output: "done" });

    // Multi-user shape: a real member's agent must NOT be swept up by the same
    // owner-null private runtime.
    const aliceAgent = store.createAgent({ name: "Alice codex", provider: "codex", ownerId: "alice" });
    store.createTask({ agentId: aliceAgent.id, prompt: "alice work" });
    expect(store.claimTask(localRuntime.id)).toBeNull();
  });

  it("re-pools and abandons the session when the chat runtime can no longer run the agent", () => {
    const store = createStore();
    const codexA = store.registerRuntime({ id: "rt_repool_a", name: "codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_repool_b", name: "codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Repool", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codexA.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_repool", workDir: "/tmp/repool" });

    // The machine that holds the session is deleted → its runtime row is gone.
    store.deleteRuntime(codexA.id);
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    // Task re-pools (not pinned to the dead runtime) and drops the now-orphan
    // session/work_dir so the new machine doesn't resume a vanished session.
    expect(followUp.runtimeId).toBeNull();
    expect(followUp.sessionId).toBeNull();
    expect(followUp.workDir).toBeNull();
    expect(store.claimTask(codexB.id)?.id).toBe(followUp.id);
  });

  it("truly abandons the provider session on a resume-unsafe chat retry", () => {
    const store = createStore();
    const codexA = store.registerRuntime({ id: "rt_unsafe_a", name: "codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_unsafe_b", name: "codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Unsafe", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codexA.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_unsafe", workDir: "/tmp/unsafe" });

    const second = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(store.claimTask(codexA.id)?.id).toBe(second.id);
    store.startTask(second.id);
    // Resume-unsafe failure → retry must drop the session and re-pool, not
    // resume the failed session on codexA.
    store.failTask(second.id, { error: "stalled", failureReason: "codex_semantic_inactivity" });
    const retry = store.listTasks().find((task) => task.parentTaskId === second.id)!;
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(retry.workDir).toBeNull();
    // Any codex machine can pick it up (fresh session), including a different one.
    expect(store.claimTask(codexB.id)?.id).toBe(retry.id);
  });

  it("atomically clears stale Chat lineage before creating one cold retry", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_stale_chat", name: "stale chat", provider: "codex" });
    const agent = store.createAgent({ name: "Stale Chat", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "stale" });
    const first = store.sendChatMessage(session.id, { body: "first turn" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "first answer", sessionId: "sess_dead", workDir: "/tmp/dead" });

    const second = store.sendChatMessage(session.id, { body: "resume me" });
    expect(store.claimTask(runtime.id)?.id).toBe(second.task.id);
    store.startTask(second.task.id);
    store.failTask(second.task.id, {
      error: "Stale provider session: no conversation found",
      failureReason: "agent_error.stale_session",
    });

    expect(store.getChatSession(session.id)).toMatchObject({
      sessionId: null,
      workDir: null,
      sessionRuntimeId: null,
      sessionProvider: null,
      sessionExecutionFingerprint: null,
    });
    const retries = store.listTasks().filter((task) => task.parentTaskId === second.task.id);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      attempt: 2,
      runtimeId: null,
      sessionId: null,
      workDir: null,
      chatSessionId: session.id,
    });
    expect(store.listChatMessages(session.id).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  it("does not cold-retry Chat for server, auth, quota, or network failures", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_non_stale_chat", name: "non stale", provider: "codex" });
    const agent = store.createAgent({ name: "Non-stale Chat", provider: "codex" });
    for (const [index, failureReason] of [
      "agent_error.provider_server_error",
      "agent_error.provider_auth_or_access",
      "agent_error.provider_quota_limit",
      "agent_error.provider_network",
    ].entries()) {
      const session = store.createChatSession({ agentId: agent.id, title: failureReason });
      const first = store.sendChatMessage(session.id, { body: `warm ${index}` });
      expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
      store.startTask(first.task.id);
      store.completeTask(first.task.id, { output: "warm", sessionId: `sess_keep_${index}`, workDir: `/tmp/keep-${index}` });
      const failed = store.sendChatMessage(session.id, { body: "try once" });
      expect(store.claimTask(runtime.id)?.id).toBe(failed.task.id);
      store.startTask(failed.task.id);
      store.failTask(failed.task.id, { error: failureReason, failureReason });
      expect(store.listTasks().filter((task) => task.parentTaskId === failed.task.id)).toHaveLength(0);
      expect(store.getChatSession(session.id)).toMatchObject({
        sessionId: `sess_keep_${index}`,
        workDir: `/tmp/keep-${index}`,
      });
    }
  });

  it("stops stale Chat recovery at max_attempts without preserving the dead lineage", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_stale_limit", name: "stale limit", provider: "codex" });
    const agent = store.createAgent({ name: "Stale Limit", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "limit" });
    const warm = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "warm" });
    expect(store.claimTask(runtime.id)?.id).toBe(warm.id);
    store.startTask(warm.id);
    store.completeTask(warm.id, { output: "warm", sessionId: "sess_limit", workDir: "/tmp/limit" });
    const terminal = store.createTask({
      agentId: agent.id,
      chatSessionId: session.id,
      prompt: "last try",
      maxAttempts: 1,
    });
    expect(store.claimTask(runtime.id)?.id).toBe(terminal.id);
    store.startTask(terminal.id);
    store.failTask(terminal.id, {
      error: "Stale provider session: no conversation found",
      failureReason: "agent_error.stale_session",
    });
    expect(store.listTasks().filter((task) => task.parentTaskId === terminal.id)).toHaveLength(0);
    expect(store.getChatSession(session.id)).toMatchObject({ sessionId: null, workDir: null });
    expect(store.listChatMessages(session.id).at(-1)).toMatchObject({
      role: "assistant",
      failureReason: "agent_error.stale_session",
    });
  });

  it("forces a task into its agent's workspace, blocking cross-workspace claims", () => {
    const store = createStore();
    // Alice's agent lives in workspace "wsA" and carries a secret.
    const secretAgent = store.createAgent({ name: "Secret", provider: "codex", workspaceId: "wsA", ownerId: "alice", customEnv: { SECRET: "leak-me" } });
    // Attacker (workspace "wsB") tries to create a task in their own workspace
    // referencing the other workspace's agent, then claim it from their runtime.
    const task = store.createTask({ agentId: secretAgent.id, workspaceId: "wsB", prompt: "steal" });
    // The task is forced into the agent's workspace, not the caller-supplied one.
    expect(task.workspaceId).toBe("wsA");
    const attackerRuntime = store.registerRuntime({ id: "rt_attacker", name: "attacker", provider: "codex", workspaceId: "wsB", visibility: "public" });
    expect(store.claimTask(attackerRuntime.id)).toBeNull();
  });

  it("re-pools queued tasks pinned to a runtime when it is deleted or turned private", () => {
    const store = createStore();
    const codexA = store.registerRuntime({ id: "rt_drift_a", name: "codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_drift_b", name: "codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Drift", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codexA.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_drift", workDir: "/tmp/drift" });
    // Follow-up is pinned to codexA by session affinity while codexA is alive.
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(followUp.runtimeId).toBe(codexA.id);

    // Deleting codexA re-pools the queued follow-up (and drops the orphan session).
    store.deleteRuntime(codexA.id);
    const repooled = store.getTask(followUp.id)!;
    expect(repooled.runtimeId).toBeNull();
    expect(repooled.sessionId).toBeNull();
    expect(store.claimTask(codexB.id)?.id).toBe(followUp.id);
  });

  it("re-pools a queued task when its pinned runtime turns private under another owner", () => {
    const store = createStore();
    const shared = store.registerRuntime({ id: "rt_flip", name: "shared", provider: "codex", ownerId: "bob", visibility: "public" });
    const codexOther = store.registerRuntime({ id: "rt_flip_other", name: "other", provider: "codex" });
    const agent = store.createAgent({ name: "Flip", provider: "codex", ownerId: "alice" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(shared.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_flip", workDir: "/tmp/flip" });
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(followUp.runtimeId).toBe(shared.id);

    // Bob makes the runtime private → alice's pinned task must re-pool, not hang.
    store.updateRuntime(shared.id, { visibility: "private" });
    expect(store.getTask(followUp.id)?.runtimeId).toBeNull();
    // codexOther (owner null → 'local' ... vs alice) can't run it, but a public
    // machine could; here it stays unclaimable by the now-private one.
    expect(store.claimTask(shared.id)).toBeNull();
  });

  it("keeps a NULL-workspace runtime from claiming other workspaces' tasks", () => {
    const store = createStore();
    // A runtime registered without a workspace (stored NULL) must only claim
    // local-workspace tasks, not every workspace's.
    const looseRuntime = store.registerRuntime({ id: "rt_no_ws", name: "loose", provider: "codex", visibility: "public" });
    expect(looseRuntime.workspaceId).toBeNull();
    const otherAgent = store.createAgent({ name: "Other ws", provider: "codex", workspaceId: "wsX" });
    store.createTask({ agentId: otherAgent.id, prompt: "in wsX" });
    expect(store.claimTask(looseRuntime.id)).toBeNull();
    // A local-workspace task it can claim.
    const localAgent = store.createAgent({ name: "Local ws", provider: "codex" });
    const localTask = store.createTask({ agentId: localAgent.id, prompt: "in local" });
    expect(store.claimTask(looseRuntime.id)?.id).toBe(localTask.id);
  });

  it("forces a task into its agent's workspace and rejects cross-workspace issue links", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "WS agent", provider: "codex", workspaceId: "wsA" });
    // An issue in a different workspace can't be linked to this agent's task.
    const foreignIssue = store.createIssue({ title: "foreign", workspaceId: "wsB" });
    expect(() => store.createTask({ agentId: agent.id, issueId: foreignIssue.id, prompt: "x" })).toThrow(/workspace/i);
    // A same-workspace issue is fine, and the task lands in the agent's workspace.
    const ownIssue = store.createIssue({ title: "own", workspaceId: "wsA" });
    const task = store.createTask({ agentId: agent.id, issueId: ownIssue.id, workspaceId: "wsB", prompt: "x" });
    expect(task.workspaceId).toBe("wsA");
  });

  it("rejects a cross-workspace autopilot assignee", () => {
    const store = createStore();
    const foreignAgent = store.createAgent({ name: "Foreign", provider: "codex", workspaceId: "wsB" });
    expect(() =>
      store.createAutopilot({ title: "AP", workspaceId: "wsA", assigneeType: "agent", assigneeId: foreignAgent.id }),
    ).toThrow(/different workspace/i);
    // Same-workspace assignee is accepted.
    const ownAgent = store.createAgent({ name: "Own", provider: "codex", workspaceId: "wsA" });
    const ap = store.createAutopilot({ title: "AP", workspaceId: "wsA", assigneeType: "agent", assigneeId: ownAgent.id });
    expect(ap.assigneeId).toBe(ownAgent.id);
  });

  it("does not persist a squad with a cross-workspace leader", () => {
    const store = createStore();
    const foreignLeader = store.createAgent({ name: "Foreign lead", provider: "codex", workspaceId: "wsB" });
    expect(() => store.createSquad({ name: "S", workspaceId: "wsA", leaderId: foreignLeader.id })).toThrow(/different workspace/i);
    // No squad row was written.
    expect(store.listSquads().find((sq) => sq.name === "S")).toBeUndefined();
  });

  it("drops an explicitly-passed old-engine session when the agent switched engines", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_drop_codex", name: "codex", provider: "codex" });
    const claude = store.registerRuntime({ id: "rt_drop_claude", name: "claude", provider: "claude" });
    const agent = store.createAgent({ name: "Dropper", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codex.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "codex-session", workDir: "/tmp/codex" });

    // Switch to claude, then a chat send re-passes the old session fields explicitly.
    store.updateAgent(agent.id, { provider: "claude" });
    const next = store.createTask({
      agentId: agent.id,
      chatSessionId: session.id,
      sessionId: "codex-session",
      workDir: "/tmp/codex",
      prompt: "after switch",
    });
    // The old-engine session/work_dir must be dropped, and it re-pools onto claude.
    expect(next.runtimeId).toBeNull();
    expect(next.sessionId).toBeNull();
    expect(next.workDir).toBeNull();
    expect(store.claimTask(claude.id)?.id).toBe(next.id);
  });

  it("promotes session metadata atomically — a sessionless task can't mislabel the old session's engine", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_atomic_codex", name: "codex", provider: "codex" });
    const claude = store.registerRuntime({ id: "rt_atomic_claude", name: "claude", provider: "claude" });
    const agent = store.createAgent({ name: "Atomic", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codex.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "codex-session", workDir: "/tmp/codex" });
    expect(store.getChatSession(session.id)?.sessionProvider).toBe("codex");

    // Agent switches to claude; a claude task runs and completes WITHOUT a new
    // session id (e.g. it produced no provider session). It must NOT overwrite
    // the session's runtime/provider while leaving the old codex session_id.
    store.updateAgent(agent.id, { provider: "claude" });
    const noSess = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "no session" });
    // (this claude task re-pools; the codex session is not resumable for claude)
    expect(store.claimTask(claude.id)?.id).toBe(noSess.id);
    store.startTask(noSess.id);
    store.completeTask(noSess.id, { output: "done" }); // no sessionId
    const meta = store.getChatSession(session.id)!;
    // The old codex session stays consistently labelled as codex (not claude).
    expect(meta.sessionId).toBe("codex-session");
    expect(meta.sessionProvider).toBe("codex");
    expect(meta.sessionRuntimeId).toBe(codex.id);
  });

  it("fails closed on a missing execution snapshot for resume-safe retries", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_failclosed", name: "codex", provider: "codex" });
    const agent = store.createAgent({ name: "FailClosed", provider: "codex" });
    const issue = store.createIssue({ title: "i", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(store.claimTask(codex.id)?.id).toBe(task.id);
    store.startTask(task.id);
    // Simulate a pre-snapshot in-flight task (rolling upgrade): clear provider.
    db!.run("UPDATE multiremi_tasks SET provider = NULL WHERE id = ?", [task.id]);
    store.failTask(task.id, { error: "offline", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((t) => t.parentTaskId === task.id)!;
    // Unknown execution engine → can't prove resume-safety → fresh re-pool.
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
  });

  it("snapshots the execution engine so a mid-run agent switch can't mislabel an any-runtime session", () => {
    const store = createStore();
    const anyRuntime = store.registerRuntime({ id: "rt_snap_any", name: "any", provider: "any" });
    const agent = store.createAgent({ name: "MidSwitch", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const task = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    // Claim snapshots the execution engine (codex) onto the task.
    const claimed = store.claimTask(anyRuntime.id)!;
    expect(claimed.provider).toBe("codex");
    store.startTask(task.id);
    // Agent switches to claude WHILE the task runs, then it completes.
    store.updateAgent(agent.id, { provider: "claude" });
    store.completeTask(task.id, { output: "ok", sessionId: "codex-session", workDir: "/tmp/codex" });
    // The session is labelled with the engine it actually ran under (codex),
    // not the agent's now-current provider (claude).
    expect(store.getChatSession(session.id)?.sessionProvider).toBe("codex");
    // A claude follow-up therefore does NOT resume the codex session.
    const next = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "next" });
    expect(next.sessionId).toBeNull();
  });

  it("moves chat-session runtime metadata when a runtime id is merged", () => {
    const store = createStore();
    const oldRuntime = store.registerRuntime({
      id: "rt_merge_old",
      name: "old",
      provider: "codex",
      daemonId: "daemon-old",
      legacyDaemonId: "legacy-x",
      models: [
        { id: "old-only", label: "Old only", provider: "codex", default: false },
        { id: "shared", label: "Old shared", provider: "codex", default: true },
      ],
    });
    const agent = store.createAgent({ name: "Merger", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const task = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(oldRuntime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "ok", sessionId: "sess_merge", workDir: "/tmp/merge" });
    expect(store.getChatSession(session.id)?.sessionRuntimeId).toBe(oldRuntime.id);
    const issue = store.createIssue({ title: "Merged lane" });
    const issueSession = store.getOrCreateDefaultIssueSession(issue.id);
    store.getOrCreateSessionAgentLane(issueSession.id, agent.id);
    db!.run(
      "UPDATE multiremi_session_agent_lanes SET runtime_id = ? WHERE session_id = ? AND agent_id = ?",
      [oldRuntime.id, issueSession.id, agent.id],
    );
    store.reportIssueWorkspace({
      issueId: issue.id,
      runtimeId: oldRuntime.id,
      rootPath: "/tmp/merge-issue",
      branchName: `agent/${issue.key}`,
      status: "ready",
    });
    const modelListRequest = store.createRuntimeModelListRequest(oldRuntime.id);
    const updateRequest = store.createRuntimeUpdateRequest(oldRuntime.id, { targetVersion: "2.0.0" });
    const skillListRequest = store.createRuntimeLocalSkillListRequest(oldRuntime.id);
    const skillImportRequest = store.createRuntimeLocalSkillImportRequest(oldRuntime.id, { skillKey: "legacy-skill" });
    const directoryScanRequest = store.createRuntimeDirectoryScanRequest(oldRuntime.id, { root: "/tmp" });
    // Merge the old runtime id into a new one; the session metadata follows.
    const newRuntime = store.registerRuntime({
      id: "rt_merge_new",
      name: "new",
      provider: "codex",
      daemonId: "daemon-old",
      models: [
        { id: "shared", label: "New shared", provider: "codex", default: true },
        { id: "new-only", label: "New only", provider: "codex", default: false },
      ],
    });
    store.mergeRuntimeInto(oldRuntime.id, newRuntime.id);
    expect(store.getChatSession(session.id)?.sessionRuntimeId).toBe(newRuntime.id);
    expect(store.getSessionAgentLane(issueSession.id, agent.id)?.runtimeId).toBe(newRuntime.id);
    expect(store.getIssueWorkspace(issue.id)).toMatchObject({ runtimeId: newRuntime.id, status: "ready" });
    expect(store.listRuntimeModels(newRuntime.id).map((model) => ({
      id: model.id,
      label: model.label,
      default: model.default,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: "new-only", label: "New only", default: false },
      { id: "old-only", label: "Old only", default: false },
      { id: "shared", label: "New shared", default: true },
    ]);
    expect(store.getRuntimeModelListRequest(newRuntime.id, modelListRequest.id)?.id).toBe(modelListRequest.id);
    expect(store.getRuntimeUpdateRequest(newRuntime.id, updateRequest.id)?.id).toBe(updateRequest.id);
    expect(store.getRuntimeLocalSkillListRequest(newRuntime.id, skillListRequest.id)?.id).toBe(skillListRequest.id);
    expect(store.getRuntimeLocalSkillImportRequest(newRuntime.id, skillImportRequest.id)?.id).toBe(skillImportRequest.id);
    expect(store.getRuntimeDirectoryScanRequest(newRuntime.id, directoryScanRequest.id)?.id).toBe(directoryScanRequest.id);
    for (const table of [
      "multiremi_runtime_models",
      "multiremi_runtime_model_list_requests",
      "multiremi_runtime_update_requests",
      "multiremi_runtime_local_skill_list_requests",
      "multiremi_runtime_local_skill_import_requests",
      "multiremi_runtime_directory_scan_requests",
    ]) {
      expect(Number((db!.query(`SELECT COUNT(*) AS count FROM ${table} WHERE runtime_id = ?`).get(oldRuntime.id) as any).count))
        .toBe(0);
    }
    // A follow-up still resumes the session (its machine didn't "vanish").
    const next = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(next.runtimeId).toBe(newRuntime.id);
    expect(next.sessionId).toBe("sess_merge");
  });

  it("records the session's runtime and engine as chat-session metadata on promotion", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_meta", name: "r", provider: "codex" });
    const agent = store.createAgent({ name: "Meta", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    expect(store.getChatSession(session.id)?.sessionRuntimeId).toBeNull();
    const task = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "ok", sessionId: "sess_meta", workDir: "/tmp/meta" });
    const promoted = store.getChatSession(session.id)!;
    expect(promoted.sessionId).toBe("sess_meta");
    expect(promoted.sessionRuntimeId).toBe(runtime.id);
    expect(promoted.sessionProvider).toBe("codex");
  });

  it("resumes an any-runtime session only while the engine matches (recorded per session)", () => {
    const store = createStore();
    const anyRuntime = store.registerRuntime({ id: "rt_any_sess", name: "any", provider: "any" });
    const claude = store.registerRuntime({ id: "rt_any_claude", name: "claude", provider: "claude" });
    const agent = store.createAgent({ name: "AnySwitcher", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(anyRuntime.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "codex-session", workDir: "/tmp/codex" });
    // The session records the engine that produced it (codex), so a same-engine
    // follow-up resumes it even though the runtime itself is "any".
    const same = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(same.sessionId).toBe("codex-session");
    expect(same.runtimeId).toBe(anyRuntime.id);

    // Switch to claude: the recorded codex session no longer matches and must
    // not carry over, even though the any runtime could run claude.
    store.updateAgent(agent.id, { provider: "claude" });
    const afterSwitch = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "switched" });
    expect(afterSwitch.sessionId).toBeNull();
    // Unpinned → any claude machine can take it (starting a fresh session).
    expect(afterSwitch.runtimeId).toBeNull();
    expect(store.claimTask(claude.id)).not.toBeNull();
  });
});
