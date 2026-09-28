// MUL-74: outbox delivery is at-least-once, so every daemon report endpoint
// must tolerate replays. Terminal replays must not re-trigger side effects
// (issue comments, activities, follow-up tasks); message/usage replays must
// not duplicate rows.
import { afterEach, describe, expect, it } from "bun:test";
import { createMultiremiApp } from "@multiremi/api.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";
import { reportFrame, reportTraceSink } from "../../fixtures/report-session.js";

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

    const complete = () => reportFrame(store, "task.complete", {
      task_id: task.id, output: "最终结论:一切正常。", session_id: "sess-1", work_dir: "/tmp/w",
    });
    const first = await complete();
    expect(first).toEqual({ ok: true });
    expect(store.getTask(task.id)?.status).toBe("completed");
    const commentsAfterFirst = store.listIssueComments(issue.id).length;
    const activitiesAfterFirst = store.listIssueActivity(issue.id).filter((a) => a.type === "task_completed").length;
    const tasksAfterFirst = store.listTasks().length;
    expect(commentsAfterFirst).toBe(1);
    expect(activitiesAfterFirst).toBe(1);

    // Replay the exact same terminal event (outbox retry after a lost ack).
    const second = await complete();
    expect(second).toEqual({ ok: true });
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(store.listIssueComments(issue.id).length).toBe(commentsAfterFirst);
    expect(store.listIssueActivity(issue.id).filter((a) => a.type === "task_completed").length).toBe(activitiesAfterFirst);
    expect(store.listTasks().length).toBe(tasksAfterFirst);

    // A late fail replay after completion must not flip the status or spawn retries.
    const failReplay = await reportFrame(store, "task.fail", { task_id: task.id, error: "late duplicate failure" });
    expect(failReplay).toEqual({ ok: true });
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(store.listTasks().length).toBe(tasksAfterFirst);
  });

  it("absorbs replayed trace batches and merges replayed usage without duplicates", async () => {
    const store = createStore();
    const app = createMultiremiApp({ store, authToken: "master-secret" });
    const runtime = store.registerRuntime({ id: "rt_replay_msg", name: "replay-msg", provider: "claude", workspaceId: "local" });
    const agent = store.createAgent({ name: "Replay Msg Bot", provider: "claude", runtimeId: runtime.id });
    const task = store.createTask({ agentId: agent.id, workspaceId: "local", prompt: "x" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    const batch = {
      task_id: task.id, closed: false,
      events: [
        { seq: 1, ts: "2026-09-28T00:00:00Z", type: "text", content: "hello " },
        { seq: 2, ts: "2026-09-28T00:00:00Z", type: "text", content: "world" },
      ],
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await reportFrame(store, "trace.append", batch);
      expect(response).toEqual({ ok: true, hub_head: 2 });
    }
    const messages: Array<{ seq: number; content?: string | null }> = [];
    const sub = reportTraceSink(store).subscribe(task.id, 0, (_id, events) => messages.push(...events));
    sub.unsubscribe();
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => [m.seq, m.content])).toEqual([[1, "hello "], [2, "world"]]);
    expect(store.listTaskMessages(task.id)).toEqual([]);

    const usage = { usage: [{ provider: "claude", model: "m1", input_tokens: 10, output_tokens: 5, total_tokens: 15 }] };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await reportFrame(store, "task.usage", { task_id: task.id, ...usage });
      expect(response).toEqual({ ok: true });
    }
    expect(store.getTask(task.id)?.usage).toHaveLength(1);
    expect(store.getTask(task.id)?.usage[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });

    // Prompt replay: recorded once, immutable after.
    const prompt = "do the thing";
    const sha256 = new Bun.CryptoHasher("sha256").update(prompt).digest("hex");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await reportFrame(store, "task.prompt", { task_id: task.id, mode: "bootstrap", prompt, sha256 });
      expect(response).toEqual({ ok: true });
    }
    expect(store.getTaskPrompt(task.id)?.prompt).toBe(prompt);
  });
});
