import { afterEach, describe, expect, it } from "bun:test";
import { BinarySkillFilesUnsupportedError } from "@multiremi/store/repos/tasks-repo.js";
import { createLocalStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const metadata = { runtime_workspaces: 1, codex_profiles: 1, agent_plugin_protocol: 1,
  parallel_agent_execution: 1, cli_version: "0.2.75" };

function fixture(options: { frozen?: boolean; workspace?: boolean; issue?: boolean } = {}) {
  const store = createLocalStore();
  const runtime = store.registerRuntime({ id: "wait-source", name: "Source", provider: "codex",
    daemonId: "wait-host", workspaceId: "local", metadata, maxConcurrency: 4 });
  if (options.frozen) store.setRuntimeCodexProfile(runtime.id, {
    name: "retained", base_url: "https://retained.example/v1", model: "retained-model",
    auth_mode: "env", env_key: "REMI_CODEX_RETAINED_KEY",
  });
  const workspace = options.workspace ? store.runtimeWorkspaces.create(runtime.id,
    { name: "Files", root_path: "/test/wait-files" }) : null;
  const agent = store.createAgent({ name: "Worker", provider: "codex", maxConcurrentTasks: 4 });
  const issue = options.issue ? store.createIssue({ title: "Capability wait" }) : null;
  let task = store.createTask({ agentId: agent.id, issueId: issue?.id, runtimeWorkspaceId: workspace?.id,
    prompt: "Use the original execution requirements", maxAttempts: 2 });
  if (options.frozen) {
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    store.failTask(task.id, { error: "lost worker", failureReason: "runtime_recovery" });
    task = store.listTasks().find(candidate => candidate.parentTaskId === task.id)!;
    expect(task.codexProfile).not.toBeNull();
  }
  const now = Date.now() + 180_000;
  const setMetadata = (next: Record<string, unknown>) => store.registerRuntime({
    id: runtime.id, name: runtime.name, provider: "codex", daemonId: runtime.daemonId!, workspaceId: "local", metadata: next,
  });
  return { store, runtime, workspace, agent, issue, task, now, setMetadata };
}

function expectObservableWait(f: ReturnType<typeof fixture>) {
  expect(f.store.claimTask(f.runtime.id)).toBeNull();
  f.store.refreshQueuedCapabilityWaitReasons(f.now);
  expect(f.store.getTask(f.task.id)).toMatchObject({ status: "queued", waitReason: expect.any(String) });
  expect(f.store.getTask(f.task.id)!.waitReason!.length).toBeGreaterThan(0);
  const reason = f.store.getTask(f.task.id)!.waitReason;
  f.store.refreshQueuedCapabilityWaitReasons(f.now + 60_000);
  expect(f.store.getTask(f.task.id)?.waitReason).toBe(reason);
}

function expectRecovery(f: ReturnType<typeof fixture>) {
  f.store.refreshQueuedCapabilityWaitReasons(f.now + 120_000);
  expect(f.store.getTask(f.task.id)?.waitReason).toBeNull();
  const claimed = f.store.claimTask(f.runtime.id)!;
  expect(claimed).toMatchObject({ id: f.task.id, status: "dispatched", waitReason: null });
  expect(claimed.codexProfile).toEqual(f.task.codexProfile);
  expect(claimed.runtimeWorkspaceId).toBe(f.task.runtimeWorkspaceId);
}

describe("queued capability waits agree with task claim eligibility", () => {
  for (const frozen of [false, true]) {
    for (const restriction of ["protocol", "archived", "daemon", "workspace"] as const) {
      it(`${frozen ? "frozen retry" : "new task"}: observes and recovers a Runtime workspace ${restriction} restriction`, () => {
        const f = fixture({ frozen, workspace: true });
        const workspace = f.workspace!;
        // Archive and tenant changes are guarded by the public API. Model a
        // historical/corrupt row so that read-side authorization remains safe.
        if (restriction === "protocol") f.setMetadata({ ...metadata, runtime_workspaces: 0 });
        if (restriction === "archived") db!.run("UPDATE multiremi_runtime_workspaces SET archived_at = ? WHERE id = ?", [new Date().toISOString(), workspace.id]);
        if (restriction === "daemon") db!.run("UPDATE multiremi_runtime_workspaces SET daemon_id = ? WHERE id = ?", ["other-host", workspace.id]);
        if (restriction === "workspace") {
          const foreign = f.store.createWorkspace({ name: "Foreign", slug: "foreign-wait" });
          db!.run("UPDATE multiremi_runtime_workspaces SET workspace_id = ? WHERE id = ?", [foreign.id, workspace.id]);
        }
        expectObservableWait(f);
        f.setMetadata(metadata);
        db!.run("UPDATE multiremi_runtime_workspaces SET archived_at = NULL, daemon_id = ?, workspace_id = ? WHERE id = ?",
          [f.runtime.daemonId!, "local", workspace.id]);
        expectRecovery(f);
      });
    }

    for (const protocol of ["issue_workspace", "parallel_execution"] as const) {
      it(`${frozen ? "frozen retry" : "new task"}: observes and recovers ${protocol} downgrade`, () => {
        const f = fixture({ frozen, issue: true });
        f.setMetadata(protocol === "issue_workspace" ? { ...metadata, cli_version: "0.2.25" }
          : { ...metadata, parallel_agent_execution: 0 });
        expectObservableWait(f);
        f.setMetadata(metadata);
        expectRecovery(f);
      });
    }
  }

  it("does not share a workspace eligibility result with an unbound task for the same Agent", () => {
    const f = fixture({ workspace: true });
    const free = f.store.createTask({ agentId: f.agent.id, prompt: "No directory binding" });
    f.setMetadata({ ...metadata, runtime_workspaces: 0 });
    f.store.refreshQueuedCapabilityWaitReasons(f.now);
    expect(f.store.getTask(f.task.id)?.waitReason).toEqual(expect.any(String));
    expect(f.store.getTask(free.id)?.waitReason).toBeNull();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(free.id);
  });

  it("reclaims stale workspace dispatch safely and observes the same downgraded protocol", () => {
    const f = fixture({ frozen: true, workspace: true });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(f.task.id);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?",
      [new Date(Date.now() - 120_000).toISOString(), f.task.id]);
    f.setMetadata({ ...metadata, runtime_workspaces: 0 });
    expectObservableWait(f);
    f.setMetadata(metadata);
    expectRecovery(f);
  });

  it("escalates a structural wait once, keeps later sweeps idempotent, and clears it on recovery", () => {
    const f = fixture({ workspace: true });
    f.setMetadata({ ...metadata, runtime_workspaces: 0 });
    expect(f.store.refreshQueuedCapabilityWaitReasons(f.now)).toEqual({ updated: 1, alerted: 0 });
    const escalatedAt = f.now + 15 * 60_000;
    expect(f.store.refreshQueuedCapabilityWaitReasons(escalatedAt)).toEqual({ updated: 1, alerted: 1 });
    const escalated = f.store.getTask(f.task.id)!;
    expect(escalated.waitReason).toContain("runtime_workspaces");
    expect(escalated.waitReason).toContain("15 分钟");
    for (const elapsed of [60_000, 120_000, 600_000]) {
      expect(f.store.refreshQueuedCapabilityWaitReasons(escalatedAt + elapsed)).toEqual({ updated: 0, alerted: 0 });
      expect(f.store.getTask(f.task.id)?.updatedAt).toBe(escalated.updatedAt);
    }
    expect(f.store.listAnalyticsEvents({ name: "task_queued_capability_timeout" })).toHaveLength(1);
    f.setMetadata(metadata);
    expect(f.store.refreshQueuedCapabilityWaitReasons(escalatedAt + 660_000)).toEqual({ updated: 1, alerted: 0 });
    expect(f.store.getTask(f.task.id)?.waitReason).toBeNull();
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(f.task.id);
  });

  for (const provider of ["codex", "claude"] as const) {
    it(`observes a live ${provider} connection protocol downgrade before the first frozen snapshot`, () => {
      const store = createLocalStore();
      const runtime = store.registerRuntime({ name: "Live connection", provider, metadata: { [`${provider}_profiles`]: 1 } });
      const profile = { name: "live", base_url: "https://live.example/v1", model: "live-model", auth_mode: "env" as const,
        env_key: provider === "codex" ? "REMI_CODEX_LIVE_KEY" : "REMI_CLAUDE_LIVE_KEY" };
      if (provider === "codex") store.setRuntimeCodexProfile(runtime.id, profile);
      else store.setRuntimeClaudeProfile(runtime.id, profile);
      const agent = store.createAgent({ name: "First task", provider });
      const task = store.createTask({ agentId: agent.id, prompt: "Use the configured connection" });
      expect(task.executionFingerprint).toBeNull();
      store.registerRuntime({ id: runtime.id, name: runtime.name, provider, metadata: { [`${provider}_profiles`]: 0 } });
      expect(store.claimTask(runtime.id)).toBeNull();
      store.refreshQueuedCapabilityWaitReasons(Date.now() + 180_000);
      expect(store.getTask(task.id)?.waitReason).toContain(`${provider}_profiles`);
      expect(store.getTask(task.id)?.executionFingerprint).toBeNull();
      store.registerRuntime({ id: runtime.id, name: runtime.name, provider, metadata: { [`${provider}_profiles`]: 1 } });
      store.refreshQueuedCapabilityWaitReasons(Date.now() + 240_000);
      expect(store.getTask(task.id)?.waitReason).toBeNull();
      const claimed = store.claimTask(runtime.id)!;
      expect(claimed.id).toBe(task.id);
      expect(provider === "codex" ? claimed.codexProfile : claimed.claudeProfile).toMatchObject(profile);
    });
  }

  for (const reason of ["Waiting for manual approval", "等待目录锁：/test/wait-files", "Another subsystem owns this queue reason"]) {
    it(`preserves another subsystem's reason during failure and recovery: ${reason}`, () => {
      const f = fixture({ frozen: true, workspace: true });
      db!.run("UPDATE multiremi_tasks SET wait_reason = ? WHERE id = ?", [reason, f.task.id]);
      f.setMetadata({ ...metadata, runtime_workspaces: 0 });
      f.store.refreshQueuedCapabilityWaitReasons(f.now);
      expect(f.store.getTask(f.task.id)?.waitReason).toBe(reason);
      f.setMetadata(metadata);
      f.store.refreshQueuedCapabilityWaitReasons(f.now + 60_000);
      expect(f.store.getTask(f.task.id)?.waitReason).toBe(reason);
    });
  }

  for (const frozen of [false, true]) {
    for (const failure of ["protocol", "state", "digest"] as const) {
      it(`${frozen ? "frozen plugin snapshot" : "current plugin binding"}: observes and recovers ${failure}`, () => {
        const f = fixture({ issue: true });
        const plugin = f.store.importAgentPlugin({ provider: "codex", manifest: { name: "capability-wait", version: "1.0.0" },
          files: [{ path: "skills/capability-wait/SKILL.md", content: "# Test capability" }] });
        f.store.createAgentPluginBinding(f.agent.id, { pluginId: plugin.id });
        const ready = () => {
          const desired = f.store.getRuntimeAgentPluginDesiredSnapshot(f.runtime.id).plugins.find(entry => entry.versionId === plugin.activeVersionId)!;
          f.store.reportAgentPluginRuntimeState(f.runtime.id, plugin.activeVersionId!, {
            status: "ready", observedDigest: plugin.activeVersion!.artifactDigest, retryGeneration: desired.retryGeneration,
          });
        };
        ready();
        if (frozen) {
          expect(f.store.claimTask(f.runtime.id)?.id).toBe(f.task.id);
          f.store.startTask(f.task.id);
          f.store.failTask(f.task.id, { error: "worker lost", failureReason: "runtime_recovery" });
          const parentId = f.task.id;
          f.task = f.store.listTasks().find(task => task.parentTaskId === parentId)!;
          expect(f.task.pluginSnapshot).toHaveLength(1);
        }
        if (failure === "protocol") f.store.heartbeatRuntime(f.runtime.id, { agentPluginProtocol: 0 });
        if (failure === "state") db!.run("UPDATE multiremi_agent_plugin_runtime_states SET status = 'blocked' WHERE runtime_id = ?", [f.runtime.id]);
        if (failure === "digest") db!.run("UPDATE multiremi_agent_plugin_runtime_states SET observed_digest = ? WHERE runtime_id = ?", ["wrong-digest", f.runtime.id]);
        expectObservableWait(f);
        f.store.heartbeatRuntime(f.runtime.id, { agentPluginProtocol: 1 });
        ready();
        expectRecovery(f);
      });
    }
  }

  it("observes loss of the immutable code snapshot host and recovers on the same daemon", () => {
    const f = fixture({ issue: true });
    f.store.cancelTask(f.task.id);
    const source = f.store.registerRuntime({ id: "code-source", name: "Code writer", provider: "claude", daemonId: f.runtime.daemonId! });
    const parent = f.store.getOrCreateDefaultIssueSession(f.issue!.id);
    f.store.getOrCreateSessionAgentLane(parent.id, f.agent.id);
    db!.run("UPDATE multiremi_session_agent_lanes SET runtime_id = ? WHERE session_id = ?", [source.id, parent.id]);
    const side = f.store.createIssueSession(f.issue!.id, { parentSessionId: parent.id, withCode: true });
    f.task = f.store.createSessionTask(side.id, { agentId: f.agent.id, prompt: "Read the retained code snapshot" });
    expect(f.store.deleteRuntime(source.id)).toBe(true);
    expectObservableWait(f);
    f.store.registerRuntime({ id: source.id, name: source.name, provider: "claude", daemonId: f.runtime.daemonId! });
    expectRecovery(f);
  });

  for (const stale of [false, true]) {
    it(`reports retained Issue workspace affinity for ${stale ? "stale dispatch" : "queued task"} and recovers on its daemon`, () => {
      const f = fixture({ issue: true });
      if (stale) {
        expect(f.store.claimTask(f.runtime.id)?.id).toBe(f.task.id);
        db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?",
          [new Date(Date.now() - 120_000).toISOString(), f.task.id]);
      }
      // A workspace can be reported after queuing. The existing task pin or
      // dispatch cannot make a different daemon own those persistent files.
      const host = f.store.registerRuntime({ name: "Files owner", provider: "claude", daemonId: "files-host" });
      f.store.reportIssueWorkspace({ issueId: f.issue!.id, runtimeId: host.id,
        rootPath: "/test/retained-issue", branchName: "agent/MUL-1", status: "ready", repos: [] });
      expectObservableWait(f);
      const replacement = f.store.registerRuntime({ name: "Codex on files host", provider: "codex", daemonId: "files-host", metadata });
      f.store.refreshQueuedCapabilityWaitReasons(f.now + 120_000);
      expect(f.store.getTask(f.task.id)?.waitReason).toBeNull();
      expect(f.store.claimTask(replacement.id)?.id).toBe(f.task.id);
    });
  }

  it("does not turn capacity and a live shared-directory lane into a capability failure", () => {
    const f = fixture({ workspace: true });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(f.task.id);
    f.store.startTask(f.task.id);
    const queued = f.store.createTask({ agentId: f.agent.id, runtimeWorkspaceId: f.workspace!.id, prompt: "Same directory" });
    expect(f.store.claimTask(f.runtime.id)).toBeNull();
    expect(f.store.getTaskQueueBlocker(queued.id)?.taskId).toBe(f.task.id);
    f.store.refreshQueuedCapabilityWaitReasons(f.now);
    expect(f.store.getTask(queued.id)?.waitReason).toBeNull();
    f.store.completeTask(f.task.id, { output: "Released directory" });
    expect(f.store.claimTask(f.runtime.id)?.id).toBe(queued.id);
  });

  for (const context of ["issue", "chat"] as const) {
    for (const restriction of ["project_devices", "dedicated"] as const) {
      it(`${context}: observes and recovers ${restriction} routing rejection`, () => {
        const f = fixture();
        f.store.cancelTask(f.task.id);
        const project = f.store.createProject({ title: "Device routing" });
        f.store.registerRuntime({ name: "Different provider", provider: "claude", daemonId: "other-project-device" });
        if (context === "issue") {
          const issue = f.store.createIssue({ title: "Project files", projectId: project.id });
          f.task = f.store.createTask({ agentId: f.agent.id, issueId: issue.id, prompt: "Use project files" });
        } else {
          const chat = f.store.createChatSession({ agentId: f.agent.id, projectId: project.id });
          f.task = f.store.sendChatMessage(chat.id, { body: "Use project files" }).task;
        }
        if (restriction === "project_devices") f.store.createProjectDevice(project.id, { daemonId: "other-project-device" });
        else f.store.updateDaemonDedicated("local", f.runtime.daemonId!, true, "local");
        expectObservableWait(f);
        f.store.createProjectDevice(project.id, { daemonId: f.runtime.daemonId! });
        expectRecovery(f);
      });
    }
  }

  it("keeps binary Skill compatibility as an explicit per-request error, allowing an upgraded caller", () => {
    const f = fixture();
    const skill = f.store.createSkill({ name: "Image", content: "# Image",
      files: [{ path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" }] });
    f.store.setAgentSkills(f.agent.id, [skill.id!]);
    expect(() => f.store.claimTask(f.runtime.id, { supportsBinarySkillFiles: false })).toThrow(BinarySkillFilesUnsupportedError);
    f.store.refreshQueuedCapabilityWaitReasons(f.now);
    expect(f.store.getTask(f.task.id)).toMatchObject({ status: "queued", waitReason: null });
    expect(f.store.claimTask(f.runtime.id, { supportsBinarySkillFiles: true })?.id).toBe(f.task.id);
  });
});
