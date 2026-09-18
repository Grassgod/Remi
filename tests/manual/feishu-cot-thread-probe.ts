#!/usr/bin/env bun
/** MUL-311: compare native CoT placement in an explicitly selected ordinary group.
 * Credentials: FEISHU_APP_ID / FEISHU_APP_SECRET / optional FEISHU_DOMAIN.
 * bun tests/manual/feishu-cot-thread-probe.ts --send --chat-id oc_...
 * Creates one labeled message and two native CoTs; leaves them for inspection.
 * Never retries a write or starts an Agent, event consumer or production task.
 */
import { parseArgs } from "node:util";
import { loadConfig as loadRemiConfig } from "@shared/config.js";
import { resolveApiOrigin } from "@shared/feishu-domain.js";
import { loadConfig } from "./_load-config.js";

type Message = {
  message_id?: string;
  chat_id?: string;
  thread_id?: string;
  root_id?: string;
  parent_id?: string;
};
type Response = {
  code?: number;
  msg?: string;
  data?: Message & { cot_id?: string; chat_mode?: string; group_message_type?: string; items?: Message[] };
};
class ProbeError extends Error {}
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
const placement = (m: Message) => ({
  message_id: m.message_id ?? null,
  thread_id: m.thread_id ?? null,
  root_id: m.root_id ?? null,
  parent_id: m.parent_id ?? null,
});

async function main() {
  let args;
  try {
    args = parseArgs({ options: { send: { type: "boolean" }, "chat-id": { type: "string" }, help: { type: "boolean" } } }).values;
  } catch { throw new ProbeError("Use --send and --chat-id oc_...; unknown or malformed arguments are rejected"); }
  if (args.help) {
    console.log("Usage: bun tests/manual/feishu-cot-thread-probe.ts --send [--chat-id oc_...]\n"
      + "Requires FEISHU_APP_ID, FEISHU_APP_SECRET; chat defaults to FEISHU_TEST_CHAT_ID.\n"
      + "FEISHU_DOMAIN selects feishu, lark or bytedance. Requires chat_mode=group and group_message_type=chat.\n"
      + "Outputs API code/msg and message placement fields; no credentials or full responses.");
    return;
  }
  if (!args.send) throw new ProbeError("Explicit --send is required; no requests made");
  const available = loadRemiConfig().feishu;
  const chatId = args["chat-id"] ?? process.env.FEISHU_TEST_CHAT_ID;
  const missing = [
    ...(!available.appId ? ["FEISHU_APP_ID"] : []),
    ...(!available.appSecret ? ["FEISHU_APP_SECRET"] : []),
    ...(!chatId ? ["FEISHU_TEST_CHAT_ID or --chat-id"] : []),
  ];
  if (missing.length) throw new ProbeError(`Missing ${missing.join(", ")}; no requests made`);
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId!)) throw new ProbeError("Invalid test chat_id; no requests made");
  const config = loadConfig(chatId);
  // Same bot credentials/domain as the connector. Disable SDK logging because
  // transport errors can contain auth headers or the token exchange request.
  const Lark = await import("@larksuiteoapi/node-sdk");
  const silent = () => {};
  const client = new Lark.Client({
    appId: config.appId, appSecret: config.appSecret, appType: Lark.AppType.SelfBuild,
    domain: resolveApiOrigin(config.domain),
    logger: { error: silent, warn: silent, info: silent, debug: silent, trace: silent },
  });
  const redact = (value: string) => value.split(config.appSecret).join("[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/((?:app_secret|access_token|appSecret)\s*[=:]\s*)\S+/gi, "$1[REDACTED]").slice(0, 1000);
  async function api(label: string, method: string, url: string, data?: Record<string, unknown>, params?: Record<string, unknown>) {
    let response: Response;
    try { response = await client.request<Response>({ method, url, data, params, timeout: 15_000 }); }
    catch (error) {
      // Only read the API envelope; never print the SDK error, request or headers.
      const failed = (error as { response?: { data?: Response; status?: number } })?.response;
      if (typeof failed?.data?.code !== "number") {
        log({ label, method, code: null, http_status: failed?.status ?? null, msg: "Response unavailable; write outcome may be ambiguous. Not retried." });
        throw new ProbeError(`${label}: no API acknowledgement; stop and inspect existing messages before rerunning`);
      }
      response = failed.data;
    }
    if (typeof response?.code !== "number") {
      log({ label, method, code: null, msg: "Missing API code; write outcome may be ambiguous. Not retried." });
      throw new ProbeError(`${label}: incomplete API acknowledgement; stop and inspect existing messages before rerunning`);
    }
    log({ label, method, code: response.code, msg: redact(response.msg ?? "") });
    return response;
  }
  async function readMessage(label: string, id: string) {
    const response = await api(label, "GET", `/open-apis/im/v1/messages/${encodeURIComponent(id)}`);
    const message = response.data?.items?.find(item => item.message_id === id);
    if (response.code !== 0 || !message || message.chat_id !== chatId) {
      throw new ProbeError(`${label}: cannot verify message in the selected group; placement is inconclusive`);
    }
    log({ label, placement: placement(message) });
    return message;
  }
  const runId = `MUL-311-${Date.now()}`;
  log({ run_id: runId, api_origin: resolveApiOrigin(config.domain), chat_id: chatId });
  const group = await api("verify_group", "GET", `/open-apis/im/v1/chats/${encodeURIComponent(chatId!)}`);
  log({ label: "group_mode", chat_mode: group.data?.chat_mode ?? null, group_message_type: group.data?.group_message_type ?? null });
  if (group.code !== 0 || group.data?.chat_mode !== "group" || group.data.group_message_type !== "chat") {
    throw new ProbeError("Selected target is not a verified ordinary conversation group (group/chat); no messages sent");
  }
  const anchor = await api("create_origin_A", "POST", "/open-apis/im/v1/messages", {
    receive_id: chatId, msg_type: "text", uuid: runId,
    content: JSON.stringify({ text: `[${runId}] CoT 话题投递探针。接下来两条过程分别不带／带 reply_in_thread=true；仅测试消息，无真实任务。` }),
  }, { receive_id_type: "chat_id" });
  const originId = anchor.data?.message_id;
  if (anchor.code !== 0 || !originId) throw new ProbeError("Origin message was not acknowledged; no CoT requests sent");
  log({ label: "origin_A", message_id: originId });
  const observations: Array<Record<string, unknown>> = [];
  for (const replyInThread of [false, true]) {
    const label = replyInThread ? "with_reply_in_thread" : "without_reply_in_thread";
    const body = { receive_id: chatId, origin_message_id: originId, ...(replyInThread ? { reply_in_thread: true } : {}) };
    log({ label, request_body: body });
    const created = await api(label, "POST", "/open-apis/im/v1/message_cot", body, { receive_id_type: "chat_id" });
    const messageId = created.data?.message_id, cotId = created.data?.cot_id;
    if (created.code !== 0) {
      observations.push({ label, code: created.code ?? null, observation: "rejected; inspect code/msg before attributing to the parameter" });
      continue;
    }
    log({ label, message_id: messageId ?? null, cot_id: cotId ?? null });
    if (!messageId || !cotId) throw new ProbeError(`${label}: incomplete CoT acknowledgement; do not retry creation`);
    let completed = false;
    try {
      const message = await readMessage(`${label}_readback`, messageId);
      const origin = await readMessage(`${label}_origin_readback`, originId);
      const linked = message.root_id === originId || message.parent_id === originId;
      const inThread = Boolean(linked && message.thread_id && message.thread_id === origin.thread_id);
      const noThread = !message.thread_id && !message.root_id && !message.parent_id;
      observations.push({ label, code: created.code, ...placement(message), observation: inThread
        ? "thread_link_to_A_observed" : noThread ? "no_thread_metadata_observed" : "inconclusive_placement" });
    } finally {
      // Close this probe's native spinner while preserving the message for UI inspection.
      const result = await api(`${label}_complete`, "POST", `/open-apis/im/v1/message_cot/complete/${encodeURIComponent(cotId)}`,
        undefined, { message_id: messageId, reason: "done" });
      completed = result.code === 0;
    }
    if (!completed) throw new ProbeError(`${label}: completion rejected; inspect this probe's native message before rerunning`);
  }
  log({ run_id: runId, origin_message_id: originId, observations,
    note: "A successful create alone does not prove parameter support. Compare placement fields and inspect the client; API failures may be unrelated to reply_in_thread." });
  if (observations.some(entry => entry.code !== 0 || entry.observation === "inconclusive_placement")) process.exitCode = 1;
}

await main().catch(error => {
  log({ status: "blocked", message: error instanceof ProbeError ? error.message : "Probe failed; unexpected error details suppressed to protect credentials" });
  process.exitCode = 1;
});
