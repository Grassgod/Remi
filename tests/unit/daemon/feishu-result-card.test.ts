import { expect, it } from "bun:test";
import { readFeishuResultMetadata, sendResultCardLane } from "../../../apps/remi/cli/multiremi.js";
import type { MultiremiDaemon } from "@multiremi/daemon.js";
import type { MultiremiFeishuBotOutboundDelivery } from "@multiremi/contracts/types.js";
import type { FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import { completed, transcript } from "../connectors/feishu-native-harness.js";

type Reader = Pick<MultiremiDaemon, "subscribeTrace" | "getFeishuBotTaskSnapshot">;
const delivery = (): MultiremiFeishuBotOutboundDelivery => ({ id: "fbo_test", claimToken: "claim", taskId: "tsk_test",
  chatId: "oc_test", threadId: null, replyToMessageId: null, kind: "result_card", bodyOrigin: "agent", idempotencyKey: "delivery_test",
  body: JSON.stringify({ text: "Durable final answer", agentName: "Remi", sessionId: "session_original", elapsedSeconds: 46, stats: "46s" }) });

function reader(unsubscribe = async () => {}): Reader {
  return {
    subscribeTrace: async (_id, afterSeq, callback) => {
      expect(afterSeq).toBe(0);
      for await (const event of transcript()) if (event.kind === "message") callback([event.message], false);
      callback([], true);
      return unsubscribe;
    },
    getFeishuBotTaskSnapshot: async () => ({ ...(completed as any).snapshot,
      startedAt: "2026-10-04T00:00:00Z", completedAt: "2026-10-04T00:00:46Z" }),
  };
}

it("builds the independent result footer from canonical trace and preserves the answer and send key", async () => {
  const cards: any[] = [];
  let unsubscribed = 0;
  const handle = { sendProactiveCard: async (card: any) => { cards.push(card); return { messageId: "om_final" }; } } as FeishuChannelHandle;
  expect(await sendResultCardLane(handle, delivery(), undefined, reader(async () => { unsubscribed++; }))).toEqual({ messageId: "om_final" });
  expect(cards[0].idempotencyKey).toBe("delivery_test");
  const json = JSON.stringify(cards[0].card);
  expect(json).toContain("Durable final answer");
  expect(json).toContain("46s");
  expect(json).toContain("82k/1M");
  expect(json).toContain("1 tools");
  expect(json).toContain("Remi Claude fable51");
  expect(unsubscribed).toBe(1);
});

it("still sends the durable answer when its trace owner is offline", async () => {
  const cards: any[] = [];
  const handle = { sendProactiveCard: async (card: any) => { cards.push(card); return { messageId: "om_fallback" }; } } as FeishuChannelHandle;
  const offline = { ...reader(), subscribeTrace: async () => { throw new Error("trace owner offline"); } } as Reader;
  await sendResultCardLane(handle, delivery(), undefined, offline);
  expect(JSON.stringify(cards[0].card)).toContain("Durable final answer");
  expect(JSON.stringify(cards[0].card)).toContain("46s");
});

it("bounds an idle trace subscription and unsubscribes after timeout", async () => {
  let unsubscribed = 0;
  const idle = { ...reader(), subscribeTrace: async () => async () => { unsubscribed++; } } as Reader;
  await expect(readFeishuResultMetadata(idle, "tsk_test", "Remi", 46, undefined, 10)).rejects.toThrow("timed out");
  await Bun.sleep(0);
  expect(unsubscribed).toBe(1);
});

it("honors a delivery cancellation instead of sending a metadata fallback", async () => {
  let sends = 0;
  const controller = new AbortController();
  const handle = { sendProactiveCard: async () => { sends++; return { messageId: "om_bad" }; } } as unknown as FeishuChannelHandle;
  const cancelled = { ...reader(), subscribeTrace: async () => {
    controller.abort(new Error("handover"));
    return async () => {};
  } } as Reader;
  await expect(sendResultCardLane(handle, delivery(), { signal: controller.signal, onStarted: async () => {} }, cancelled)).rejects.toThrow("handover");
  expect(sends).toBe(0);
});

it("hydrates a historical queued body without elapsedSeconds from the terminal snapshot", async () => {
  const row = delivery();
  row.body = JSON.stringify({ text: "Historical reply", agentName: "Remi", stats: "46s" });
  const cards: any[] = [];
  const handle = { sendProactiveCard: async (card: any) => { cards.push(card); return { messageId: "om_history" }; } } as FeishuChannelHandle;
  await sendResultCardLane(handle, row, undefined, reader());
  expect(JSON.stringify(cards[0].card)).toContain("Historical reply");
  expect(JSON.stringify(cards[0].card)).toContain("46s");
  expect(JSON.stringify(cards[0].card)).toContain("82k/1M");
});
