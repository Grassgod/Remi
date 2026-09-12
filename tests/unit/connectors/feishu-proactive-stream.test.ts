import { describe, expect, it } from "bun:test";
import { FeishuChannel } from "@connectors/feishu/channel.js";
import { FeishuStreamingSession } from "@connectors/feishu/streaming.js";
import type { TaskStreamEvent } from "@connectors/base.js";

const credentials = { appId: "cli_test", appSecret: "test-secret" };
function harness(failPatch = false) {
  const sends: any[] = [];
  const patches: any[] = [];
  const native: any[] = [];
  const client = { request: async (input: any) => { native.push(input); return { code: 0, data: { cot_id: "cot_1", message_id: "om_cot" } }; }, im: { message: {
    reply: async (input: any) => { sends.push(input); return { code: 0, data: { message_id: "om_card" } }; },
    patch: async (input: any) => { patches.push(JSON.parse(input.data.content)); return { code: failPatch ? 1 : 0, msg: "patch failure" }; },
  } } };
  const channel = new FeishuChannel(credentials);
  (channel as any)._makeClient = () => client;
  channel.createStream = () => new FeishuStreamingSession(client as any, credentials, { log: () => {} });
  return { channel, sends, patches, native };
}
function message(seq: number, type: string, patch: Record<string, unknown> = {}): TaskStreamEvent {
  return { kind: "message", message: { id: `msg_${seq}`, taskId: "tsk_1", seq, type, tool: null, content: null,
    input: null, output: null, toolCallId: null, status: null, meta: null, createdAt: "2026-09-01T00:00:00Z", ...patch } } as TaskStreamEvent;
}
async function* events(onLive?: () => Promise<void>): AsyncGenerator<TaskStreamEvent> {
  yield message(1, "tool_use", { tool: "Bash", toolCallId: "call_1" });
  yield message(2, "tool_use", { tool: "Bash", toolCallId: "call_1", input: { command: "git status", description: "检查 Git 状态" } });
  if (onLive) await onLive();
  yield message(3, "tool_result", { toolCallId: "call_1", output: "clean" });
  yield message(4, "text", { content: "Work complete" });
  yield { kind: "snapshot", snapshot: { taskId: "tsk_1", status: "completed", result: "Work complete",
    sessionId: "provider_1", workDir: "/tmp/chat", error: null, usage: [] } };
}
const meta = { taskId: "tsk_1", displayName: "Remi", respondHumanRequest: async () => { throw new Error("not expected"); } };

describe("durable proactive Task cards", () => {
  it("skips already settled human requests when replaying a completed task", async () => {
    const h = harness();
    const checked: string[] = [];
    async function* replay() {
      yield message(1, "question_request", { input: { request_id: "hr_done" } });
      yield* events();
    }
    await h.channel.handleTaskStream("oc_group", "topic", replay(), { ...meta,
      isHumanRequestPending: async id => { checked.push(id); return false; } },
      { durable: { idempotencyKey: "delivery_1", messageId: "om_card" } });
    expect(checked).toEqual(["hr_done"]);
    expect(JSON.stringify(h.patches.at(-1))).toContain("Work complete");
  });

  it("stops a pending human-request card when its delivery is interrupted", async () => {
    const h = harness();
    const abort = new AbortController();
    async function* question() {
      yield message(1, "question_request", { input: { request_id: "hr_live", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] } });
    }
    const running = h.channel.handleTaskStream("oc_group", "topic", question(), { ...meta, signal: abort.signal,
      isHumanRequestPending: async () => true }, { durable: { idempotencyKey: "delivery_1", messageId: "om_card" } });
    for (let i = 0; i < 20 && !h.patches.length; i++) await Bun.sleep(5);
    expect(h.patches.length).toBeGreaterThan(0);
    abort.abort(new Error("handover"));
    await expect(running).rejects.toThrow("handover");
  });

  it("continues after a human request is answered outside Feishu", async () => {
    const h = harness();
    let checks = 0;
    async function* question() {
      yield message(1, "question_request", { input: { request_id: "hr_live", questions: [{ question: "Continue?", options: [{ label: "Yes" }] }] } });
      yield* events();
    }
    await h.channel.handleTaskStream("oc_group", "topic", question(), { ...meta,
      isHumanRequestPending: async () => ++checks === 1 }, { durable: { idempotencyKey: "delivery_1", messageId: "om_card" } });
    expect(checks).toBeGreaterThan(1);
    expect(JSON.stringify(h.patches.at(-1))).toContain("Work complete");
  });

  it("shows live tools before completion and keeps one completed tool entry", async () => {
    const h = harness();
    const checkpoints: any[] = [];
    const result = await h.channel.handleTaskStream("oc_group", "topic", events(async () => {
      for (let i = 0; i < 400 && !h.native.some(r => r.method === "PUT"); i++) await Bun.sleep(5);
      expect(h.native.some(r => r.method === "PUT")).toBe(true);
      expect(JSON.stringify(h.native)).toContain("检查 Git 状态");
      expect(JSON.stringify(h.native)).not.toContain("RUN_FINISHED");
      expect(h.sends).toHaveLength(0);
    }), meta, { replyToMessageId: "om_root", durable: { idempotencyKey: "delivery_1" },
      onCheckpoint: async state => { checkpoints.push(state); } });
    expect(result.messageId).toBe("om_card");
    expect(checkpoints.at(-1)).toMatchObject({ version: "native_cot_v1", resultMessageId: "om_card" });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].data).toMatchObject({ msg_type: "interactive", reply_in_thread: true });
    expect(h.sends[0].data.uuid).toBeTruthy();
    const final = h.sends[0].data.content;
    expect(final).toContain("Work complete");
    expect(final).not.toContain("Show 1 steps");
    expect(JSON.stringify(h.native)).toContain("git status");
    expect(JSON.stringify(h.native)).not.toContain("clean");
    expect(h.native.flatMap(r => r.data.events ?? []).filter(e => e.event_type === "TOOL_CALL_START")).toHaveLength(1);
  });

  it("replays persisted events into the existing card after a restart without another send", async () => {
    const h = harness();
    await h.channel.handleTaskStream("oc_group", "topic", events(), meta,
      { durable: { idempotencyKey: "delivery_1", messageId: "om_card" } });
    expect(h.sends).toHaveLength(0);
    expect(JSON.stringify(h.patches.at(-1))).toContain("Work complete");
  });

  it("propagates final card failures so the delivery can be retried", async () => {
    const h = harness(true);
    await expect(h.channel.handleTaskStream("oc_group", "topic", events(), meta,
      { durable: { idempotencyKey: "delivery_1", messageId: "om_card" } })).rejects.toThrow("Final card patch failed");
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
});
