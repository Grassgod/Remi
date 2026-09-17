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

describe("Chat workspace assignment lineage", () => {
  for (const provider of ["codex", "claude"] as const) {
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
