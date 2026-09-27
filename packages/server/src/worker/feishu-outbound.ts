import type {
  FeishuDecisionDegradeReason,
  FeishuPresentationCheckpoint,
  MultiremiFeishuBotOutboundDelivery,
} from "@multiremi/contracts/types.js";
import type { FeishuOutboundOptions } from "./feishu-concierge.js";

/** The lease timer is independent of Task consumption (including human waits). */
export async function deliverFeishuOutbound(
  delivery: MultiremiFeishuBotOutboundDelivery,
  options: {
    signal: AbortSignal;
    prepareMention?: (openId: string | null) => Promise<string | null>;
    send: (options: FeishuOutboundOptions) => Promise<{ messageId: string }>;
    report: (input: { claimToken: string; status: "streaming" | "sent" | "failed";
      externalMessageId?: string; error?: string; presentation?: FeishuPresentationCheckpoint;
      interactionOpenId?: string | null; degraded?: FeishuDecisionDegradeReason | null;
    }) => Promise<void>;
    renewMs?: number;
  },
): Promise<void> {
  const abort = new AbortController();
  const signal = AbortSignal.any([options.signal, abort.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> = Promise.resolve();
  // A decision lane reports its own terminal state (it knows the recipient and
  // any degradation); the loop's generic acknowledgement must not overwrite it.
  let acknowledged = false;
  const scheduleRenewal = () => {
    if (signal.aborted) return;
    timer = setTimeout(() => {
      renewal = options.report({ claimToken: delivery.claimToken, status: "streaming" })
        .then(scheduleRenewal, error => { abort.abort(error); });
    }, options.renewMs ?? 10_000);
  };
  try {
    signal.throwIfAborted();
    if (delivery.taskId || delivery.attachments?.length) scheduleRenewal();
    const sent = await options.send({
      signal,
      prepareMention: options.prepareMention,
      onStarted: async messageId => {
        signal.throwIfAborted();
        await options.report({ claimToken: delivery.claimToken, status: "streaming", externalMessageId: messageId });
      },
      onCheckpoint: async presentation => {
        signal.throwIfAborted();
        await options.report({ claimToken: delivery.claimToken, status: "streaming", presentation });
      },
      onDecisionSent: async receipt => {
        signal.throwIfAborted();
        // Decision lanes acknowledge in one step: what matters is the message
        // id plus the recipient/degradation the host actually used.
        await options.report({
          claimToken: delivery.claimToken, status: "sent", externalMessageId: receipt.messageId,
          interactionOpenId: receipt.interactionOpenId, degraded: receipt.degraded ?? null,
        });
        acknowledged = true;
      },
    });
    signal.throwIfAborted();
    clearTimeout(timer);
    abort.abort();
    await renewal;
    if (!acknowledged) {
      await options.report({ claimToken: delivery.claimToken, status: "sent", externalMessageId: sent.messageId });
    }
  } finally {
    abort.abort();
    clearTimeout(timer);
    await renewal;
  }
}
