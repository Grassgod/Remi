import type * as Lark from "@larksuiteoapi/node-sdk";
import { feishuResponseError, feishuTransportError } from "./native-cot.js";

export type FeishuMessageReceipt = "received" | "completed" | "failed";
export const RECEIPT_EMOJI = { received: "THINKING", completed: null, failed: "CROSSMARK" } as const;
const managedEmojis = new Set(["THINKING", "DONE", "CROSSMARK"]); // Include legacy success receipts for cleanup.
const pending = new Map<string, Promise<void>>();
const completed = new Set<string>();
const MAX_COMPLETED_RECEIPTS = 10_000;

/** A receipt belongs to the original message, not the short enqueue callback.
 * Serialize local writers and reconcile with Feishu so retries/restarts are safe. */
export async function setFeishuMessageReceipt(client: Lark.Client, appId: string, messageId: string,
  state: FeishuMessageReceipt, signal?: AbortSignal): Promise<void> {
  const key = `${appId}:${messageId}`;
  const work = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
    // Success has no visible marker now. Remember recent local completions so
    // a delayed intake callback cannot restore THINKING. Restarted deliveries
    // use the persisted result checkpoint; incoming events have their own dedup.
    if (state === "received" && completed.has(key)) return;
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`;
    const request = async (method: string, url: string, data?: unknown, params?: Record<string, unknown>) => {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          const result = await client.request({ method, url, data, params, timeout: 5_000 });
          if (result.code !== 0) throw feishuResponseError(`Feishu reaction ${method}`, result);
          return result.data;
        } catch (error) {
          signal?.throwIfAborted();
          const failure = feishuTransportError("Feishu reaction", error);
          if (!failure.retryable || attempt >= 2) throw failure;
          await new Promise(resolve => setTimeout(resolve, 150 * 2 ** attempt));
        }
      }
    };
    const owned: Array<{ id: string; emoji: string }> = [];
    let pageToken: string | undefined;
    do {
      const page = await request("GET", path, undefined, { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) });
      for (const item of page?.items ?? []) {
        if (item.operator?.operator_type === "app" && item.operator.operator_id === appId
          && typeof item.reaction_id === "string") {
          owned.push({ id: item.reaction_id, emoji: item.reaction_type?.emoji_type });
        }
      }
      pageToken = page?.has_more && page?.page_token ? page.page_token : undefined;
    } while (pageToken);
    // Preserve failure markers and recognize success markers from older daemons.
    if (state === "received" && owned.some(item => item.emoji === "DONE" || item.emoji === "CROSSMARK")) return;
    const emoji = RECEIPT_EMOJI[state];
    if (emoji && !owned.some(item => item.emoji === emoji)) {
      const added = await request("POST", path, { reaction_type: { emoji_type: emoji } });
      if (!added?.reaction_id) throw new Error("Feishu reaction acknowledgement missing");
    }
    // Failure still replaces THINKING only after CROSSMARK is acknowledged.
    // Success only removes this app's receipt, after result delivery succeeds.
    for (const item of owned) {
      if (item.emoji !== emoji && managedEmojis.has(item.emoji)) {
        await request("DELETE", `${path}/${encodeURIComponent(item.id)}`);
      }
    }
    if (state === "completed") {
      completed.delete(key);
      completed.add(key);
      if (completed.size > MAX_COMPLETED_RECEIPTS) completed.delete(completed.values().next().value!);
    }
  });
  pending.set(key, work);
  try { await work; } finally { if (pending.get(key) === work) pending.delete(key); }
}
