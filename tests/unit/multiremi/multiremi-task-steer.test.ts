import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { buildSteerInjectionPrompt, mergeTaskUsageEntries, TaskSteerFeed } from "@multiremi/worker/steer.js";
import type { MultiremiTaskSteerMessage } from "@multiremi/contracts/types.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";

afterEach(resetMultiremiTestEnv);

function createRunningTask(store: MultiremiStore): MultiremiTask {
  const agent = store.createAgent({ name: "Steer Agent", provider: "claude" });
  const task = store.createTask({ agentId: agent.id, prompt: "test" });
  store.registerRuntime({ id: "rt_steer", name: "steer-runtime", provider: "claude", workspaceId: "local", ownerId: "local" });
  const claimed = store.claimTask("rt_steer");
  expect(claimed?.id).toBe(task.id);
  return store.startTask(task.id);
}

describe("task steer messages (store)", () => {
  it("records a steer for a live task and lists it as pending", () => {
    const store = createStore();
    const task = createRunningTask(store);

    const message = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "改用中文输出" });
    expect(message.kind).toBe("steer");
    expect(message.content).toBe("改用中文输出");
    expect(message.consumedAt).toBeNull();

    expect(store.listPendingTaskSteerMessages(task.id).map((m) => m.id)).toEqual([message.id]);
    expect(store.listTaskSteerMessages(task.id)).toHaveLength(1);
    // Steering must not change the task lifecycle.
    expect(store.getTaskStatus(task.id)).toBe("running");
  });

  it("consume is idempotent and clears pending", () => {
    const store = createStore();
    const task = createRunningTask(store);
    const a = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "first" });
    const b = store.createTaskSteerMessage({ taskId: task.id, kind: "force_answer", content: "second" });

    const consumed = store.consumeTaskSteerMessages(task.id, [a.id, b.id]);
    expect(consumed.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(consumed.every((m) => m.consumedAt)).toBe(true);
    expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
    // Second consume finds nothing new.
    expect(store.consumeTaskSteerMessages(task.id, [a.id, b.id])).toHaveLength(0);
  });

  it("rejects steers for terminal tasks and empty content", () => {
    const store = createStore();
    const task = createRunningTask(store);
    expect(() => store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "   " })).toThrow(/empty/);

    store.completeTask(task.id, { output: "done" });
    expect(() => store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "late" }))
      .toThrow(/already completed/);
    expect(() => store.createTaskSteerMessage({ taskId: "tsk_missing", kind: "steer", content: "x" }))
      .toThrow(/not found/);
  });

  it("appends an auditable session event for issue-session tasks", () => {
    const store = createStore();
    const runtime = store.registerRuntime({ id: "rt_steer_evt", name: "steer-evt", provider: "claude", workspaceId: "local", ownerId: "local" });
    const agent = store.createAgent({ name: "Steer Session Agent", provider: "claude" });
    const issue = store.createIssue({ title: "Steer audit" });
    const task = store.createTask({ agentId: agent.id, issueId: issue.id, prompt: "work" });
    expect(store.claimTask(runtime.id)?.id).toBe(task.id);
    store.startTask(task.id);

    const sessionId = store.getTask(task.id)?.issueSessionId;
    expect(sessionId).toBeTruthy();
    const message = store.createTaskSteerMessage({
      taskId: task.id,
      kind: "force_answer",
      content: "先给结论",
      authorType: "user",
      authorId: "local",
    });

    const events = store.listSessionEvents(sessionId!);
    const steerEvent = events.find((event) => event.kind === "task_steer");
    expect(steerEvent).toBeTruthy();
    expect(steerEvent?.body).toBe("先给结论");
    expect(steerEvent?.taskId).toBe(task.id);
    expect(steerEvent?.metadata).toMatchObject({ steer_id: message.id, steer_kind: "force_answer" });
  });
});

describe("task steer API", () => {
  it("accepts steer + force answer for live tasks, rejects terminal tasks", async () => {
    const store = createStore();
    const task = createRunningTask(store);
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const auth = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };

    const created = await app.request(`/api/tasks/${task.id}/steer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "改用中文输出" }),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.message).toMatchObject({ kind: "steer", content: "改用中文输出" });

    // force_answer without content falls back to the default wrap-up directive.
    const forced = await app.request(`/api/multiremi/tasks/${task.id}/steer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ force_answer: true }),
    });
    expect(forced.status).toBe(201);
    expect((await forced.json()).message.kind).toBe("force_answer");

    // Plain steer without content is a client error.
    const empty = await app.request(`/api/tasks/${task.id}/steer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const listed = await app.request(`/api/tasks/${task.id}/steer`, { headers: auth });
    expect(listed.status).toBe(200);
    expect((await listed.json()).messages).toHaveLength(2);

    store.completeTask(task.id, { output: "done" });
    const late = await app.request(`/api/tasks/${task.id}/steer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "too late" }),
    });
    expect(late.status).toBe(409);
    expect((await late.json()).error).toMatch(/already completed/);
  });

  it("serves pending steers to the daemon and marks them consumed", async () => {
    const store = createStore();
    const task = createRunningTask(store);
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const auth = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };

    const message = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "switch" });

    const pending = await app.request(`/api/daemon/tasks/${task.id}/steer`, { headers: auth });
    expect(pending.status).toBe(200);
    expect((await pending.json()).messages).toEqual([expect.objectContaining({ id: message.id })]);

    const consume = await app.request(`/api/daemon/tasks/${task.id}/steer/consume`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ ids: [message.id] }),
    });
    expect(consume.status).toBe(200);
    expect((await consume.json()).consumed).toEqual([expect.objectContaining({ id: message.id })]);

    const drained = await app.request(`/api/daemon/tasks/${task.id}/steer`, { headers: auth });
    expect((await drained.json()).messages).toHaveLength(0);
  });
});

describe("steer worker helpers", () => {
  const steerMessage = (overrides: Partial<MultiremiTaskSteerMessage>): MultiremiTaskSteerMessage => ({
    id: "steer_x",
    taskId: "tsk_x",
    authorType: "user",
    authorId: null,
    kind: "steer",
    content: "",
    createdAt: new Date().toISOString(),
    consumedAt: null,
    ...overrides,
  });

  it("builds an injection prompt that carries user directives", () => {
    const prompt = buildSteerInjectionPrompt([
      steerMessage({ id: "s1", content: "改用中文输出" }),
      steerMessage({ id: "s2", kind: "force_answer", content: "先给结论" }),
    ]);
    expect(prompt).toContain("改用中文输出");
    expect(prompt).toContain("先给结论");
    expect(prompt).toContain("Stop exploring");
    expect(prompt).toContain("finish");
  });

  it("continuation wording only appears without force answer", () => {
    const prompt = buildSteerInjectionPrompt([steerMessage({ id: "s1", content: "keep going differently" })]);
    expect(prompt).toContain("continue the task");
    expect(prompt).not.toContain("Deliver now");
  });

  it("sums usage across turns per provider+model", () => {
    const total = mergeTaskUsageEntries(
      [{ provider: "claude", model: "m1", inputTokens: 10, outputTokens: 5, totalTokens: 15 }],
      [
        { provider: "claude", model: "m1", inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        { provider: "claude", model: "m2", inputTokens: 1, outputTokens: 1 },
      ],
    );
    expect(total).toEqual([
      expect.objectContaining({ model: "m1", inputTokens: 13, outputTokens: 7, totalTokens: 20 }),
      expect.objectContaining({ model: "m2", inputTokens: 1, outputTokens: 1 }),
    ]);
  });

  it("feed interrupts a streaming turn when a steer arrives and drains in order", async () => {
    let batch: MultiremiTaskSteerMessage[] = [];
    const feed = new TaskSteerFeed(
      { listPendingTaskSteerMessages: async () => batch },
      "tsk_feed",
      250,
    );
    let interrupted = 0;
    feed.setInterrupt(() => { interrupted += 1; });
    feed.start();
    try {
      batch = [steerMessage({ id: "s1", content: "first" })];
      await Bun.sleep(400);
      expect(interrupted).toBe(1);
      expect(feed.take().map((m) => m.id)).toEqual(["s1"]);

      // Same rows still pending server-side are not re-queued.
      await Bun.sleep(300);
      expect(feed.hasPending).toBe(false);

      // A steer that arrived between turns fires the next interrupt immediately.
      batch = [steerMessage({ id: "s1", content: "first" }), steerMessage({ id: "s2", content: "second" })];
      await Bun.sleep(400);
      expect(feed.hasPending).toBe(true);
      let lateInterrupt = 0;
      feed.setInterrupt(() => { lateInterrupt += 1; });
      expect(lateInterrupt).toBe(1);
      expect(feed.take().map((m) => m.id)).toEqual(["s2"]);
    } finally {
      feed.stop();
    }
  });
});
