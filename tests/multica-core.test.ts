import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createMulticaApp } from "../src/multica/api.js";
import { MulticaStore } from "../src/multica/store.js";

let db: Database | null = null;

function createStore(): MulticaStore {
  db = new Database(":memory:");
  return new MulticaStore(db);
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("Bun Multica core store", () => {
  it("claims queued tasks by runtime provider and completes them", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Codex", provider: "codex" });
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
    expect(store.listTaskMessages(codexTask.id)).toHaveLength(2);
    expect(store.getTask(codexTask.id)?.usage[0].inputTokens).toBe(10);
  });

  it("recovers dispatched and running tasks for a runtime", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "Run" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });

    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);
    expect(store.recoverOrphans(runtime.id)).toBe(1);

    const recovered = store.getTask(task.id);
    expect(recovered?.status).toBe("queued");
    expect(recovered?.runtimeId).toBeNull();
  });

  it("creates projects, squads, and autopilot runs", () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const project = store.createProject({ title: "Launch", priority: "high" });
    const squad = store.createSquad({
      name: "Core squad",
      leaderId: agent.id,
      memberIds: [agent.id],
    });
    const autopilot = store.createAutopilot({
      title: "Triage regressions",
      projectId: project.id,
      assigneeType: "squad",
      assigneeId: squad.id,
      issueTitleTemplate: "Investigate nightly regression",
    });

    const run = store.runAutopilot(autopilot.id);
    expect(run.status).toBe("running");
    expect(run.issueId).toBeString();
    expect(run.taskId).toBeString();

    const task = store.getTask(run.taskId!);
    expect(task?.agentId).toBe(agent.id);
    expect(task?.prompt).toBe("Investigate nightly regression");

    const updatedProject = store.getProject(project.id);
    expect(updatedProject?.issueCount).toBe(1);
    expect(store.listSquadMembers(squad.id)).toHaveLength(1);
    expect(store.listAutopilotRuns(autopilot.id)[0]?.id).toBe(run.id);
  });
});

describe("Bun Multica API", () => {
  it("serves daemon claim/start/complete endpoints", async () => {
    const store = createStore();
    const agent = store.createAgent({ name: "Claude", provider: "claude" });
    const task = store.createTask({ agentId: agent.id, prompt: "hello" });
    const runtime = store.registerRuntime({ name: "local", provider: "claude" });
    const app = createMulticaApp({ store });

    const claim = await app.request(`/api/daemon/runtimes/${runtime.id}/tasks/claim`, { method: "POST" });
    expect(claim.status).toBe(200);
    expect((await claim.json()).task.id).toBe(task.id);

    const start = await app.request(`/api/daemon/tasks/${task.id}/start`, { method: "POST" });
    expect(start.status).toBe(200);

    const complete = await app.request(`/api/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output: "ok" }),
    });
    expect(complete.status).toBe(200);
    expect((await complete.json()).task.status).toBe("completed");

    const status = await app.request(`/api/daemon/tasks/${task.id}/status`);
    expect((await status.json()).status).toBe("completed");
  });
});
