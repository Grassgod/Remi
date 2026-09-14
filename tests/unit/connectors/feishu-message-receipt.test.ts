import { describe, expect, it } from "bun:test";
import { FeishuConnector } from "@connectors/feishu/index.js";
import { setFeishuMessageReceipt } from "@connectors/feishu/message-receipt.js";
import { FeishuTaskPresentation } from "@connectors/feishu/task-presentation.js";
import { completed, nativeHarness } from "./feishu-native-harness.js";
import type { TaskStreamEvent } from "@connectors/base.js";

function transport() {
  let next = 0;
  const rows = new Map<string, any[]>();
  const calls: Array<{ method: string; emoji?: string; id?: string; messageId: string }> = [];
  let rejectEmoji: string | null = null;
  const client = { request: async (input: any): Promise<any> => {
    const [, messageId, reactionId] = input.url.match(/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/)!;
    const items = rows.get(messageId) ?? [];
    rows.set(messageId, items);
    const emoji = input.data?.reaction_type?.emoji_type;
    calls.push({ method: input.method, emoji, id: reactionId, messageId });
    if (input.method === "GET") return { code: 0, data: { items: structuredClone(items) } };
    if (input.method === "DELETE") { rows.set(messageId, items.filter(item => item.reaction_id !== reactionId)); return { code: 0 }; }
    if (emoji === rejectEmoji) return { code: 99991500, data: {} };
    const item = { reaction_id: `r_${++next}`, operator: { operator_type: "app", operator_id: "cli_test" }, reaction_type: { emoji_type: emoji } };
    items.push(item);
    return { code: 0, data: item };
  } };
  return { client, calls, rows, fail: (emoji: string | null) => { rejectEmoji = emoji; },
    emojis: (id = "om_original") => (rows.get(id) ?? []).map(item => item.reaction_type.emoji_type) };
}
const meta = { taskId: "tsk_test", respondHumanRequest: async () => { throw new Error("not expected"); } };

describe("persistent Feishu message receipts", () => {
  it("adds the terminal receipt before removing the previous one and preserves other people's reactions", async () => {
    const h = transport();
    await setFeishuMessageReceipt(h.client as any, "cli_test", "om_original", "received");
    h.rows.get("om_original")!.push({ reaction_id: "someone_else", operator: { operator_type: "user", operator_id: "ou_user" }, reaction_type: { emoji_type: "THINKING" } });
    await setFeishuMessageReceipt(h.client as any, "cli_test", "om_original", "completed");
    expect(h.calls.filter(c => c.method !== "GET").map(c => c.emoji ?? c.id)).toEqual(["THINKING", "DONE", "r_1"]);
    expect(h.emojis()).toEqual(["THINKING", "DONE"]);
    await setFeishuMessageReceipt(h.client as any, "cli_test", "om_original", "received");
    expect(h.emojis()).toEqual(["THINKING", "DONE"]);
  });

  it("keeps the previous receipt when replacement fails and can recover without duplicating the result", async () => {
    const h = transport();
    await setFeishuMessageReceipt(h.client as any, "cli_test", "om_original", "received");
    h.fail("DONE");
    await expect(setFeishuMessageReceipt(h.client as any, "cli_test", "om_original", "completed")).rejects.toThrow();
    expect(h.emojis()).toEqual(["THINKING"]);
    h.fail(null);
    await Promise.all(["completed", "received"].map(state => setFeishuMessageReceipt(h.client as any, "cli_test", "om_original", state as "completed" | "received")));
    expect(h.emojis()).toEqual(["DONE"]);
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
    it(`retains ${status} receipts for the initial and later steer messages after result delivery`, async () => {
      const h = nativeHarness(), reactions = transport();
      const request = h.client.request;
      h.client.request = input => input.url.includes("/reactions") ? reactions.client.request(input) : request(input);
      async function* stream(): AsyncGenerator<TaskStreamEvent> {
        expect(reactions.emojis()).toEqual(["THINKING"]);
        expect(h.cards()).toHaveLength(0);
        yield { kind: "snapshot", snapshot: { ...(completed as any).snapshot, status, receiptMessageIds: ["om_original", "om_steer"] } };
      }
      await new FeishuTaskPresentation(h.client as any, "oc_chat", meta, { appId: "cli_test", idempotencyKey: "delivery",
        receiptMessageIds: ["om_original"], save: h.save }).consume(stream());
      expect(h.cards()).toHaveLength(1);
      expect(reactions.emojis()).toEqual([status === "completed" ? "DONE" : "CROSSMARK"]);
      expect(reactions.emojis("om_steer")).toEqual(reactions.emojis());
    });
  }

  it("waits for the result card acknowledgement before showing success", async () => {
    const h = nativeHarness(), reactions = transport();
    h.client.request = reactions.client.request;
    let started!: () => void, acknowledge!: () => void;
    const sending = new Promise<void>(resolve => { started = resolve; });
    const accepted = new Promise<void>(resolve => { acknowledge = resolve; });
    const create = h.client.im.message.create;
    h.client.im.message.create = async input => { started(); await accepted; return create(input); };
    async function* stream() { yield completed; }
    const done = new FeishuTaskPresentation(h.client as any, "oc_chat", meta, {
      appId: "cli_test", idempotencyKey: "delivery", receiptMessageIds: ["om_original"], save: h.save,
    }).consume(stream());
    await sending;
    expect(reactions.emojis()).toEqual(["THINKING"]);
    acknowledge();
    await done;
    expect(reactions.emojis()).toEqual(["DONE"]);
  });

  it("retries a failed final receipt using the checkpointed result and sends no second card", async () => {
    const h = nativeHarness(), reactions = transport();
    const request = h.client.request;
    h.client.request = input => input.url.includes("/reactions") ? reactions.client.request(input) : request(input);
    const renderer = () => new FeishuTaskPresentation(h.client as any, "oc_chat", meta, { appId: "cli_test", idempotencyKey: "delivery",
      receiptMessageIds: ["om_original"], checkpoint: h.checkpoint, save: h.save });
    async function* stream() { yield completed; }
    reactions.fail("DONE");
    await expect(renderer().consume(stream())).rejects.toThrow();
    expect(h.cards()).toHaveLength(1);
    expect(reactions.emojis()).toEqual(["THINKING"]);
    reactions.fail(null);
    await renderer().consume(stream());
    expect(h.cards()).toHaveLength(1);
    expect(reactions.emojis()).toEqual(["DONE"]);
  });

  it("does not mark a Runtime handover as a task failure", async () => {
    const h = nativeHarness(), reactions = transport(), abort = new AbortController();
    h.client.request = reactions.client.request;
    async function* stream() { abort.abort(new Error("handover")); yield completed; }
    await expect(new FeishuTaskPresentation(h.client as any, "oc_chat", { ...meta, signal: abort.signal }, {
      appId: "cli_test", idempotencyKey: "delivery", receiptMessageIds: ["om_original"],
    }).consume(stream())).rejects.toThrow("handover");
    expect(reactions.emojis()).toEqual(["THINKING"]);
  });
});
