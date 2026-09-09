import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuBotOutboundMention } from "@multiremi/contracts/types.js";
import { isFeishuOpenId } from "@shared/feishu-mention.js";

/** A lookup failure must not prevent an Issue report from being delivered. */
export async function resolveProactiveMention(
  client: Pick<Client, "request">, chatId: string, mention: FeishuBotOutboundMention,
  options: { warn: (message: string) => void; signal?: AbortSignal; timeoutMs?: number },
): Promise<string | null> {
  if (mention.resolvedOpenId !== undefined) return mention.resolvedOpenId;
  if (mention.mode === "none") return null;
  if (mention.mode === "person") return isFeishuOpenId(mention.openId) ? mention.openId : null;
  const timeoutMs = options.timeoutMs ?? 5000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    options.signal?.throwIfAborted();
    const result = await Promise.race([
      client.request({ method: "GET", url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
        params: { user_id_type: "open_id" }, timeout: timeoutMs }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("lookup timeout")), timeoutMs); }),
    ]) as { code?: number; data?: { owner_id?: unknown; owner_id_type?: unknown } };
    options.signal?.throwIfAborted();
    if (result.code === 0 && result.data?.owner_id_type === "open_id" && isFeishuOpenId(result.data.owner_id)) {
      return result.data.owner_id;
    }
    options.warn(`Issue notification will omit its mention: group owner unavailable (code ${result.code ?? "unknown"})`);
  } catch {
    options.signal?.throwIfAborted();
    // SDK errors may include request headers. Never log the exception object.
    options.warn("Issue notification will omit its mention: group owner lookup failed");
  } finally { clearTimeout(timer); }
  return null;
}
