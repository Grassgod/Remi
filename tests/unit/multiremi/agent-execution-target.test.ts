import { afterEach, describe, expect, it } from "bun:test";
import { createStore, db, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function fixture() {
  const store = createStore();
  const first = store.registerRuntime({ name: "First", provider: "codex", daemonId: "first", maxConcurrency: 4 });
  const second = store.registerRuntime({ name: "Second", provider: "codex", daemonId: "second", maxConcurrency: 4 });
  const agent = store.createAgent({ name: "Bound", provider: "codex", runtimeId: first.id });
  return { store, first, second, agent };
}

describe("Agent execution target", () => {
  it("keeps an offline target queued instead of using another machine", () => {
    const { store, first, second, agent } = fixture();
    store.setRuntimeOffline(first.id);
    const task = store.createTask({ agentId: agent.id, prompt: "Target-only model" });
    expect(store.runtimeCanRunAgent(second, agent)).toBe(false);
    expect(store.claimTask(second.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.claimTask(first.id)?.id).toBe(task.id);
  });

  it("moves queued Chat work without resuming the previous machine's session", () => {
    const { store, first, second, agent } = fixture();
    const chat = store.createChatSession({ agentId: agent.id });
    const initial = store.sendChatMessage(chat.id, { body: "First turn" }).task;
    expect(store.claimTask(first.id)?.id).toBe(initial.id);
    store.startTask(initial.id);
    store.completeTask(initial.id, { output: "Done", sessionId: "first-native-session", workDir: "/first/work" });
    const queued = store.sendChatMessage(chat.id, { body: "Next turn" }).task;
    expect(queued).toMatchObject({ runtimeId: first.id, sessionId: "first-native-session", workDir: "/first/work" });
    store.updateAgent(agent.id, { runtimeId: second.id });
    expect(store.getTask(queued.id)).toMatchObject({ runtimeId: null, sessionId: null, workDir: null });
    expect(store.claimTask(first.id)).toBeNull();
    const claimed = store.claimTask(second.id)!;
    expect(claimed.id).toBe(queued.id);
    expect(claimed.sessionId).toBeNull();
    expect(claimed.workDir).toBeNull();
  });

  it("cancels frozen unstarted work when the target changes and leaves running work intact", () => {
    const { store, first, second, agent } = fixture();
    const running = store.createTask({ agentId: agent.id, prompt: "Running" });
    store.claimTask(first.id);
    store.startTask(running.id);
    const pending = store.createTask({ agentId: agent.id, prompt: "Dispatched" });
    expect(store.claimTask(first.id)?.id).toBe(pending.id);
    store.updateAgent(agent.id, { runtimeId: second.id });
    expect(store.getTask(pending.id)?.status).toBe("cancelled");
    expect(store.getTask(running.id)?.status).toBe("running");
    expect(store.claimTask(first.id)).toBeNull();
  });

  it("rechecks execution targets before returning a stale dispatch", () => {
    const { store, first, second, agent } = fixture();
    const task = store.createTask({ agentId: agent.id, prompt: "Lost response" });
    store.claimTask(first.id);
    db!.run("UPDATE multiremi_agents SET runtime_id = ?, execution_group_id = ? WHERE id = ?", [second.id, second.executionGroupIds![0], agent.id]);
    db!.run("UPDATE multiremi_tasks SET dispatched_at = ? WHERE id = ?", ["2000-01-01T00:00:00.000Z", task.id]);
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
    expect(store.claimTask(second.id)?.id).toBe(task.id);
  });

  it("intersects target selection with local directory and project device constraints", () => {
    const { store, first, second, agent } = fixture();
    const localProject = store.createProject({
      title: "Local files",
      resources: [{ resourceType: "local_directory", resourceRef: { local_path: "/first/files", daemon_id: first.daemonId! } }],
    });
    const localIssue = store.createIssue({ title: "Local issue", projectId: localProject.id });
    const local = store.createTask({ agentId: agent.id, issueId: localIssue.id, prompt: "Local" });
    const project = store.createProject({ title: "First project" });
    store.createProjectDevice(project.id, { daemonId: first.daemonId! });
    const issue = store.createIssue({ title: "Bound issue", projectId: project.id });
    const projectTask = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "Project" });
    store.updateAgent(agent.id, { runtimeId: second.id });
    expect(store.claimTask(first.id)).toBeNull();
    expect(store.claimTask(second.id)).toBeNull();
    expect(store.getTask(local.id)).toMatchObject({ status: "queued", runtimeId: first.id });
    expect(store.getTask(projectTask.id)?.status).toBe("queued");
  });

  it("allows metadata edits after the selected Runtime becomes private without releasing its target", () => {
    const { store, second } = fixture();
    const shared = store.registerRuntime({ name: "Shared", provider: "codex", visibility: "public", ownerId: "other" });
    const agent = store.createAgent({ name: "Shared target", provider: "codex", runtimeId: shared.id });
    const task = store.createTask({ agentId: agent.id, prompt: "Requires selected machine" });
    store.updateRuntime(shared.id, { visibility: "private" });
    const renamed = store.updateAgent(agent.id, { name: "Renamed", provider: agent.provider });
    expect(renamed).toMatchObject({ name: "Renamed", runtimeId: shared.id });
    expect(store.claimTask(shared.id)).toBeNull();
    expect(store.claimTask(second.id)).toBeNull();
    expect(store.getTask(task.id)?.status).toBe("queued");
  });

  it("validates provider and owner and prevents deletion from silently removing the target", () => {
    const { store, first, agent } = fixture();
    const claude = store.registerRuntime({ name: "Claude", provider: "claude" });
    const privateRuntime = store.registerRuntime({ name: "Other owner", provider: "codex", ownerId: "other" });
    expect(() => store.updateAgent(agent.id, { runtimeId: claude.id })).toThrow("provider");
    expect(() => store.updateAgent(agent.id, { runtimeId: privateRuntime.id })).toThrow("owner");
    expect(() => store.createAgent({ name: "Invalid", provider: "claude", runtimeId: first.id })).toThrow("provider");
    store.registerRuntime({ name: "First Claude", daemonId: first.daemonId!, provider: "claude" });
    expect(store.deleteRuntime(first.id)).toBe(false);
    expect(store.getAgent(agent.id)?.runtimeId).toBe(first.id);
  });
});
