// Store-level task scheduling: which runtime may claim which task.
// Covers provider/agent-binding routing, private-runtime visibility, cross-workspace
// guards, re-pooling on runtime changes, and the execution-engine session snapshots.
import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — task claim, routing, and workspace scoping", () => {
  it("serializes one Issue across different agents and runtimes", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_issue_codex", name: "codex", provider: "codex" });
    const claude = store.registerRuntime({ id: "rt_issue_claude", name: "claude", provider: "claude" });
    const codexAgent = store.createAgent({ name: "Issue Codex", provider: "codex" });
    const claudeAgent = store.createAgent({ name: "Issue Claude", provider: "claude" });
    const issue = store.createIssue({ title: "One workspace", workspaceId: "local" });
    const first = store.createTask({ agentId: codexAgent.id, issueId: issue.id, prompt: "first" });
    const second = store.createTask({ agentId: claudeAgent.id, issueId: issue.id, prompt: "second" });

    expect(store.claimTask(codex.id)?.id).toBe(first.id);
    expect(store.claimTask(claude.id)).toBeNull();

    store.startTask(first.id);
    store.completeTask(first.id, { output: "done" });
    expect(store.claimTask(claude.id)?.id).toBe(second.id);
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
    const oldRuntime = store.registerRuntime({ id: "rt_merge_old", name: "old", provider: "codex", daemonId: "daemon-old", legacyDaemonId: "legacy-x" });
    const agent = store.createAgent({ name: "Merger", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const task = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(oldRuntime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.completeTask(task.id, { output: "ok", sessionId: "sess_merge", workDir: "/tmp/merge" });
    expect(store.getChatSession(session.id)?.sessionRuntimeId).toBe(oldRuntime.id);
    // Merge the old runtime id into a new one; the session metadata follows.
    const newRuntime = store.registerRuntime({ id: "rt_merge_new", name: "new", provider: "codex", daemonId: "daemon-old" });
    store.mergeRuntimeInto(oldRuntime.id, newRuntime.id);
    expect(store.getChatSession(session.id)?.sessionRuntimeId).toBe(newRuntime.id);
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
