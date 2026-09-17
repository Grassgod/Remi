import { afterEach, describe, expect, it } from "bun:test";
import { daemonRuntimeId } from "@multiremi/store.js";
import { createLocalStore as createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

describe("Chat Project routing after dispatch and Runtime changes", () => {
  for (const restriction of ["dedicated", "project_devices"] as const) {
    it(`rechecks ${restriction} when a Chat dispatch response is retried`, () => {
      const store = createStore();
      const first = store.registerRuntime({ name: "First", provider: "codex", daemonId: "chat-first" });
      const second = store.registerRuntime({ name: "Second", provider: "codex", daemonId: "chat-second" });
      const project = store.createProject({ title: "Chat routing" });
      store.createProjectDevice(project.id, { daemonId: "chat-first" });
      if (restriction === "dedicated") store.updateDaemonDedicated("local", "chat-first", true, "local");
      const agent = store.createAgent({ name: "Chat", provider: "codex" });
      const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
      const task = store.sendChatMessage(chat.id, { body: "Use the selected device" }).task;
      expect(store.claimTask(first.id)?.id).toBe(task.id);
      db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);

      // Simulate a lost claim response followed by a routing settings change.
      store.deleteProjectDevice(project.id, "chat-first");
      if (restriction === "project_devices") store.createProjectDevice(project.id, { daemonId: "chat-second" });

      expect(store.claimTask(first.id)).toBeNull();
      expect(store.getTask(task.id)).toMatchObject({ status: "queued", runtimeId: null, sessionId: null });
      expect(store.claimTask(second.id)?.id).toBe(task.id);
    });
  }

  it("keeps directory Chat on its daemon when the same Runtime ID changes provider", () => {
    const store = createStore();
    const directory = store.registerRuntime({ id: "rt_chat_directory", name: "Directory", provider: "codex", daemonId: "chat-directory" });
    const other = store.registerRuntime({ name: "Other", provider: "codex", daemonId: "chat-other" });
    const project = store.createProject({ title: "Local project", resources: [{ resourceType: "local_directory",
      resourceRef: { local_path: "/abs/chat-directory", daemon_id: "chat-directory" } }] });
    const agent = store.createAgent({ name: "Chat", provider: "codex" });
    const chat = store.createChatSession({ agentId: agent.id, projectId: project.id });
    const first = store.sendChatMessage(chat.id, { body: "First turn" }).task;
    expect(store.claimTask(directory.id)?.id).toBe(first.id);
    store.startTask(first.id);
    store.completeTask(first.id, { output: "Done", sessionId: "old-native-session", workDir: "/abs/chat-directory" });
    const next = store.sendChatMessage(chat.id, { body: "Continue" }).task;
    expect(next).toMatchObject({ runtimeId: directory.id, sessionId: "old-native-session" });

    store.registerRuntime({ id: directory.id, name: "Directory", provider: "claude", daemonId: "chat-directory" });

    const replacementId = daemonRuntimeId("chat-directory", "codex");
    expect(store.getTask(next.id)).toMatchObject({ status: "queued", runtimeId: replacementId, sessionId: null });
    expect(store.claimTask(directory.id)).toBeNull();
    expect(store.claimTask(other.id)).toBeNull();
    store.registerRuntime({ id: replacementId, name: "Directory Codex", provider: "codex", daemonId: "chat-directory" });
    const claimed = store.claimTask(replacementId);
    expect(claimed).toMatchObject({ id: next.id, runtimeId: replacementId, sessionId: null, chatProjectId: project.id });
    expect(claimed?.projectResources).toMatchObject([{ resourceType: "local_directory",
      resourceRef: { local_path: "/abs/chat-directory", daemon_id: "chat-directory" } }]);
  });
});
