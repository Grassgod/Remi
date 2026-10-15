import { describe, expect, it } from "bun:test";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import type { FeishuPresentationCheckpoint, MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import { agentMessage, command, completed, item, started, streamedText, turnCompleted, turnStarted,
  updated } from "./feishu-native-harness.js";

const credentials = { appId: "cli_test", appSecret: "test-secret" };
function harness(failSend = false) {
  const sends: any[] = [];
  const patches: any[] = [];
  const native: any[] = [];
  const reply = async (input: any) => {
    sends.push(input);
    return failSend ? { code: 230028, msg: "send refused", data: { message_id: "" } } : { code: 0, data: { message_id: `om_${sends.length}` } };
  };
  const client = { request: async (input: any) => { native.push(input); return { code: 0, data: { cot_id: "cot_1", message_id: "om_cot" } }; }, im: { message: {
    reply, create: reply,
    patch: async (input: any) => { patches.push(JSON.parse(input.data.content)); return { code: 0 }; },
  } } };
  const channel = new FeishuChannel(credentials);
  (channel as any)._makeClient = () => client;
  return { channel, sends, patches, native, nativeEvents: () => native.flatMap(request => request.data?.events ?? []) };
}

const bash = command("toolu_git", "git status", undefined, { output: "clean" });
const answer = agentMessage("msg:answer", "Work complete", "final");
async function* events(onLive?: () => Promise<void>): AsyncGenerator<TaskStreamEvent> {
  yield turnStarted(1);
  yield started(2, { ...bash, command: null, actions: [] });
  yield updated(3, bash);
  yield completed(4, bash);
  if (onLive) await onLive();
  yield* streamedText(5, agentMessage("msg:answer", "Work complete"));
  yield completed(8, answer);
  yield turnCompleted(9, [bash, answer]);
  yield { kind: "snapshot", snapshot: { taskId: "tsk_1", status: "completed", result: "Work complete",
    sessionId: "provider_1", workDir: "/tmp/chat", error: null, usage: [] } };
}
const meta = { taskId: "tsk_1", displayName: "Remi" };
const question = item("question", "q:hr_live", { message_id: "hr_live", message: "Continue?",
  questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] });
function request(status: MultiremiTaskHumanRequest["status"]): MultiremiTaskHumanRequest {
  return { id: "hr_live", taskId: "tsk_1", kind: "question", status, payload: { questions: question.questions },
    response: status === "responded" ? { answers: { "Continue?": "Yes" } } : null, respondedBy: null,
    createdAt: "2026-10-15T00:00:00.000Z", respondedAt: null };
}

describe("durable proactive Task deliveries", () => {
  it("skips already settled human requests when replaying a completed task", async () => {
    const h = harness();
    const reads: string[] = [];
    const settled = item("question", "q:hr_done", { message_id: "hr_done" });
    async function* replay() {
      yield started(1, settled);
      yield completed(2, settled);
      for await (const row of events()) if (row.kind !== "message" || row.message.seq > 1) yield row;
    }
    await h.channel.handleTaskStream("oc_group", "topic", replay(), { ...meta,
      getHumanRequest: async id => { reads.push(id); return { ...request("responded"), id }; } },
    { durable: { idempotencyKey: "delivery_1" } });
    expect(reads).toEqual(["hr_done"]);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].data.content).toContain("Work complete");
  });

  it("stops a pending human-request card when its delivery is interrupted", async () => {
    const h = harness();
    const abort = new AbortController();
    async function* pending() { yield turnStarted(1); yield started(2, question); }
    const running = h.channel.handleTaskStream("oc_group", "topic", pending(), { ...meta, signal: abort.signal,
      getHumanRequest: async () => request("pending") }, { durable: { idempotencyKey: "delivery_1" } });
    for (let i = 0; i < 40 && !h.sends.length; i++) await Bun.sleep(5);
    expect(h.sends).toHaveLength(1);
    abort.abort(new Error("handover"));
    await expect(running).rejects.toThrow("handover");
    expect(h.sends).toHaveLength(1);
  });

  it("continues after a human request is answered outside Feishu", async () => {
    const h = harness();
    let reads = 0;
    async function* answered() {
      yield turnStarted(1);
      yield started(2, question);
      yield completed(3, { ...question, answers: { "Continue?": "Yes" } });
      for await (const row of events()) if (row.kind !== "message" || row.message.seq > 3) yield row;
    }
    await h.channel.handleTaskStream("oc_group", "topic", answered(), { ...meta,
      getHumanRequest: async () => request(++reads === 1 ? "pending" : "responded") }, { durable: { idempotencyKey: "delivery_1" } });
    expect(reads).toBeGreaterThan(1);
    expect(h.patches).toHaveLength(1);
    expect(h.sends.at(-1).data.content).toContain("Work complete");
  });

  it("shows a finished tool before the turn ends and writes it once", async () => {
    const h = harness();
    const checkpoints: FeishuPresentationCheckpoint[] = [];
    const result = await h.channel.handleTaskStream("oc_group", "topic", events(async () => {
      for (let i = 0; i < 400 && !h.native.some(r => r.method === "PUT"); i++) await Bun.sleep(5);
      expect(JSON.stringify(h.native)).toContain("已运行 git status");
      expect(JSON.stringify(h.native)).not.toContain("RUN_FINISHED");
      expect(h.sends).toHaveLength(0);
    }), meta, { replyToMessageId: "om_root", durable: { idempotencyKey: "delivery_1" },
      onCheckpoint: async state => { checkpoints.push(state); } });
    expect(result.messageId).toBe("om_1");
    expect(checkpoints.at(-1)).toMatchObject({ version: "native_cot_v1", resultMessageId: "om_1", cot: { status: "finished" } });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].data).toMatchObject({ msg_type: "interactive", reply_in_thread: true });
    expect(h.sends[0].data.uuid).toBeTruthy();
    const final = h.sends[0].data.content;
    expect(final).toContain("Work complete");
    expect(final).toContain("1 tools");
    expect(JSON.stringify(h.native)).toContain("$ git status");
    expect(JSON.stringify(h.native)).not.toContain("clean");
    expect(h.nativeEvents().filter((e: any) => e.event_type === "TOOL_CALL_START")).toHaveLength(1);
  });

  it("finishes a delivery whose legacy streaming card was already sent with the result card only", async () => {
    // R10: a protocol-v4 delivery holds the streaming card's message ID but no
    // presentation checkpoint. No native process opens; the result follows and
    // the old card is closed once so its progress spinner does not stay.
    const h = harness();
    const checkpoints: FeishuPresentationCheckpoint[] = [];
    const patched: string[] = [];
    const patch = (h.channel as any)._makeClient().im.message.patch;
    (h.channel as any)._makeClient().im.message.patch = async (input: any) => { patched.push(input.path.message_id); return patch(input); };
    const result = await h.channel.handleTaskStream("oc_group", "topic", events(), meta, {
      replyToMessageId: "om_root", durable: { idempotencyKey: "delivery_1", messageId: "om_legacy_card" },
      onCheckpoint: async state => { checkpoints.push(structuredClone(state)); } });
    expect(h.native).toEqual([]);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].data.content).toContain("Work complete");
    expect(result).toEqual({ messageId: "om_1" });
    expect(patched).toEqual(["om_legacy_card"]);
    expect(JSON.stringify(h.patches[0])).toContain("执行过程已结束，结果见下一条消息。");
    expect(JSON.stringify(h.patches[0])).not.toContain("Work complete");
    const saved = checkpoints.at(-1)!;
    expect(saved).toMatchObject({ resultMessageId: "om_1", cot: { status: "disabled", error: "legacy_card_closed" } });
    // A retry carries the saved checkpoint: it stays final-only and sends or patches nothing.
    await h.channel.handleTaskStream("oc_group", "topic", events(), meta, {
      durable: { idempotencyKey: "delivery_1", messageId: "om_legacy_card", presentation: saved } });
    expect(h.native).toEqual([]);
    expect(h.sends).toHaveLength(1);
    expect(patched).toHaveLength(1);
  });

  it("closes the legacy card on a retry when the result was sent but the card was not yet closed", async () => {
    const h = harness();
    const checkpoint: FeishuPresentationCheckpoint = { version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactions: {},
      resultMessageId: "om_result", cot: { status: "disabled", error: "legacy_card_final_only" } };
    const saved: FeishuPresentationCheckpoint[] = [];
    await h.channel.handleTaskStream("oc_group", "topic", events(), meta, {
      durable: { idempotencyKey: "delivery_1", messageId: "om_legacy_card", presentation: checkpoint },
      onCheckpoint: async state => { saved.push(state); } });
    expect(h.sends).toHaveLength(0);
    expect(h.patches).toHaveLength(1);
    expect(saved.at(-1)?.cot).toMatchObject({ error: "legacy_card_closed" });
  });

  it("still finishes a legacy delivery when its old card can no longer be patched", async () => {
    const h = harness();
    (h.channel as any)._makeClient().im.message.patch = async () => ({ code: 230031, msg: "card expired" });
    const logs: string[] = [];
    await expect(h.channel.handleTaskStream("oc_group", "topic", events(), meta, {
      durable: { idempotencyKey: "delivery_1", messageId: "om_legacy_card" },
      log: { info: () => {}, warn: message => logs.push(message), error: () => {}, debug: () => {} } })).resolves.toEqual({ messageId: "om_1" });
    expect(h.sends).toHaveLength(1);
    expect(logs).toEqual([expect.stringContaining("230031")]);
  });

  it("propagates a refused result card so the delivery can be retried or stopped", async () => {
    const h = harness(true);
    await expect(h.channel.handleTaskStream("oc_group", "topic", events(), meta,
      { durable: { idempotencyKey: "delivery_1", messageId: "om_legacy_card" } })).rejects.toMatchObject({ retryable: false });
  });

  it("does not send native messages when persisting the creation intent fails", async () => {
    const h = harness();
    let consumed = false;
    async function* stream() { consumed = true; yield* events(); }
    await expect(h.channel.handleTaskStream("oc_group", "topic", stream(), meta,
      { replyToMessageId: "om_root", durable: { idempotencyKey: "delivery_1" },
        onCheckpoint: async () => { throw new Error("lease lost"); } })).rejects.toThrow("lease lost");
    expect(consumed).toBe(true);
    expect(h.native).toHaveLength(0);
    expect(h.sends).toHaveLength(0);
    expect(h.patches).toHaveLength(0);
  });

  it("ends a stream that closes without a terminal snapshot as a failure", async () => {
    const h = harness();
    async function* cut() { yield turnStarted(1); }
    await expect(h.channel.handleTaskStream("oc_group", "topic", cut(), meta, { durable: { idempotencyKey: "delivery_1" } }))
      .rejects.toThrow("Task stream ended before a terminal snapshot");
    expect(h.sends).toHaveLength(0);
  });
});
