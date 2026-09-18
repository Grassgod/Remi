import { afterEach, describe, expect, it } from "bun:test";
import { daemonTaskClaimResponse } from "@multiremi/api/wire/tasks.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  const previous = store.registerRuntime({ name: "Previous", provider: "codex", daemonId: "directory-owner" });
  const replacement = store.registerRuntime({ name: "Replacement", provider: "codex", daemonId: "new-directory-owner" });
  const agent = store.createAgent({ name: "Chat", provider: "codex" });
  const project = store.createProject({ title: "Project", resources: [{ resourceType: "local_directory",
    resourceRef: { daemon_id: "directory-owner", local_path: "/abs/user-project" } }] });
  const resource = store.listProjectResources(project.id)[0]!;
  const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
  const first = store.sendChatMessage(chat.id, { body: "First" }).task;
  store.claimTask(previous.id);
  store.startTask(first.id);
  store.completeTask(first.id, { output: "Done", sessionId: "old-provider", workDir: "/abs/user-project" });
  return { store, previous, replacement, agent, project, resource, chat };
}

function mutate(f: ReturnType<typeof fixture>, change: "delete" | "path" | "daemon") {
  if (change === "delete") f.store.deleteProjectResource(f.project.id, f.resource.id);
  else f.store.updateProjectResource(f.project.id, f.resource.id, { resourceRef: {
    daemon_id: change === "daemon" ? "new-directory-owner" : "directory-owner",
    local_path: change === "path" ? "/abs/replacement-project" : "/abs/user-project",
  } });
}

function multipleDirectoryFixture(includeThird = false) {
  const store = createStore();
  const previous = store.registerRuntime({ name: "A", provider: "codex", daemonId: "directory-a" });
  const replacement = store.registerRuntime({ name: "B", provider: "codex", daemonId: "directory-b" });
  const third = store.registerRuntime({ name: "C", provider: "codex", daemonId: "directory-c" });
  const agent = store.createAgent({ name: "Chat", provider: "codex" });
  const project = store.createProject({ title: "Several directories", resources: [
    { resourceType: "local_directory", position: 0, resourceRef: { daemon_id: "directory-a", local_path: "/abs/directory-a" } },
    { resourceType: "local_directory", position: 10, resourceRef: { daemon_id: "directory-b", local_path: "/abs/directory-b" } },
    ...(includeThird ? [{ resourceType: "local_directory", position: 20,
      resourceRef: { daemon_id: "directory-c", local_path: "/abs/directory-c" } }] : []),
  ] });
  const [selected, alternative, last] = store.listProjectResources(project.id);
  const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
  const first = store.sendChatMessage(chat.id, { body: "First" }).task;
  expect(first.runtimeId).toBe(previous.id);
  expect(store.claimTask(replacement.id)).toBeNull();
  expect(store.claimTask(previous.id)?.id).toBe(first.id);
  store.startTask(first.id);
  store.completeTask(first.id, { output: "A", sessionId: "provider-a", workDir: "/abs/directory-a" });
  return { store, previous, replacement, third, agent, project, chat, selected: selected!, alternative: alternative!, last };
}

type DirectoryFixture = ReturnType<typeof multipleDirectoryFixture>;
const selectedDirectoryChanges: Array<{ name: string; change: (f: DirectoryFixture) => string }> = [
  { name: "promote another directory by position", change: (f) => {
    f.store.updateProjectResource(f.project.id, f.alternative.id, { position: -1 });
    return f.replacement.id;
  } },
  { name: "demote the selected directory by position", change: (f) => {
    f.store.updateProjectResource(f.project.id, f.selected.id, { position: 11 });
    return f.replacement.id;
  } },
  { name: "promote an older alternative into an equal position", change: (f) => {
    // Establish the creation-time tie breaker without changing the initial winner.
    db!.run("UPDATE multiremi_project_resources SET created_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", f.alternative.id]);
    f.store.updateProjectResource(f.project.id, f.alternative.id, { position: 0 });
    return f.replacement.id;
  } },
  { name: "insert a new directory before the winner", change: (f) => {
    f.store.createProjectResource(f.project.id, { resourceType: "local_directory", position: -1,
      resourceRef: { daemon_id: "directory-c", local_path: "/abs/directory-c" } });
    return f.third.id;
  } },
  { name: "delete the selected directory", change: (f) => {
    f.store.deleteProjectResource(f.project.id, f.selected.id);
    return f.replacement.id;
  } },
  { name: "change the selected path", change: (f) => {
    f.store.updateProjectResource(f.project.id, f.selected.id, {
      resourceRef: { daemon_id: "directory-a", local_path: "/abs/replacement-a" },
    });
    return f.previous.id;
  } },
  { name: "change the selected daemon", change: (f) => {
    f.store.updateProjectResource(f.project.id, f.selected.id, {
      resourceRef: { daemon_id: "directory-c", local_path: "/abs/directory-a" },
    });
    return f.third.id;
  } },
];

describe("Chat selects one ordered local directory", () => {
  it("keeps fully tied directories and Chat lineage stable across query plans", () => {
    const store = createStore();
    const runtimeA = store.registerRuntime({ name: "A", provider: "codex", daemonId: "directory-a" });
    const runtimeB = store.registerRuntime({ name: "B", provider: "codex", daemonId: "directory-b" });
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const project = store.createProject({ title: "Tied directories", resources: [
      { resourceType: "local_directory", position: 0, resourceRef: { daemon_id: "directory-b", local_path: "/abs/directory-b" } },
      { resourceType: "local_directory", position: 1, resourceRef: { daemon_id: "directory-a", local_path: "/abs/directory-a" } },
    ] });
    // Insert B first, but give A the smaller ID and exactly equal sort fields.
    for (const resource of store.listProjectResources(project.id)) {
      const id = resource.resourceRef.daemon_id === "directory-a" ? "pres_tie_a" : "pres_tie_b";
      db!.run("UPDATE multiremi_project_resources SET id = ?, position = 0, created_at = ? WHERE id = ?",
        [id, "2026-01-01T00:00:00.000Z", resource.id]);
    }
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    let fingerprint: string | null = null;
    let completed = false;
    for (const direction of ["DESC", "ASC", "DESC"] as const) {
      // Only the access path changes; no resource data changes between queries.
      db!.run("DROP INDEX IF EXISTS tied_resource_order");
      db!.run(`CREATE INDEX tied_resource_order ON multiremi_project_resources
        (project_id, position, created_at, id ${direction}, workspace_id, resource_type, resource_ref, label)`);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect(store.listProjectResources(project.id).map((resource) => resource.id)).toEqual(["pres_tie_a", "pres_tie_b"]);
        const next = store.sendChatMessage(chat.id, { body: "Continue" }).task;
        expect(next.runtimeId).toBe(runtimeA.id);
        expect(store.claimTask(runtimeB.id)).toBeNull();
        const claimed = store.claimTask(runtimeA.id)!;
        expect(claimed).toMatchObject({ id: next.id, sessionId: completed ? "provider-a" : null,
          workDir: completed ? "/abs/directory-a" : null });
        if (completed) expect(claimed.executionFingerprint).toBe(fingerprint);
        store.startTask(next.id);
        store.completeTask(next.id, { output: "A", sessionId: "provider-a", workDir: "/abs/directory-a" });
        fingerprint = store.getChatSession(chat.id)!.sessionExecutionFingerprint;
        completed = true;
      }
    }
  });

  for (const { name, change } of selectedDirectoryChanges) {
    for (const timing of ["before_enqueue", "queued"] as const) {
      it(`retires the previous assignment once when resources ${name} (${timing})`, () => {
        const f = multipleDirectoryFixture();
        const queued = timing === "queued" ? f.store.sendChatMessage(f.chat.id, { body: "Queued" }).task : null;
        const selectedRuntimeId = change(f);
        const next = queued ?? f.store.sendChatMessage(f.chat.id, { body: "Continue" }).task;
        const claimed = f.store.claimTask(f.previous.id)!;
        expect(claimed).toMatchObject({ id: next.id, sessionId: null, workDir: null, chatProjectId: f.project.id });
        expect(claimed.project?.id).toBe(f.project.id);
        expect(claimed.projectResources.some((resource) => resource.resourceType === "local_directory")).toBe(false);
        expect(f.store.getChatSession(f.chat.id)).toMatchObject({ sessionId: null, workDir: null,
          sessionRuntimeId: null, sessionProvider: null, sessionExecutionFingerprint: null });
        f.store.startTask(next.id);
        const managedWorkDir = `/platform/workspaces/chats/${f.chat.id}`;
        f.store.completeTask(next.id, { output: "Managed", sessionId: "managed-provider", workDir: managedWorkDir });
        const third = f.store.sendChatMessage(f.chat.id, { body: "Resume" }).task;
        expect(third).toMatchObject({ sessionId: "managed-provider", workDir: managedWorkDir, runtimeId: f.previous.id });
        const resumed = f.store.claimTask(f.previous.id)!;
        expect(resumed).toMatchObject({ id: third.id, sessionId: "managed-provider", workDir: managedWorkDir });
        expect(resumed.projectResources.some((resource) => resource.resourceType === "local_directory")).toBe(false);
        f.store.startTask(third.id);
        f.store.completeTask(third.id, { output: "Resumed", sessionId: "managed-provider", workDir: managedWorkDir });

        // The replacement is still valid for a new Chat; only the old lineage retires.
        const fresh = f.store.createChatSession({ agentId: f.agent.id, projectId: f.project.id });
        const freshTask = f.store.sendChatMessage(fresh.id, { body: "Use the current assignment" }).task;
        expect(freshTask.runtimeId).toBe(selectedRuntimeId);
        expect(f.store.claimTask(selectedRuntimeId)?.id).toBe(freshTask.id);
      });
    }
  }

  const unchangedSelections: Array<{ name: string; third?: boolean; change: (f: DirectoryFixture) => void }> = [
    { name: "change an unselected path", change: (f) => { f.store.updateProjectResource(f.project.id, f.alternative.id,
      { resourceRef: { daemon_id: "directory-b", local_path: "/abs/other-b" } }); } },
    { name: "change an unselected daemon", change: (f) => { f.store.updateProjectResource(f.project.id, f.alternative.id,
      { resourceRef: { daemon_id: "directory-c", local_path: "/abs/directory-b" } }); } },
    { name: "delete an unselected directory", change: (f) => { f.store.deleteProjectResource(f.project.id, f.alternative.id); } },
    { name: "append an unselected directory", change: (f) => { f.store.createProjectResource(f.project.id,
      { resourceType: "local_directory", position: 20, resourceRef: { daemon_id: "directory-c", local_path: "/abs/directory-c" } }); } },
    { name: "rename the selected label", change: (f) => { f.store.updateProjectResource(f.project.id, f.selected.id, { label: "Renamed A" }); } },
    { name: "rename an unselected label", change: (f) => { f.store.updateProjectResource(f.project.id, f.alternative.id, { label: "Renamed B" }); } },
    { name: "move the selected position while keeping it first", change: (f) => { f.store.updateProjectResource(f.project.id, f.selected.id, { position: -1 }); } },
    { name: "tie a later-created alternative at the selected position", change: (f) => {
      db!.run("UPDATE multiremi_project_resources SET created_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", f.selected.id]);
      f.store.updateProjectResource(f.project.id, f.alternative.id, { position: 0 });
    } },
    { name: "reorder only unselected directories", third: true, change: (f) => {
      f.store.updateProjectResource(f.project.id, f.last!.id, { position: 5 });
    } },
  ];
  for (const { name, third, change } of unchangedSelections) {
    it(`preserves session lineage when resources ${name}`, () => {
      const f = multipleDirectoryFixture(third);
      const fingerprint = f.store.getChatSession(f.chat.id)!.sessionExecutionFingerprint;
      change(f);
      const next = f.store.sendChatMessage(f.chat.id, { body: "Keep working in A" }).task;
      expect(next).toMatchObject({ sessionId: "provider-a", workDir: "/abs/directory-a", runtimeId: f.previous.id });
      const claimed = f.store.claimTask(f.previous.id)!;
      expect(claimed).toMatchObject({ id: next.id, sessionId: "provider-a", workDir: "/abs/directory-a", executionFingerprint: fingerprint });
      expect(f.store.getChatSession(f.chat.id)?.sessionExecutionFingerprint).toBe(fingerprint);
    });
  }

  for (const lineage of ["legacy", "current"] as const) {
    it(`rejects a ${lineage} task on an unselected directory even though that daemon and path are Project members`, () => {
      const f = multipleDirectoryFixture();
      const next = f.store.sendChatMessage(f.chat.id, { body: "Continue" }).task;
      f.store.claimTask(f.previous.id);
      db!.run("UPDATE multiremi_tasks SET work_dir = ?, runtime_id = ? WHERE id = ?", [
        "/abs/directory-b", f.replacement.id, next.id,
      ]);
      if (lineage === "legacy") {
        db!.run("UPDATE multiremi_tasks SET execution_fingerprint = ? WHERE id = ?", ["legacy-plugin-hash", next.id]);
      }
      const hydrated = f.store.getTaskWithAgent(next.id)!;
      expect(hydrated).toMatchObject({ sessionId: null, workDir: null });
      expect(hydrated.projectResources.some((resource) => resource.resourceType === "local_directory")).toBe(false);
      expect(hydrated.project?.id).toBe(f.project.id);
    });
  }
});

describe("Chat workspace assignment lineage", () => {
  for (const provider of ["codex", "claude"] as const) {
    it(`checks the actual ${provider} model when a retry moves to a native Runtime`, () => {
      const store = createStore();
      const metadata = { codex_profiles: 1, claude_profiles: 1, agent_plugin_protocol: 1 };
      const previous = store.registerRuntime({ name: "Previous", provider, daemonId: "previous", metadata });
      const destination = store.registerRuntime({ name: "Native", provider, daemonId: "destination", metadata,
        models: [{ id: "selected-model", label: "Selected model", provider, default: false }] });
      const profile = { name: "previous", base_url: "http://127.0.0.1:8001/v1", model: "selected-model",
        env_key: provider === "codex" ? "REMI_CODEX_MODEL_TEST" : "REMI_CLAUDE_MODEL_TEST" };
      if (provider === "codex") store.setRuntimeCodexProfile(previous.id, profile);
      else store.setRuntimeClaudeProfile(previous.id, profile);
      const agent = store.createAgent({ name: "Chat", provider, model: "selected-model" });
      const project = store.createProject({ title: "Project" });
      store.createProjectDevice(project.id, { daemonId: "previous" });
      store.updateDaemonDedicated("local", "previous", true, "local");
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const first = store.sendChatMessage(chat.id, { body: "First" }).task;
      expect(store.claimTask(previous.id)?.id).toBe(first.id);
      store.startTask(first.id);
      store.failTask(first.id, { error: "Runtime unavailable", failureReason: "runtime_offline" });
      const retry = store.listTasks().find(task => task.parentTaskId === first.id)!;
      store.updateAgent(agent.id, { model: "later-selection" });
      store.archiveProject(project.id);
      expect(store.claimTask(destination.id)).toBeNull();
      expect(store.getTask(retry.id)?.status).toBe("queued");
      store.updateRuntimeModels(destination.id, [{ id: "later-selection", label: "Later selection", provider, default: false }]);
      const claimed = store.claimTask(destination.id)!;
      expect(claimed).toMatchObject({ id: retry.id, agent: { model: "later-selection" }, codexProfile: null, claudeProfile: null });
    });

    for (const priorProfile of [true, false]) {
      it(`keeps selected ${provider} models while a workspace transition replaces host credentials (prior profile: ${priorProfile})`, () => {
        const store = createStore();
        const metadata = { codex_profiles: 1, claude_profiles: 1, agent_plugin_protocol: 1 };
        const previous = store.registerRuntime({ name: "Previous", provider, daemonId: "previous", metadata });
        const destination = store.registerRuntime({ name: "Destination", provider, daemonId: "destination", metadata });
        const profile = { name: "previous", base_url: "http://127.0.0.1:8001/v1", model: "previous-default",
          env_key: provider === "codex" ? "REMI_CODEX_MODEL_TEST" : "REMI_CLAUDE_MODEL_TEST", auth_mode: "env" as const,
          ...(provider === "claude" ? { auth_header: "bearer" as const } : {}) };
        const nextProfile = { ...profile, name: "destination", base_url: "http://127.0.0.1:8002/v1", model: "destination-default" };
        if (provider === "codex") {
          if (priorProfile) store.setRuntimeCodexProfile(previous.id, profile);
          store.setRuntimeCodexProfile(destination.id, nextProfile);
        } else {
          if (priorProfile) store.setRuntimeClaudeProfile(previous.id, profile);
          store.setRuntimeClaudeProfile(destination.id, nextProfile);
        }
        const models = [{ id: "selected-model", label: "Selected model", provider, default: false }];
        store.updateRuntimeModels(previous.id, models, store.getRuntimeExecutionProfile(previous.id, provider));
        store.updateRuntimeModels(destination.id, models, store.getRuntimeExecutionProfile(destination.id, provider));
        const agent = store.createAgent({ name: "Chat", provider, model: "selected-model" });
        const project = store.createProject({ title: "Project" });
        store.createProjectDevice(project.id, { daemonId: "previous" });
        store.updateDaemonDedicated("local", "previous", true, "local");
        const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
        const first = store.sendChatMessage(chat.id, { body: "First" }).task;
        const initial = store.claimTask(previous.id)!;
        expect((initial.codexProfile ?? initial.claudeProfile)?.model ?? null).toBe(priorProfile ? "selected-model" : null);
        store.startTask(first.id);
        store.failTask(first.id, { error: "Runtime unavailable", failureReason: "runtime_offline",
          sessionId: "old-provider", workDir: "/abs/old" });
        const retry = store.listTasks().find((task) => task.parentTaskId === first.id)!;
        if (priorProfile) store.updateAgent(agent.id, { model: "later-selection" });
        store.archiveProject(project.id);
        const claimed = store.claimTask(destination.id)!;
        expect(claimed).toMatchObject({ id: retry.id, sessionId: null, workDir: null });
        expect(claimed.codexProfile ?? claimed.claudeProfile).toEqual({ ...nextProfile, model: "selected-model" });
      });
    }
  }

  for (const lineage of ["legacy", "current"] as const) {
    it(`retains the rejection decision while stripping a ${lineage} claim's inherited path`, () => {
      const f = fixture();
      const next = f.store.sendChatMessage(f.chat.id, { body: "Dispatch" }).task;
      const retained = f.store.claimTask(f.previous.id)!;
      if (lineage === "legacy") {
        db!.run("UPDATE multiremi_tasks SET execution_fingerprint = ? WHERE id = ?", ["legacy-plugin-hash", next.id]);
        mutate(f, "path");
      } else {
        db!.run("UPDATE multiremi_tasks SET work_dir = ? WHERE id = ?", ["/abs/unassigned-directory", next.id]);
      }
      const hydrated = f.store.getTaskWithAgent(next.id)!;
      expect(hydrated).toMatchObject({ sessionId: null, workDir: null });
      expect(hydrated.projectResources.some((r) => r.resourceType === "local_directory")).toBe(false);
      const wire = daemonTaskClaimResponse(f.store, retained);
      expect(wire).not.toHaveProperty("prior_work_dir");
      expect(wire).not.toHaveProperty("session_id");
      expect(wire.session_projection).toMatchObject({ mode: "bootstrap" });
    });
  }

  for (const change of ["delete", "path", "daemon"] as const) {
    for (const timing of ["before_enqueue", "queued"] as const) {
      it(`cold-starts once after ${change} (${timing}) and keeps the Project in managed mode`, () => {
        const f = fixture();
        const queued = timing === "queued" ? f.store.sendChatMessage(f.chat.id, { body: "Queued" }).task : null;
        mutate(f, change);
        const next = queued ?? f.store.sendChatMessage(f.chat.id, { body: "Continue" }).task;
        const claimed = f.store.claimTask(f.previous.id)!;
        expect(claimed).toMatchObject({ id: next.id, sessionId: null, workDir: null, chatProjectId: f.project.id });
        expect(claimed.project?.id).toBe(f.project.id);
        expect(claimed.projectResources.some((r) => r.resourceType === "local_directory")).toBe(false);
        expect(f.store.getChatSession(f.chat.id)).toMatchObject({ sessionId: null, workDir: null,
          sessionRuntimeId: null, sessionProvider: null, sessionExecutionFingerprint: null });
        f.store.startTask(next.id);
        const managedWorkDir = `/platform/workspaces/chats/${f.chat.id}`;
        f.store.completeTask(next.id, { output: "Managed", sessionId: "managed-provider", workDir: managedWorkDir });
        const third = f.store.sendChatMessage(f.chat.id, { body: "Resume" }).task;
        expect(third).toMatchObject({ sessionId: "managed-provider", workDir: managedWorkDir, runtimeId: f.previous.id });
        const resumed = f.store.claimTask(f.previous.id)!;
        expect(resumed).toMatchObject({ sessionId: "managed-provider", workDir: managedWorkDir });
        expect(resumed.projectResources.some((r) => r.resourceType === "local_directory")).toBe(false);
      });
    }

    it(`keeps active dispatch leases and rejects cached claims and late promotion after ${change}`, () => {
      const f = fixture();
      const next = f.store.sendChatMessage(f.chat.id, { body: "In flight" }).task;
      const retained = f.store.claimTask(f.previous.id)!;
      mutate(f, change);
      expect(f.store.claimTask(f.replacement.id)).toBeNull();
      expect(f.store.getTask(next.id)).toMatchObject({ status: "dispatched", runtimeId: f.previous.id,
        executionFingerprint: retained.executionFingerprint });
      const wire = daemonTaskClaimResponse(f.store, retained);
      expect(wire).not.toHaveProperty("session_id");
      expect(wire).not.toHaveProperty("prior_work_dir");
      expect(wire.session_projection).toMatchObject({ mode: "bootstrap" });
      expect((wire.project_resources as Array<{ resource_type: string }> | undefined)?.some((r) => r.resource_type === "local_directory") ?? false).toBe(false);
      f.store.startTask(next.id);
      f.store.completeTask(next.id, { output: "Late", sessionId: "late-provider", workDir: "/abs/user-project" });
      expect(f.store.getChatSession(f.chat.id)).toMatchObject({ sessionId: null, workDir: null, sessionExecutionFingerprint: null });
    });

    it(`reclaims a stale dispatch after ${change} without lending its old cwd`, () => {
      const f = fixture();
      const next = f.store.sendChatMessage(f.chat.id, { body: "Dispatch" }).task;
      const retained = f.store.claimTask(f.previous.id)!;
      mutate(f, change);
      db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", next.id]);
      const reclaimed = f.store.claimTask(f.replacement.id)!;
      expect(reclaimed).toMatchObject({ id: next.id, sessionId: null, workDir: null });
      expect(reclaimed.executionFingerprint).not.toBe(retained.executionFingerprint);
      expect(reclaimed.projectResources.some((r) => r.resourceType === "local_directory")).toBe(false);
      const wire = daemonTaskClaimResponse(f.store, retained);
      expect(wire).not.toHaveProperty("prior_work_dir");
      expect(wire).not.toHaveProperty("session_id");
    });
  }
});
