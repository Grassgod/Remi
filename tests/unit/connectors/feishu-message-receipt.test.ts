import { describe, expect, it } from "bun:test";
import { FeishuConnector } from "@connectors/feishu/index.js";
import { setFeishuMessageReceipt } from "@connectors/feishu/message-receipt.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { completed, nativeHarness, taskEvent } from "./feishu-native-harness.js";
import type { TaskStreamEvent } from "@connectors/base.js";
import { FeishuDeliveryError, isPermanentFeishuDeliveryError } from "@shared/feishu-delivery-error.js";

function transport() {
  const appId = `cli_${crypto.randomUUID()}`;
  let next = 0;
  const rows = new Map<string, any[]>();
  const calls: Array<{ method: string; emoji?: string; id?: string; messageId: string }> = [];
  let rejectEmoji: string | null = null;
  let rejectCode = 99991500;
  let rejectDelete = false;
  const client = { request: async (input: any): Promise<any> => {
    const [, messageId, reactionId] = input.url.match(/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/)!;
    const items = rows.get(messageId) ?? [];
    rows.set(messageId, items);
    const emoji = input.data?.reaction_type?.emoji_type;
    calls.push({ method: input.method, emoji, id: reactionId, messageId });
    if (input.method === "GET") return { code: 0, data: { items: structuredClone(items) } };
    if (input.method === "DELETE") {
      if (rejectDelete) return { code: 99991500, data: {} };
      rows.set(messageId, items.filter(item => item.reaction_id !== reactionId)); return { code: 0 };
    }
    if (emoji === rejectEmoji) return { code: rejectCode, data: {} };
    const item = { reaction_id: `r_${++next}`, operator: { operator_type: "app", operator_id: appId }, reaction_type: { emoji_type: emoji } };
    items.push(item);
    return { code: 0, data: item };
  } };
  return { appId, client, calls, rows, failDelete: (fail: boolean) => { rejectDelete = fail; },
    fail: (emoji: string | null, code = 99991500) => { rejectEmoji = emoji; rejectCode = code; },
    emojis: (id = "om_original") => (rows.get(id) ?? []).map(item => item.reaction_type.emoji_type) };
}
const meta = { taskId: "tsk_test", respondHumanRequest: async () => { throw new Error("not expected"); } };

describe("persistent Feishu message receipts", () => {
  it("clears the working receipt on success without adding DONE or changing unrelated reactions", async () => {
    const h = transport();
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "received");
    h.rows.get("om_original")!.push({ reaction_id: "someone_else", operator: { operator_type: "user", operator_id: "ou_user" }, reaction_type: { emoji_type: "THINKING" } });
    h.rows.get("om_original")!.push({ reaction_id: "other_app", operator: { operator_type: "app", operator_id: "cli_other" }, reaction_type: { emoji_type: "DONE" } });
    h.rows.get("om_original")!.push({ reaction_id: "unrelated", operator: { operator_type: "app", operator_id: h.appId }, reaction_type: { emoji_type: "HEART" } });
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "completed");
    expect(h.calls.filter(c => c.method !== "GET").map(c => c.emoji ?? c.id)).toEqual(["THINKING", "r_1"]);
    expect(h.emojis()).toEqual(["THINKING", "DONE", "HEART"]);
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "received");
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "completed");
    expect(h.emojis()).toEqual(["THINKING", "DONE", "HEART"]);
    expect(h.calls.filter(c => c.method === "POST").map(c => c.emoji)).toEqual(["THINKING"]);
  });

  it("keeps thinking when cleanup fails and clears it on retry without accepting a late received state", async () => {
    const h = transport();
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "received");
    h.failDelete(true);
    await expect(setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "completed")).rejects.toThrow();
    expect(h.emojis()).toEqual(["THINKING"]);
    h.failDelete(false);
    await Promise.all(["completed", "received"].map(state => setFeishuMessageReceipt(h.client as any, h.appId, "om_original", state as "completed" | "received")));
    expect(h.emojis()).toEqual([]);
    expect(h.calls.filter(c => c.method === "POST").map(c => c.emoji)).toEqual(["THINKING"]);
  });

  it("still acknowledges failure before replacing THINKING and leaves the old state on a failed replacement", async () => {
    const h = transport();
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "received");
    h.fail("CROSSMARK");
    await expect(setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "failed")).rejects.toThrow();
    expect(h.emojis()).toEqual(["THINKING"]);
    h.fail(null);
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "failed");
    expect(h.calls.filter(c => c.method !== "GET").slice(-2).map(c => c.emoji ?? c.id)).toEqual(["CROSSMARK", "r_1"]);
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "received");
    expect(h.emojis()).toEqual(["CROSSMARK"]);
  });

  it("cleans up a legacy DONE receipt when a completed delivery is reconciled", async () => {
    const h = transport();
    h.rows.set("om_original", [{ reaction_id: "legacy_done", operator: { operator_type: "app", operator_id: h.appId }, reaction_type: { emoji_type: "DONE" } }]);
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "received");
    expect(h.emojis()).toEqual(["DONE"]);
    await setFeishuMessageReceipt(h.client as any, h.appId, "om_original", "completed");
    expect(h.emojis()).toEqual([]);
    expect(h.calls.filter(c => c.method !== "GET").map(c => c.emoji ?? c.id)).toEqual(["legacy_done"]);
  });

  it("does not clear an incoming receipt when a durable handler only queues the reply", async () => {
    const receipts: string[] = [];
    const connector = Object.create(FeishuConnector.prototype) as any;
    Object.assign(connector, { _taskStreamHandler: async () => {}, _groupPolicy: { getByChatId: () => null },
      _channel: { setMessageReceipt: async (_id: string, state: string) => { receipts.push(state); } } });
    await connector._handleFeishuMessage({ messageId: "om_original", chatId: "oc_chat", chatType: "p2p",
      senderOpenId: "ou_user", text: "Hello", rawContent: "Hello", media: [] });
    expect(receipts).toEqual(["received"]);
  });

  for (const status of ["completed", "failed", "cancelled"] as const) {
    it(`reconciles ${status} receipts for the initial and later steer messages after result delivery`, async () => {
      const h = nativeHarness(), reactions = transport();
      const request = h.client.request;
      h.client.request = input => input.url.includes("/reactions") ? reactions.client.request(input) : request(input);
      async function* stream(): AsyncGenerator<TaskStreamEvent> {
        expect(reactions.emojis()).toEqual(["THINKING"]);
        expect(h.cards()).toHaveLength(0);
        yield { kind: "snapshot", snapshot: { ...(completed as any).snapshot, status, receiptMessageIds: ["om_original", "om_steer"] } };
      }
      await new FeishuTaskPresentation(h.client as any, "oc_chat", meta, { appId: reactions.appId, idempotencyKey: "delivery",
        receiptMessageIds: ["om_original"], save: h.save }).consume(stream());
      expect(h.cards()).toHaveLength(1);
      expect(reactions.emojis()).toEqual(status === "completed" ? [] : ["CROSSMARK"]);
      expect(reactions.emojis("om_steer")).toEqual(reactions.emojis());
    });
  }

  it("keeps thinking through queue handoff and a plain-answer wait without fabricating CoT", async () => {
    const h = nativeHarness(), reactions = transport();
    const request = h.client.request;
    h.client.request = input => input.url.includes("/reactions") ? reactions.client.request(input) : request(input);
    const connector = Object.create(FeishuConnector.prototype) as any;
    Object.assign(connector, { _taskStreamHandler: async () => {}, _groupPolicy: { getByChatId: () => null },
      _channel: { setMessageReceipt: (id: string, state: "received") =>
        setFeishuMessageReceipt(h.client as any, reactions.appId, id, state) } });
    await connector._handleFeishuMessage({ messageId: "om_original", chatId: "oc_private", chatType: "p2p",
      senderOpenId: "ou_user", text: "Hello", rawContent: "Hello", media: [] });
    expect(reactions.emojis()).toEqual(["THINKING"]);

    let started!: () => void, finish!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const answer = new Promise<void>(resolve => { finish = resolve; });
    async function* stream(): AsyncGenerator<TaskStreamEvent> {
      yield taskEvent(1, "execution", { meta: { agentName: "Remi" } });
      started();
      await answer;
      yield taskEvent(2, "text", { content: "Hello" });
      yield completed;
    }
    const done = new FeishuTaskPresentation(h.client as any, "oc_private", meta, {
      appId: reactions.appId, idempotencyKey: "delivery", receiptMessageIds: ["om_original"], save: h.save,
    }).consume(stream());
    await waiting;
    expect(reactions.emojis()).toEqual(["THINKING"]);
    expect(h.calls).toHaveLength(0);
    finish();
    await done;
    expect(h.calls.map(c => c.operation)).toEqual(["create"]);
    expect(reactions.emojis()).toEqual([]);
  });

  it("waits for the result card acknowledgement before removing THINKING", async () => {
    const h = nativeHarness(), reactions = transport();
    h.client.request = reactions.client.request;
    let started!: () => void, acknowledge!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const accepted = new Promise<void>(resolve => { acknowledge = resolve; });
    const create = h.client.im.message.create;
    h.client.im.message.create = async input => { started(); await accepted; return create(input); };
    async function* stream() { yield completed; }
    const done = new FeishuTaskPresentation(h.client as any, "oc_chat", meta, {
      appId: reactions.appId, idempotencyKey: "delivery", receiptMessageIds: ["om_original"], save: h.save,
    }).consume(stream());
    await sending;
    expect(reactions.emojis()).toEqual(["THINKING"]);
    acknowledge();
    await done;
    expect(reactions.emojis()).toEqual([]);
  });

  it("retries a failed final receipt using the checkpointed result and sends no second card", async () => {
    const h = nativeHarness(), reactions = transport();
    const request = h.client.request;
    h.client.request = input => input.url.includes("/reactions") ? reactions.client.request(input) : request(input);
    const renderer = () => new FeishuTaskPresentation(h.client as any, "oc_chat", meta, { appId: reactions.appId, idempotencyKey: "delivery",
      receiptMessageIds: ["om_original"], checkpoint: h.checkpoint, save: h.save });
    async function* stream() { yield completed; }
    reactions.failDelete(true);
    await expect(renderer().consume(stream())).rejects.toThrow();
    expect(h.cards()).toHaveLength(1);
    expect(reactions.emojis()).toEqual(["THINKING"]);
    reactions.failDelete(false);
    await renderer().consume(stream());
    expect(h.cards()).toHaveLength(1);
    expect(reactions.emojis()).toEqual([]);
  });

  it("does not restore THINKING when resuming an acknowledged result without a visible success marker", async () => {
    const h = nativeHarness(), reactions = transport();
    h.client.request = reactions.client.request;
    async function* stream() { yield completed; }
    await new FeishuTaskPresentation(h.client as any, "oc_chat", meta, {
      appId: reactions.appId, idempotencyKey: "delivery", receiptMessageIds: ["om_original"],
      checkpoint: { version: "native_cot_v1", startedAt: Date.now(), throughSeq: 0, interactions: {}, resultMessageId: "om_already_sent" },
    }).consume(stream());
    expect(h.cards()).toHaveLength(0);
    expect(reactions.calls.filter(c => c.method === "POST")).toHaveLength(0);
    expect(reactions.emojis()).toEqual([]);
  });

  it("does not mark a Runtime handover as a task failure", async () => {
    const h = nativeHarness(), reactions = transport(), abort = new AbortController();
    h.client.request = reactions.client.request;
    async function* stream() { abort.abort(new Error("handover")); yield completed; }
    await expect(new FeishuTaskPresentation(h.client as any, "oc_chat", { ...meta, signal: abort.signal }, {
      appId: reactions.appId, idempotencyKey: "delivery", receiptMessageIds: ["om_original"],
    }).consume(stream())).rejects.toThrow("handover");
    expect(reactions.emojis()).toEqual(["THINKING"]);
  });

  // A refused CROSSMARK used to replace the real failure and its retry classification (MUL-365).
  for (const [label, original, refusal, permanent] of [
    ["a transient daemon error stays retryable", new Error("GET /api/daemon/tasks/tsk_test/human-requests/hr_1 returned 403"), 231001, false],
    ["a permanent Feishu refusal stays permanent", new FeishuDeliveryError("Feishu delivery: Feishu code 230002", false), 99991500, true],
  ] as const) {
    it(`reports the original failure when the failure receipt is refused: ${label}`, async () => {
      const h = nativeHarness(), reactions = transport(), logs: string[] = [];
      const request = h.client.request;
      h.client.request = input => input.url.includes("/reactions") ? reactions.client.request(input) : request(input);
      reactions.fail("CROSSMARK", refusal);
      async function* stream() { yield taskEvent(1, "question_request", { input: { request_id: "hr_1" } }); yield completed; }
      const failure = await new FeishuTaskPresentation(h.client as any, "oc_chat",
        { ...meta, getHumanRequest: async () => { throw original; } },
        { appId: reactions.appId, idempotencyKey: "delivery", receiptMessageIds: ["om_original"], save: h.save,
          log: message => logs.push(message) }).consume(stream()).catch(error => error);
      expect(failure).toBe(original);
      expect(isPermanentFeishuDeliveryError(failure)).toBe(permanent);
      expect(h.cards()).toHaveLength(0);
      expect(reactions.emojis()).toEqual(["THINKING"]);
      expect(logs).toEqual([expect.stringContaining(`Feishu code ${refusal}`)]);
    });
  }
});
