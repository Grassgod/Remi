import { attemptMessagesPath, requestMessageBody, sentTask } from "./unified-test-paths.js";
import { afterEach, describe, expect, it } from "bun:test";
import { MultiremiStore } from "@multiremi/store.js";
import type { MultiremiTask } from "@multiremi/contracts/types.js";
import { createMultiremiApp } from "@multiremi/api.js";
import { TaskSteerPendingError } from "@multiremi/store/repos/tasks-repo.js";
import { buildSteerInjectionPrompt, mergeTaskUsageEntries, TaskSteerFeed } from "@multiremi/worker/steer.js";
import type { MultiremiTaskSteerMessage } from "@multiremi/contracts/types.js";
import { createLocalStore as createStore, resetMultiremiTestEnv } from "./helpers.js";
import { openRuntimeDownlinks } from "../../fixtures/runtime-downlinks.js";
import { reportFrame } from "../../fixtures/report-session.js";

afterEach(resetMultiremiTestEnv);

function createRunningTask(store: MultiremiStore): MultiremiTask {
  const agent = store.createAgent({ name: "Steer Agent", provider: "claude" });
  const issue=store.createIssue({title:"Steer input"});
  const task = store.createTask({ agentId: agent.id, issueId:issue.id, prompt: "test" });
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
    const b = store.createTaskSteerMessage({ taskId: task.id, kind: "steer", content: "second" });

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
      .toThrow(/terminal/);
    expect(() => store.createTaskSteerMessage({ taskId: "tsk_missing", kind: "steer", content: "x" }))
      .toThrow(/not found/);
  });

  it("#3: completion keeps the interruption on the canonical message axis",()=>{
    const store=createStore(),task=createRunningTask(store);
    const message=store.createTaskSteerMessage({taskId:task.id,kind:"steer",content:"change direction"});
    expect(store.completeTask(task.id,{output:"old answer"}).status).toBe("completed");
    expect(store.getMessage(message.id)?.body_md).toBe(message.content);
    expect(store.getTurnForAttempt(task.id)?.status).toBe("completed");
  });

  it("#3/#9: force answer updates wrap-up state without appending a second steer record",()=>{
    const store=createStore(),task=createRunningTask(store);
    const turn=store.getTurnForAttempt(task.id)!;
    const before=store.listMessages(turn.session_id).map(message=>message.id);
    store.createTaskSteerMessage({taskId:task.id,kind:"force_answer",content:"先给结论"});
    expect(store.getTurn(turn.id)?.wrap_up_requested_at).not.toBeNull();
    expect(store.listMessages(turn.session_id).map(message=>message.id)).toEqual(before);
  });

});

describe("canonical interruption API",()=>{
  it("#3/#7/#9: running input interrupts; input after completion schedules another round",async()=>{
    const store=createStore(),task=createRunningTask(store),app=createMultiremiApp({store,authToken:"root-secret"});
    const headers={Authorization:"Bearer root-secret","Content-Type":"application/json"};
    const send=(body:string)=>app.request(attemptMessagesPath(store,task.id),{method:"POST",headers,body:JSON.stringify(requestMessageBody(store,{body_md:body},{type:"agent",ref:task.agentId}))});
    const response=await send("改用中文输出");
    expect(response.status).toBe(200);
    const data=await response.json();
    expect(data.message).toMatchObject({message_kind:"request",body_md:"改用中文输出",wake_applied:"now",to_agent_id:task.agentId});
    expect(data.turn_id).toBe(store.getTurnForAttempt(task.id)!.id);
    expect(store.getTask(task.id)?.status).toBe("running");
    expect((await send("   ")).status).toBe(400);
    store.consumeTaskSteerMessages(task.id,[data.message.id]);
    store.completeTask(task.id,{output:"done"});
    const late=await send("next round");
    expect(late.status).toBe(200);
    expect(sentTask(store,await late.json()).status).toBe("queued");
  });
});
// #3/#7: old steer RPC/barrier cases move to canonical message input and turn
// delivery confirmation. Dedicated retired-endpoint 410 tests remain separate.
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
