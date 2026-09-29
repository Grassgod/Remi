import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { TaskSteerPendingError } from "@multiremi/store/repos/tasks-repo.js";
import { buildSteerInjectionPrompt, mergeTaskUsageEntries, TaskSteerFeed } from "@multiremi/worker/steer.js";
import type { MultiremiTaskSteerMessage } from "@multiremi/contracts/types.js";
import { createStore, resetMultiremiTestEnv } from "./helpers.js";
import { openRuntimeDownlinks } from "../../fixtures/runtime-downlinks.js";
import { reportFrame } from "../../fixtures/report-session.js";

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

  it("steer barrier: completeTask refuses while unconsumed steers exist, and steer-after-complete conflicts", () => {
    const store = createStore();
    const task = createRunningTask(store);

    // Steer committed first → completion must not strand it.
    const message = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "change direction" });
    expect(() => store.completeTask(task.id, { output: "old answer" })).toThrow(TaskSteerPendingError);
    expect(store.getTaskStatus(task.id)).toBe("running");

    // Once the daemon consumed it, completion goes through.
    store.consumeTaskSteerMessages(task.id, [message.id]);
    expect(store.completeTask(task.id, { output: "steered answer" }).status).toBe("completed");

    // Completion committed first → the steer insert must conflict (API maps this to 409).
    expect(() => store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "too late" }))
      .toThrow(/already completed/);
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

    // The steer barrier blocks completion until the daemon consumed them.
    store.consumeTaskSteerMessages(task.id, store.listPendingTaskSteerMessages(task.id).map((m) => m.id));
    store.completeTask(task.id, { output: "done" });
    const late = await app.request(`/api/tasks/${task.id}/steer`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ content: "too late" }),
    });
    expect(late.status).toBe(409);
    expect((await late.json()).error).toMatch(/already completed/);
  });

  it("returns 409 when the task completes while the steer body is still streaming in", async () => {
    const store = createStore();
    const task = createRunningTask(store);
    const app = createMultiremiApp({ store, authToken: "root-secret" });

    // The route caches the task before reading the body; completing the task
    // from inside the body stream reproduces the parse-window race exactly.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        store.completeTask(task.id, { output: "finished first" });
        controller.enqueue(encoder.encode(JSON.stringify({ content: "raced steer" })));
        controller.close();
      },
    });
    const raced = await app.request(`/api/tasks/${task.id}/steer`, {
      method: "POST",
      headers: { Authorization: "Bearer root-secret", "Content-Type": "application/json" },
      body,
      // @ts-expect-error Bun supports half-duplex streaming request bodies
      duplex: "half",
    });
    expect(raced.status).toBe(409);
    expect((await raced.json()).error).toMatch(/already completed/);
    expect(store.listTaskSteerMessages(task.id)).toHaveLength(0);
  });

  it("daemon complete returns non-retryable steer_pending while unconsumed steers exist", async () => {
    const store = createStore();
    const task = createRunningTask(store);
    const app = createMultiremiApp({ store, authToken: "root-secret" });
    const auth = { Authorization: "Bearer root-secret", "Content-Type": "application/json" };

    const message = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "pending" });
    const refused = await reportFrame(store, "task.complete", { task_id: task.id, output: "old answer" });
    expect(refused).toEqual({ ok: false, code: "steer_pending", retryable: false });
    expect(store.getTaskStatus(task.id)).toBe("running");

    const connection = await openRuntimeDownlinks(store, task.runtimeId!);
    try {
      expect(await connection.rpc("steer.consume", { task_id: task.id, steer_ids: [message.id] }))
        .toMatchObject({ ok: true });
    } finally { await connection.close(); }
    const completed = await reportFrame(store, "task.complete", { task_id: task.id, output: "steered answer" });
    expect(completed).toEqual({ ok: true });
    expect(store.getTaskStatus(task.id)).toBe("completed");
  });

  it("serves pending steers to the daemon and marks them consumed", async () => {
    const store = createStore();
    const task = createRunningTask(store);
    const message = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "switch" });
    const connection = await openRuntimeDownlinks(store, task.runtimeId!);
    try {
      expect(connection.frames.filter(frame => frame.t === "task.steer").map(frame => frame.p.steer))
        .toEqual([expect.objectContaining({ id: message.id })]);
      const consume = await connection.rpc("steer.consume", { task_id: task.id, steer_ids: [message.id] });
      expect(consume.ok).toBe(true);
      expect(consume.consumed).toEqual([expect.objectContaining({ id: message.id })]);
      connection.frames.length = 0;
      await connection.kick();
      expect(connection.frames.filter(frame => frame.t === "task.steer")).toHaveLength(0);
      expect(store.listPendingTaskSteerMessages(task.id)).toHaveLength(0);
    } finally { await connection.close(); }
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

  const pushSource = (initial: MultiremiTaskSteerMessage[] = []) => {
    const listeners = new Set<(message: MultiremiTaskSteerMessage) => void>();
    return {
      pendingTaskSteerMessages: () => initial,
      subscribeTaskSteerMessages: (_taskId: string, listener: (message: MultiremiTaskSteerMessage) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
      push: (message: MultiremiTaskSteerMessage) => { for (const listener of listeners) listener(message); },
    };
  };

  it("markHandled immunizes the feed against a replayed push of the same steer", () => {
    const source = pushSource();
    const feed = new TaskSteerFeed(source, "tsk_feed");
    feed.start();
    feed.markHandled(["s1"]);
    let interrupted = 0;
    feed.setInterrupt(() => { interrupted += 1; });
    source.push(steerMessage({ id: "s1", content: "already handled" }));
    expect(feed.hasPending).toBe(false);
    expect(interrupted).toBe(0);
    feed.stop();
  });

  it("markHandled drops already-queued duplicates so setInterrupt does not fire on stale ids", () => {
    const source = pushSource([steerMessage({ id: "s1", content: "queued first" })]);
    const feed = new TaskSteerFeed(source, "tsk_feed");
    feed.start();
    expect(feed.hasPending).toBe(true);

    feed.markHandled(["s1"]);
    expect(feed.hasPending).toBe(false);
    let interrupted = 0;
    feed.setInterrupt(() => { interrupted += 1; });
    expect(interrupted).toBe(0);
    feed.stop();
  });

  it("feed interrupts a streaming turn when a steer arrives and drains in order", () => {
    const source = pushSource();
    const feed = new TaskSteerFeed(source, "tsk_feed");
    let interrupted = 0;
    feed.setInterrupt(() => { interrupted += 1; });
    feed.start();
    try {
      source.push(steerMessage({ id: "s1", content: "first" }));
      expect(interrupted).toBe(1);
      expect(feed.take().map((m) => m.id)).toEqual(["s1"]);

      source.push(steerMessage({ id: "s1", content: "first" }));
      expect(feed.hasPending).toBe(false);

      // A steer that arrived between turns fires the next interrupt immediately.
      source.push(steerMessage({ id: "s1", content: "first" }));
      source.push(steerMessage({ id: "s2", content: "second" }));
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
