// MUL-74: outbox delivery is at-least-once, so every daemon report endpoint
// must tolerate replays. Terminal replays must not re-trigger side effects
// (issue comments, activities, follow-up tasks); message/usage replays must
// not duplicate rows.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

const HEADERS = { "Content-Type": "application/json", Authorization: "Bearer master-secret" };

describe("daemon report replay idempotency", () => {
  it("does not duplicate comments, activities, or follow-up tasks on complete/fail replays", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "master-secret" });
    const runtime = store.registerRuntime({ id: "rt_replay", name: "replay", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Replay Bot", provider: "claude", runtimeId: runtime.id });
    const issue = store.createIssue({ title: "Replay", workspaceId: "local" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, workspaceId: "local", prompt: "x" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    const complete = () => app.request(`/api/daemon/tasks/${task.id}/complete`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ output: "最终结论:一切正常。", session_id: "sess-1", work_dir: "/tmp/w" }),
    });
    const first = await complete();
    expect(first.status).toBe(200);
    expect(store.getTask(task.id)?.status).toBe("completed");
    const commentsAfterFirst = store.listIssueComments(issue.id).length;
    const activitiesAfterFirst = store.listIssueActivity(issue.id).filter((a) => a.type === "task_completed").length;
    const tasksAfterFirst = store.listTasks().length;
    expect(commentsAfterFirst).toBe(1);
    expect(activitiesAfterFirst).toBe(1);

    // Replay the exact same terminal event (outbox retry after a lost ack).
    const second = await complete();
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe("completed");
    expect(store.listIssueComments(issue.id).length).toBe(commentsAfterFirst);
    expect(store.listIssueActivity(issue.id).filter((a) => a.type === "task_completed").length).toBe(activitiesAfterFirst);
    expect(store.listTasks().length).toBe(tasksAfterFirst);

    // A late fail replay after completion must not flip the status or spawn retries.
    const failReplay = await app.request(`/api/daemon/tasks/${task.id}/fail`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ error: "late duplicate failure" }),
    });
    expect(failReplay.status).toBe(200);
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(store.listTasks().length).toBe(tasksAfterFirst);
  });

  it("upserts replayed message batches and merges replayed usage without duplicates", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "master-secret" });
    const runtime = store.registerRuntime({ id: "rt_replay_msg", name: "replay-msg", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Replay Msg Bot", provider: "claude", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "x" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    const batch = {
      messages: [
        { seq: 1, type: "text", content: "hello " },
        { seq: 2, type: "text", content: "world" },
      ],
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.request(`/api/daemon/tasks/${task.id}/messages`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(batch),
      });
      expect(response.status).toBe(200);
    }
    const messages = store.listTaskMessages(task.id);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => [m.seq, m.content])).toEqual([[1, "hello "], [2, "world"]]);

    const usage = { usage: [{ provider: "claude", model: "m1", input_tokens: 10, output_tokens: 5, total_tokens: 15 }] };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(`/api/daemon/tasks/${task.id}/usage`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(usage),
      });
      expect(response.status).toBe(200);
    }
    expect(store.getTask(task.id)?.usage).toHaveLength(1);
    expect(store.getTask(task.id)?.usage[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });

    // Prompt replay: recorded once, immutable after.
    const prompt = "do the thing";
    const sha256 = new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.request(`/api/daemon/tasks/${task.id}/prompt`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify({ mode: "bootstrap", prompt, sha256 }),
      });
      expect(response.status).toBe(200);
    }
    expect(store.getTaskPrompt(task.id)?.prompt).toBe(prompt);
  });
});
