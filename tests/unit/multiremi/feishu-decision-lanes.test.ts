import { describe, expect, it, mock } from "bun:test";
import type { MultiremiFeishuBotOutboundDelivery } from "@multiremi/contracts/types.js";
import { decisionMentionElement, encodeDecisionCardBody } from "@shared/feishu-task-card.js";
import { FeishuDeliveryError } from "@shared/feishu-delivery-error.js";
import type { FeishuChannelHandle } from "../../../apps/remi/cli/agent.js";
import { sendDecisionLane, sendIssueDecisionLane } from "../../../apps/remi/cli/multiremi.js";

const fallback = "是否合入？\n1. 合入\n2. 暂缓";
function delivery(issueDecision: boolean): MultiremiFeishuBotOutboundDelivery {
  return {
    id: "fout_test", claimToken: "claim_test", chatId: "oc_topic", threadId: "om_root", replyToMessageId: "om_root",
    body: encodeDecisionCardBody({ card: { schema: "2.0", body: { elements: [decisionMentionElement(null)] } }, fallback_text: fallback }),
    bodyOrigin: "issue", idempotencyKey: "decision_delivery_test", kind: "decision_card",
    ...(issueDecision ? { decisionIssueId: "iss_test", decisionId: "dcs_test" }
      : { humanRequestId: "hr_test", humanRequestTaskId: "tsk_test" }),
  };
}
function channel(resolved: string | null = "ou_reviewer") {
  const sendCard = mock(async (_input: unknown) => ({ messageId: "om_card" }));
  const sendText = mock(async (_input: unknown) => ({ messageId: "om_text" }));
  const resolve = mock(async () => resolved);
  const handle = { appId: "cli_test", sendProactiveCard: sendCard, sendProactiveThreadReply: sendText,
    resolveProactiveMention: resolve } as unknown as FeishuChannelHandle;
  return { handle, sendCard, sendText, resolve };
}
function outboundOptions(report: (outcome: unknown) => Promise<void>) {
  return { signal: new AbortController().signal, onStarted: async () => {}, onDecisionSent: report };
}

describe("MUL-531 decision lane fallback mentions", () => {
  for (const [name, send, issueDecision] of [
    ["human request", sendDecisionLane, false], ["issue decision", sendIssueDecisionLane, true],
  ] as const) {
    for (const explicit of [true, false]) {
      it(`${name}: terminal card rejection mentions the ${explicit ? "explicit" : "group owner"} recipient once`, async () => {
        const { handle, sendCard, sendText, resolve } = channel();
        const row = { ...delivery(issueDecision), ...(explicit ? { interactionOpenId: "ou_reviewer" } : {}) };
        sendCard.mockRejectedValue(new FeishuDeliveryError("230099 / ErrCode 11310: card rejected", false));
        const report = mock(async (_outcome: unknown) => {});
        expect(await send(handle, row, outboundOptions(report))).toEqual({ messageId: "om_text" });
        expect(sendCard).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledTimes(explicit ? 0 : 1);
        expect(sendText.mock.calls).toEqual([[{
          chatId: row.chatId, replyToMessageId: row.replyToMessageId,
          body: `<at id=ou_reviewer></at> ${fallback}`, idempotencyKey: row.idempotencyKey,
        }]]);
        expect(report.mock.calls).toEqual([[{ messageId: "om_text", interactionOpenId: "ou_reviewer", degraded: "send_failed" }]]);
      });
    }

    for (const reason of ["notify_none", "invalid_recipient", "unresolved_recipient"] as const) {
      it(`${name}: ${reason} sends readable text without mentioning anyone`, async () => {
        const { handle, sendCard, sendText } = channel(null);
        const row = { ...delivery(issueDecision), ...(reason === "unresolved_recipient" ? {} : { degraded: reason }) };
        const report = mock(async (_outcome: unknown) => {});
        await send(handle, row, outboundOptions(report));
        expect(sendCard).not.toHaveBeenCalled();
        expect(sendText.mock.calls).toEqual([[{
          chatId: row.chatId, replyToMessageId: row.replyToMessageId, body: fallback, idempotencyKey: row.idempotencyKey,
        }]]);
        expect(report.mock.calls).toEqual([[{ messageId: "om_text", interactionOpenId: null, degraded: reason }]]);
      });
    }

    it(`${name}: retryable rejection stays on the outbox backoff without text or a sent receipt`, async () => {
      const { handle, sendCard, sendText } = channel();
      const failure = new FeishuDeliveryError("429 rate limited", true);
      sendCard.mockRejectedValue(failure);
      const report = mock(async (_outcome: unknown) => {});
      await expect(send(handle, delivery(issueDecision), outboundOptions(report))).rejects.toBe(failure);
      expect(sendText).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
    });

    it(`${name}: successful card stays a card with the resolved recipient`, async () => {
      const { handle, sendCard, sendText } = channel();
      const report = mock(async (_outcome: unknown) => {});
      expect(await send(handle, delivery(issueDecision), outboundOptions(report))).toEqual({ messageId: "om_card" });
      expect(sendCard).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(sendCard.mock.calls)).toContain("<at id=ou_reviewer></at>");
      expect(sendText).not.toHaveBeenCalled();
      expect(report.mock.calls).toEqual([[{ messageId: "om_card", interactionOpenId: "ou_reviewer", degraded: null }]]);
    });
  }
});
