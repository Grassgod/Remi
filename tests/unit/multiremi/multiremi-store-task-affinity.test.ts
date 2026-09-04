// Store-level task placement over time: local_directory pins, resume-safe vs
// resume-unsafe retries, stale-dispatch recovery, and what happens to an agent's
// queued tasks when its owner, workspace, or engine changes.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { MultiremiStore, daemonRuntimeId } from "@multiremi/store.js";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Multiremi store — local_directory affinity, retries, and agent re-homing", () => {
  function warmChat() {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_projection", name: "projection", provider: "claude" });
    const agent = store.createAgent({ name: "Projection", provider: "claude" });
    const chat = store.createChatSession({ agentId: agent.id, title: "Projection" });
    const first = store.sendChatMessage(chat.id, { body: "first" });
    expect(store.claimTask(runtime.id)?.id).toBe(first.task.id);
    store.startTask(first.task.id);
    store.completeTask(first.task.id, { output: "answer", sessionId: "sess_projection" });
    return { store, runtime, agent, chat };
  }

  it("uses the inherited provider lineage as the Chat delta decision", () => {
    const { store, chat } = warmChat();
    const followUp = store.sendChatMessage(chat.id, { body: "again" }).task;

    expect(followUp.sessionId).toBe("sess_projection");
    expect(store.buildTaskSessionProjection(followUp.id)?.mode).toBe("delta");
  });

  it("bootstraps a Chat projection when the promoted session id is empty", () => {
    const { store, chat } = warmChat();
    db!.run("UPDATE multiremi_chat_sessions SET session_id = NULL WHERE id = ?", [chat.id]);
    const followUp = store.sendChatMessage(chat.id, { body: "again" }).task;

    expect(followUp.sessionId).toBeNull();
    expect(store.buildTaskSessionProjection(followUp.id)?.mode).toBe("bootstrap");
  });

  it("bootstraps a Chat projection when the promoted runtime disappeared", () => {
    const { store, chat } = warmChat();
    db!.run("UPDATE multiremi_chat_sessions SET session_runtime_id = ? WHERE id = ?", ["rt_missing", chat.id]);
    const followUp = store.sendChatMessage(chat.id, { body: "again" }).task;

    expect(followUp.sessionId).toBeNull();
    expect(store.buildTaskSessionProjection(followUp.id)?.mode).toBe("bootstrap");
  });

  it("bootstraps a Chat projection when the promoted runtime provider changed", () => {
    const { store, runtime, chat } = warmChat();
    db!.run("UPDATE multiremi_runtimes SET provider = 'codex' WHERE id = ?", [runtime.id]);
    const followUp = store.sendChatMessage(chat.id, { body: "again" }).task;

    expect(followUp.sessionId).toBeNull();
    expect(store.buildTaskSessionProjection(followUp.id)?.mode).toBe("bootstrap");
  });

  it("bootstraps a Chat projection when the execution fingerprint changed", () => {
    const { store, chat } = warmChat();
    db!.run("UPDATE multiremi_chat_sessions SET session_execution_fingerprint = ? WHERE id = ?", ["stale", chat.id]);
    const followUp = store.sendChatMessage(chat.id, { body: "again" }).task;

    expect(followUp.sessionId).toBeNull();
    expect(store.buildTaskSessionProjection(followUp.id)?.mode).toBe("bootstrap");
  });

  it("bootstraps a Chat projection when the Agent Plugin set changed", () => {
    const { store, runtime, agent, chat } = warmChat();
    const plugin = store.importAgentPlugin({
      provider: "claude",
      manifest: { name: "projection-plugin", version: "1.0.0" },
      files: [{ path: "skills/projection/SKILL.md", content: "# Projection\n" }],
    });
    store.createAgentPluginBinding(agent.id, { pluginId: plugin.id });
    store.reportAgentPluginRuntimeState(runtime.id, plugin.activeVersionId!, {
      status: "ready",
      observedDigest: plugin.activeVersion!.artifactDigest,
    });
    const followUp = store.sendChatMessage(chat.id, { body: "again" }).task;

    expect(followUp.sessionId).toBeNull();
    expect(store.buildTaskSessionProjection(followUp.id)?.mode).toBe("bootstrap");
  });

  it("prefers local_directory affinity over chat session affinity", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_pref_dir", name: "dir", provider: "codex", daemonId: "daemon-pref-dir" });
    const sessRuntime = store.registerRuntime({ id: "rt_pref_sess", name: "sess", provider: "codex", daemonId: "daemon-pref-sess" });
    const agent = store.createAgent({ name: "Pref", provider: "codex" });
    // Establish a chat session whose provider session lives on sessRuntime.
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const warmup = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(sessRuntime.id)?.id).toBe(warmup.id);
    store.startTask(warmup.id);
    store.completeTask(warmup.id, { output: "ok", sessionId: "sess_pref", workDir: "/tmp/pref" });

    // A follow-up that is ALSO a directory-project issue must go to the
    // directory machine, not the session machine, and must not inherit the
    // foreign-machine session.
    const project = store.createProject({
      title: "P",
      workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/p", daemon_id: "daemon-pref-dir" } }],
    });
    const issue = store.createIssue({ title: "dir", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, chatSessionId: session.id, issueId: issue.id, prompt: "work" });
    expect(task.runtimeId).toBe(dirRuntime.id);
    expect(task.sessionId).toBeNull();
    expect(store.claimTask(dirRuntime.id)?.id).toBe(task.id);
  });

  it("degrades a resume-safe retry to a fresh re-pool when the agent's engine changed", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_retry_codex2", name: "codex", provider: "codex" });
    const claude = store.registerRuntime({ id: "rt_retry_claude2", name: "claude", provider: "claude" });
    const agent = store.createAgent({ name: "RetrySwitch", provider: "codex" });
    const issue = store.createIssue({ title: "i", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(store.claimTask(codex.id)?.id).toBe(task.id);
    store.startTask(task.id);
    // Switch the agent to claude, THEN the codex run fails with a resume-safe reason.
    store.updateAgent(agent.id, { provider: "claude" });
    store.failTask(task.id, { error: "offline", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((t) => t.parentTaskId === task.id)!;
    // The parent's codex runtime can't run a claude agent → retry re-pools fresh.
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(store.claimTask(claude.id)?.id).toBe(retry.id);
  });

  it("lets local_directory affinity override an explicit runtime override", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_ovr_dir", name: "dir", provider: "codex", daemonId: "daemon-ovr" });
    const wrongRuntime = store.registerRuntime({ id: "rt_ovr_wrong", name: "wrong", provider: "codex", daemonId: "daemon-wrong" });
    const agent = store.createAgent({ name: "Ovr", provider: "codex" });
    const project = store.createProject({
      title: "P",
      workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/p", daemon_id: "daemon-ovr" } }],
    });
    const issue = store.createIssue({ title: "dir", workspaceId: "local", projectId: project.id });
    // Explicitly try to pin the task to the WRONG machine.
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, runtimeId: wrongRuntime.id, prompt: "work" });
    // The directory affinity wins — the task is pinned to the machine that
    // holds the directory, not the caller-supplied one.
    expect(task.runtimeId).toBe(dirRuntime.id);
    expect(store.claimTask(wrongRuntime.id)).toBeNull();
    expect(store.claimTask(dirRuntime.id)?.id).toBe(task.id);
  });

  it("keeps the directory pin on a stale task whose agent was archived", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_arch_dir", name: "dir", provider: "codex", daemonId: "daemon-arch-dir" });
    const agent = store.createAgent({ name: "ArchDir", provider: "codex" });
    const project = store.createProject({
      title: "P",
      workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/p", daemon_id: "daemon-arch-dir" } }],
    });
    const issue = store.createIssue({ title: "dir", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(store.claimTask(dirRuntime.id)?.id).toBe(task.id);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", task.id]);
    store.archiveAgent(agent.id);
    // Stale recovery keeps the directory pin (archived_at parks the claim), so
    // a restore lands it back on the directory's machine, not elsewhere.
    expect(store.claimTask(dirRuntime.id)).toBeNull();
    expect(store.getTask(task.id)?.runtimeId).toBe(dirRuntime.id);
    store.restoreAgent(agent.id);
    expect(store.claimTask(dirRuntime.id)?.id).toBe(task.id);
  });

  it("does not redeliver a stale dispatched task after its agent is archived", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_arch_stale", name: "r", provider: "codex" });
    const agent = store.createAgent({ name: "Archiving", provider: "codex" });
    const task = store.createTask({ agentId: agent.id, prompt: "work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", task.id]);
    store.archiveAgent(agent.id);
    // Stale recovery must mirror the normal claim's archived-agent exclusion.
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(task.id)?.runtimeId).toBeNull();
  });

  it("re-pins (not re-pools) a stale local_directory task off an ineligible machine", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_stale_dir", name: "dir", provider: "codex", daemonId: "daemon-stale-dir" });
    store.registerRuntime({ id: "rt_stale_other", name: "other", provider: "codex", daemonId: "daemon-other" });
    const agent = store.createAgent({ name: "Dir", provider: "codex" });
    const project = store.createProject({
      title: "P",
      workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/p", daemon_id: "daemon-stale-dir" } }],
    });
    const issue = store.createIssue({ title: "dir issue", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(task.runtimeId).toBe(dirRuntime.id);
    expect(store.claimTask(dirRuntime.id)?.id).toBe(task.id);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", task.id]);
    // Owner change makes dirRuntime ineligible; stale recovery must re-pin to
    // the directory's daemon (never re-pool onto a machine without the dir).
    store.updateAgent(agent.id, { ownerId: "someone" });
    expect(store.claimTask(dirRuntime.id)).toBeNull();
    expect(store.getTask(task.id)?.runtimeId).toBe(dirRuntime.id);
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("fully cancels (terminal) an agent's tasks on workspace move, ending autopilot runs", () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_wsm_full", name: "a", provider: "codex", workspaceId: "wsA" });
    const agent = store.createAgent({ name: "Mover2", provider: "codex", workspaceId: "wsA" });
    const events: string[] = [];
    const off = store.onTaskEvent(({ type }) => { if (type === "task:cancelled") events.push(type); });
    const task = store.createTask({ agentId: agent.id, prompt: "work" });
    store.updateAgent(agent.id, { workspaceId: "wsB" });
    off();
    const cancelled = store.getTask(task.id)!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(events).toContain("task:cancelled");
  });


  it("keeps a local_directory task's pin through the startup migration", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_mig_dir", name: "dir", provider: "codex", daemonId: "daemon-mig-dir" });
    const agent = store.createAgent({ name: "DirLegacy", provider: "codex" });
    const project = store.createProject({
      title: "P",
      workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/p", daemon_id: "daemon-mig-dir" } }],
    });
    const issue = store.createIssue({ title: "dir", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    // local_directory task is pinned to the directory's runtime and has no session.
    expect(task.runtimeId).toBe(dirRuntime.id);
    expect(task.sessionId).toBeNull();
    // Re-running migrations must NOT unpin it (the directory only exists there).
    const reopened = new MultiremiStore(db!);
    expect(reopened.getTask(task.id)?.runtimeId).toBe(dirRuntime.id);
  });

  it("fails a resume-safe retry closed when the parent has neither a runtime stamp nor an engine snapshot", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_fc_nostamp", name: "codex", provider: "codex" });
    const agent = store.createAgent({ name: "NoStamp", provider: "codex" });
    const issue = store.createIssue({ title: "i", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(store.claimTask(codex.id)?.id).toBe(task.id);
    store.startTask(task.id);
    // An unpinned, pre-snapshot in-flight parent that nonetheless carries a
    // provider session: no runtime stamp AND no engine snapshot. Its engine
    // can't be proven to match the agent, so the resume must fail closed rather
    // than let the `!runtimeId` branch treat it as resumable.
    db!.run("UPDATE multiremi_tasks SET runtime_id = NULL, provider = NULL, session_id = ? WHERE id = ?", ["stale-session", task.id]);
    store.failTask(task.id, { error: "offline", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((t) => t.parentTaskId === task.id)!;
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
  });

  it("never resumes an unpinned parent's machine-local session (fail-closed even when the engine matches)", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_unpinned_sess", name: "codex", provider: "codex" });
    const agent = store.createAgent({ name: "Unpinned", provider: "codex" });
    const issue = store.createIssue({ title: "i", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(store.claimTask(codex.id)?.id).toBe(task.id);
    store.startTask(task.id);
    // A parent that kept its engine snapshot AND a machine-local session but
    // lost its runtime pin. We no longer know which machine holds the session,
    // so the retry must NOT stay unpinned-yet-resuming (any pool machine would
    // then resume a foreign machine's session) — it fails closed and re-pools.
    db!.run("UPDATE multiremi_tasks SET runtime_id = NULL, session_id = ?, work_dir = ? WHERE id = ?", ["orphan-session", "/tmp/orphan", task.id]);
    store.failTask(task.id, { error: "offline", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((t) => t.parentTaskId === task.id)!;
    expect(retry.runtimeId).toBeNull();
    expect(retry.sessionId).toBeNull();
    expect(retry.workDir).toBeNull();
  });

  it("resumes an issue-only local_directory retry's session with no chat session to inherit from", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_dir_resume", name: "dir", provider: "codex", daemonId: "daemon-dir-resume" });
    const agent = store.createAgent({ name: "DirResume", provider: "codex" });
    const project = store.createProject({
      title: "P",
      workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/p", daemon_id: "daemon-dir-resume" } }],
    });
    const issue = store.createIssue({ title: "dir", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(task.runtimeId).toBe(dirRuntime.id);
    expect(store.claimTask(dirRuntime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    // The run produced a provider session on the directory machine.
    db!.run("UPDATE multiremi_tasks SET session_id = ? WHERE id = ?", ["dir-session", task.id]);
    store.failTask(task.id, { error: "offline", failureReason: "runtime_offline" });
    const retry = store.listTasks().find((t) => t.parentTaskId === task.id)!;
    // Resume-safe (same machine still eligible, engine matches) → keep the pin
    // AND the session, even though there is no chat session gating inheritance.
    expect(retry.runtimeId).toBe(dirRuntime.id);
    expect(retry.sessionId).toBe("dir-session");
  });

  it("re-pins a local_directory task to the daemon's engine runtime when the pinned runtime changes provider", () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_repin", name: "r", provider: "codex", daemonId: "daemon-repin" });
    const agent = store.createAgent({ name: "RepinDir", provider: "codex" });
    const project = store.createProject({
      title: "P",
      workspaceId: "local",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/abs/p", daemon_id: "daemon-repin" } }],
    });
    const issue = store.createIssue({ title: "dir", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(task.runtimeId).toBe("rt_repin");
    // The same-id runtime re-registers under a different engine. The codex
    // agent's directory task must not be stranded on the now-claude runtime; it
    // re-pins to the daemon's codex runtime id (deterministic), which a codex
    // runtime coming up on that daemon can then claim. Skipping it would leave
    // it pinned to a runtime the claim predicate rejects forever.
    store.registerRuntime({ id: "rt_repin", name: "r", provider: "claude", daemonId: "daemon-repin" });
    const repinned = store.getTask(task.id)!;
    expect(repinned.runtimeId).toBe(daemonRuntimeId("daemon-repin", "codex"));
    expect(repinned.status).toBe("queued");
    const codex2 = store.registerRuntime({ id: daemonRuntimeId("daemon-repin", "codex"), name: "codex2", provider: "codex", daemonId: "daemon-repin" });
    expect(store.claimTask(codex2.id)?.id).toBe(task.id);
  });

  it("rejects an archived squad leader without persisting the squad", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Lead", provider: "codex", workspaceId: "local" });
    store.archiveAgent(agent.id);
    expect(() => store.createSquad({ name: "S2", workspaceId: "local", leaderId: agent.id })).toThrow(/archived/i);
    expect(store.listSquads().find((sq) => sq.name === "S2")).toBeUndefined();
  });

  it("re-pools a stale dispatched task the runtime may no longer run", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_stale", name: "stale", provider: "codex", ownerId: "alice", visibility: "private" });
    const agent = store.createAgent({ name: "Stale", provider: "codex", ownerId: "alice" });
    const task = store.createTask({ agentId: agent.id, prompt: "work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    // The dispatch response was lost (never started) and the recovery window passed.
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", task.id]);
    // Meanwhile the agent changed owner, so this runtime may no longer run it.
    store.updateAgent(agent.id, { ownerId: "bob" });
    // The stale re-claim must NOT hand the task back to the now-ineligible runtime.
    expect(store.claimTask(runtime.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.getTask(task.id)?.runtimeId).toBeNull();
  });

  it("rejects an autopilot whose project is in another workspace", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "AP agent", provider: "codex", workspaceId: "wsA" });
    const foreignProject = store.createProject({ title: "Foreign", workspaceId: "wsB" });
    expect(() =>
      store.createAutopilot({ title: "AP", workspaceId: "wsA", assigneeType: "agent", assigneeId: agent.id, projectId: foreignProject.id }),
    ).toThrow(/project is in a different workspace/i);
  });

  it("allows pausing an autopilot without re-validating an unchanged assignee", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "AP agent", provider: "codex", workspaceId: "wsA" });
    const ap = store.createAutopilot({ title: "AP", workspaceId: "wsA", assigneeType: "agent", assigneeId: agent.id });
    // Simulate drift: the agent later moves to another workspace.
    store.updateAgent(agent.id, { workspaceId: "wsB" });
    // A status-only update must still succeed (no assignee re-validation).
    const paused = store.updateAutopilot(ap.id, { status: "paused" });
    expect(paused.status).toBe("paused");
  });

  it("rejects a cross-workspace squad member", () => {
    const store = createStore();
    const squad = store.createSquad({ name: "Squad", workspaceId: "wsA" });
    const foreignAgent = store.createAgent({ name: "Foreign", provider: "codex", workspaceId: "wsB" });
    expect(() =>
      store.addSquadMember(squad.id, { memberType: "agent", memberId: foreignAgent.id }),
    ).toThrow(/different workspace/i);
  });

  it("re-homes an agent's queued tasks when its owner changes", () => {
    const store = createStore();
    const alicePrivate = store.registerRuntime({ id: "rt_owner_alice", name: "alice", provider: "codex", ownerId: "alice", visibility: "private" });
    const bobPrivate = store.registerRuntime({ id: "rt_owner_bob", name: "bob", provider: "codex", ownerId: "bob", visibility: "private" });
    const agent = store.createAgent({ name: "Owned", provider: "codex", ownerId: "alice" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(alicePrivate.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_owner", workDir: "/tmp/owner" });
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(followUp.runtimeId).toBe(alicePrivate.id);

    // Reassign the agent to bob → the queued task must leave alice's private pin.
    store.updateAgent(agent.id, { ownerId: "bob" });
    expect(store.getTask(followUp.id)?.runtimeId).toBeNull();
    expect(store.claimTask(bobPrivate.id)?.id).toBe(followUp.id);
  });

  it("cancels an agent's queued tasks when its workspace changes", () => {
    const store = createStore();
    const codexA = store.registerRuntime({ id: "rt_wsmove_a", name: "a", provider: "codex", workspaceId: "wsA" });
    const codexB = store.registerRuntime({ id: "rt_wsmove_b", name: "b", provider: "codex", workspaceId: "wsB" });
    const agent = store.createAgent({ name: "Mover", provider: "codex", workspaceId: "wsA" });
    const task = store.createTask({ agentId: agent.id, prompt: "work" });
    expect(task.workspaceId).toBe("wsA");
    // Moving the agent to wsB cancels the orphaned wsA task (rather than
    // migrating it and leaving a cross-workspace link); neither runtime claims it.
    store.updateAgent(agent.id, { workspaceId: "wsB" });
    expect(store.getTask(task.id)?.status).toBe("cancelled");
    expect(store.claimTask(codexA.id)).toBeNull();
    expect(store.claimTask(codexB.id)).toBeNull();
  });

  it("re-homes an agent's queued tasks when its engine switches", () => {
    const store = createStore();
    const codex = store.registerRuntime({ id: "rt_switch_codex", name: "codex", provider: "codex" });
    const claude = store.registerRuntime({ id: "rt_switch_claude", name: "claude", provider: "claude" });
    const agent = store.createAgent({ name: "Switcher", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "s" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(store.claimTask(codex.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "ok", sessionId: "sess_switch", workDir: "/tmp/switch" });
    // A follow-up is queued and pinned to the codex machine by session affinity.
    const followUp = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(followUp.runtimeId).toBe(codex.id);

    // Switching the agent to claude re-homes the queued task off the codex pin.
    store.updateAgent(agent.id, { provider: "claude" });
    const rehomed = store.getTask(followUp.id)!;
    expect(rehomed.runtimeId).toBeNull();
    expect(rehomed.sessionId).toBeNull();
    // The claude machine can now claim it.
    expect(store.claimTask(claude.id)?.id).toBe(followUp.id);
  });

  it("gives each owner their own default agent so a private runtime can run it", () => {
    const store = createStore();
    const bobPrivate = store.registerRuntime({ id: "rt_def_bob", name: "bob", provider: "claude", ownerId: "bob", visibility: "private" });
    const bobDefault = store.ensureDefaultAgent("claude", { workspaceId: "local", ownerId: "bob" });
    const aliceDefault = store.ensureDefaultAgent("claude", { workspaceId: "local", ownerId: "alice" });
    // Distinct per-owner agents, each owned by that member.
    expect(bobDefault.id).not.toBe(aliceDefault.id);
    expect(bobDefault.ownerId).toBe("bob");
    // Bob's private runtime can run Bob's own default agent's task.
    const task = store.createTask({ agentId: bobDefault.id, prompt: "onboard" });
    expect(store.claimTask(bobPrivate.id)?.id).toBe(task.id);
  });

  it("keeps unbound agents unbound when a daemon registers", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Pool stays unbound", provider: "codex", workspaceId: "local" });
    const app = createMultiremiApp({ store });
    const register = await app.request("/api/daemon/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ daemon_id: "daemon-pool", workspace_id: "local", runtimes: [{ name: "", type: "codex" }] }),
    });
    expect(register.status).toBe(200);
    expect(store.getAgent(agent.id)?.runtimeId).toBeNull();
  });

  it("unpins legacy agent runtime bindings at startup", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_legacy_pin", name: "legacy pin", provider: "codex" });
    const agent = store.createAgent({ name: "Legacy pinned", provider: "codex", runtimeId: runtime.id });
    expect(store.getAgent(agent.id)?.runtimeId).toBe(runtime.id);
    const reopened = new MultiremiStore(db!);
    expect(reopened.getAgent(agent.id)?.runtimeId).toBeNull();
  });

  it("keeps follow-up chat messages on the machine that holds the provider session", () => {
    const store = createStore();
    store.registerRuntime({ id: "rt_chat_codex_a", name: "chat codex a", provider: "codex" });
    const codexB = store.registerRuntime({ id: "rt_chat_codex_b", name: "chat codex b", provider: "codex" });
    const agent = store.createAgent({ name: "Chat pool", provider: "codex" });
    const session = store.createChatSession({ agentId: agent.id, title: "hello" });
    const first = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "hi" });
    expect(first.runtimeId).toBeNull();

    expect(store.claimTask(codexB.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "done", sessionId: "sess_chat_affinity", workDir: "/tmp/chat" });
    expect(store.getChatSession(session.id)?.sessionId).toBe("sess_chat_affinity");

    const second = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "again" });
    expect(second.runtimeId).toBe(codexB.id);
    // Same-engine follow-up resumes the promoted provider session + work_dir.
    expect(second.sessionId).toBe("sess_chat_affinity");
    expect(second.workDir).toBe("/tmp/chat");

    // A provider switch drops the affinity — a codex-machine stamp would make
    // the task unclaimable by any claude runtime — AND abandons the codex
    // session/work_dir so the claude engine doesn't resume a foreign session.
    store.updateAgent(agent.id, { provider: "claude" });
    const third = store.createTask({ agentId: agent.id, chatSessionId: session.id, prompt: "after switch" });
    expect(third.runtimeId).toBeNull();
    expect(third.sessionId).toBeNull();
    expect(third.workDir).toBeNull();
  });

  it("routes project tasks to the machine holding the local directory", () => {
    const store = createStore();
    const dirRuntime = store.registerRuntime({ id: "rt_dir_codex", name: "dir codex", provider: "codex", daemonId: "daemon-dir" });
    store.registerRuntime({ id: "rt_dir_claude", name: "dir claude", provider: "claude", daemonId: "daemon-dir" });
    store.registerRuntime({ id: "rt_elsewhere_codex", name: "elsewhere codex", provider: "codex", daemonId: "daemon-elsewhere" });
    const agent = store.createAgent({ name: "Dir pool", provider: "codex" });
    const project = store.createProject({ title: "Local project", workspaceId: "local" });
    store.createProjectResource(project.id, {
      resourceType: "local_directory",
      resourceRef: { local_path: "/abs/project", daemon_id: "daemon-dir" },
    });
    const issue = store.createIssue({ title: "dir issue", workspaceId: "local", projectId: project.id });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work in the local dir" });
    expect(task.runtimeId).toBe(dirRuntime.id);

    // A directory on a daemon with no runtime row (never registered / GC'd)
    // stamps the deterministic id that daemon's runtime WILL get, so the
    // task waits for the right machine instead of running elsewhere.
    const orphanProject = store.createProject({ title: "Orphan project", workspaceId: "local" });
    store.createProjectResource(orphanProject.id, {
      resourceType: "local_directory",
      resourceRef: { local_path: "/abs/orphan", daemon_id: "daemon-gone" },
    });
    const orphanIssue = store.createIssue({ title: "orphan issue", workspaceId: "local", projectId: orphanProject.id });
    const orphanTask = store.createTask({ agentId: agent.id, issueId: orphanIssue.id, prompt: "no machine has this" });
    expect(orphanTask.runtimeId).toBe(daemonRuntimeId("daemon-gone", "codex"));
    // Not claimable by machines that don't have the directory.
    expect(store.claimTask(dirRuntime.id)?.id).not.toBe(orphanTask.id);
    // Once the daemon registers (same deterministic id), the task dispatches there.
    const lateRuntime = store.registerRuntime({
      id: daemonRuntimeId("daemon-gone", "codex"),
      name: "late arrival",
      provider: "codex",
      daemonId: "daemon-gone",
    });
    expect(store.claimTask(lateRuntime.id)?.id).toBe(orphanTask.id);
  });

  it("frees resume-unsafe retries to the pool while resume-safe retries stay pinned", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_retry_codex", name: "retry codex", provider: "codex" });
    const agent = store.createAgent({ name: "Retry pool", provider: "codex" });

    const offlineIssue = store.createIssue({ title: "offline retry", workspaceId: "local" });
    const offlineTask = store.createTask({ agentId: agent.id, issueId: offlineIssue.id, prompt: "fails offline" });
    expect(store.claimTask(runtime.id)?.id).toBe(offlineTask.id);
    store.startTask(offlineTask.id);
    store.failTask(offlineTask.id, { error: "runtime went away", failureReason: "runtime_offline" });
    const offlineRetry = store.listTasks().find((task) => task.parentTaskId === offlineTask.id)!;
    expect(offlineRetry.runtimeId).toBe(runtime.id);

    const unsafeIssue = store.createIssue({ title: "unsafe retry", workspaceId: "local" });
    // Priority beats the queued offline retry in the claim ordering.
    const unsafeTask = store.createTask({ agentId: agent.id, issueId: unsafeIssue.id, prompt: "fails unsafely", priority: 100 });
    expect(store.claimTask(runtime.id)?.id).toBe(unsafeTask.id);
    store.startTask(unsafeTask.id);
    store.failTask(unsafeTask.id, { error: "stalled", failureReason: "codex_semantic_inactivity" });
    const unsafeRetry = store.listTasks().find((task) => task.parentTaskId === unsafeTask.id)!;
    expect(unsafeRetry.runtimeId).toBeNull();
  });

  it("keeps another member's private default agent out of the default endpoint", async () => {
    const store = createStore();
    store.createWorkspaceMember({ workspaceId: "local", userId: "alice", name: "Alice", role: "member" });
    store.createWorkspaceMember({ workspaceId: "local", userId: "bob", name: "Bob", role: "member" });
    const aliceToken = await store.createAccessToken({ name: "Alice", type: "pat", workspaceId: "local", userId: "alice" });
    const bobToken = await store.createAccessToken({ name: "Bob", type: "pat", workspaceId: "local", userId: "bob" });
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const jsonHeaders = (token: string) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

    // Alice seeds her default agent (per-owner) and stores a secret on it.
    const seeded = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(seeded.status).toBe(201);
    const aliceAgent = (await seeded.json()).agent;
    expect(aliceAgent.ownerId).toBe("alice");
    store.updateAgent(aliceAgent.id, { customEnv: { SECRET_TOKEN: "s3cret-value" } });

    // Bob's provider-only call resolves to HIS own default agent — a distinct
    // id owned by bob — never alice's, so her custom_env can't leak.
    const bobSeed = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(bobToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(bobSeed.status).toBe(201);
    const bobBody = await bobSeed.json();
    expect(bobBody.agent.id).not.toBe(aliceAgent.id);
    expect(bobBody.agent.ownerId).toBe("bob");
    expect(JSON.stringify(bobBody)).not.toContain("s3cret-value");

    // Each keeps resolving to their own default agent on repeat calls.
    const aliceAgain = await app.request("/api/multiremi/agents/default", {
      method: "POST",
      headers: jsonHeaders(aliceToken.token),
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(aliceAgain.status).toBe(200);
    expect((await aliceAgain.json()).agent.id).toBe(aliceAgent.id);
  });
});
