import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { CHAT_ATTACHMENT_MAX_BYTES, chatAttachmentValidationError } from "@multiremi/contracts/attachments.js";
import { MESSAGE_KINDS, type DecisionOption, type MessageRecipient, type SendMessageResult } from "@multiremi/contracts/unified-model.js";
import { CliError, CliRenderer, type CommandInvocation, type CommandSpec, type CliOptionSpec } from "../core/index.js";
import {
  commandOptions, clientFor, encodePath, integerOption, outputMode, positional,
  renderResource, stringOption, stringOptions, YES_OPTION, PAGE_OPTIONS, requireConfirmation,
} from "./resource-common.js";
import { detectCliContentTypeFromFilename } from "../multiremi/http.js";

const textOptions: CliOptionSpec[] = [
  { name: "content", type: "string", conflictsWith: ["content-file", "content-stdin"] },
  { name: "content-file", type: "string", conflictsWith: ["content", "content-stdin"] },
  { name: "content-stdin", type: "boolean", conflictsWith: ["content", "content-file"] },
];
const ref = (name: string, required = true) => ({ name, required });
const option = (name: string, type: CliOptionSpec["type"] = "string"): CliOptionSpec => ({ name, type });

function spec(path: string[], mutation: CommandSpec["mutation"], positionals: CommandSpec["positionals"], options: CliOptionSpec[], run: CommandSpec["run"]): CommandSpec {
  return { id: path.join("."), path, description: descriptions[path.join(".")]!, capability: path.join("."),
    auth: ["human", "task"], outputs: ["table", "json", "jsonl"], mutation, positionals, options: commandOptions(options, ...(mutation === "read" ? [PAGE_OPTIONS] : [])),
    run: async (invocation) => { outputMode(invocation); await run(invocation); } };
}
const descriptions: Record<string, string> = {
  "message.send": "Send a conversation message", "message.list": "List conversation messages",
  "message.get": "Get a message", "message.edit": "Edit an unread message", "message.delete": "Delete an unread message",
  "message.resolve": "Resolve or reopen a message", "message.react": "Add or remove a message reaction",
  inbox: "Read messages addressed to you", "inbox.read": "Advance a conversation read cursor", "inbox.read-all": "Read all conversations",
  "turn.list": "List turns", "turn.get": "Get a turn and its input or attempts", "turn.cancel": "Cancel a turn",
  "turn.wrap-up": "Ask a running turn to finish", "turn.retry": "Retry a turn with a new attempt", "turn.trace.read": "Read an attempt trace",
};

export function unifiedCommandSpecs(): CommandSpec[] {
  return [
    ...["message", "turn"].map((domain): CommandSpec => ({ id: `${domain}.group`, path: [domain], description: domain === "message" ? "Send and manage conversation messages" : "Inspect and control turns", parse: "passthrough", run: async () => { throw new CliError("usage", `usage: remi ${domain} <command>`); } })),
    spec(["message", "send"], "write", [ref("conversation", false)], [
      ...textOptions, option("to"), option("to-type"), option("kind"), option("wake"), option("reply-to"),
      { ...option("option"), repeatable: true }, { ...option("attachment"), repeatable: true }, option("dedupe-key"),
    ], send),
    spec(["message", "list"], "read", [ref("conversation", false)], [option("unread-by"), option("thread"), option("kind"), option("after", "integer"), option("limit", "integer"), option("cursor")], async (i) => {
      const client = await clientFor(i);
      const conversation = await conversationRef(i, client);
      const result = await client.request({ method: "GET", path: `/api/sessions/${encodePath(conversation)}/messages`, query: {
        unread_by: stringOption(i, "unread-by"), thread: stringOption(i, "thread"), message_kind: stringOption(i, "kind"),
        after_seq: integerOption(i, "after"), limit: integerOption(i, "limit"), cursor: stringOption(i, "cursor"),
      } });
      renderMessages(i, result.data);
    }),
    spec(["message", "get"], "read", [ref("message")], [], async (i) => { renderMessages(i, await request(i, "GET", messagePath(i))); }),
    spec(["message", "edit"], "write", [ref("message")], textOptions, async (i) => {
      const body = content(i);
      if (!body?.trim()) throw new CliError("usage", "message edit requires non-empty --content, --content-file, or --content-stdin");
      renderMessages(i, await request(i, "PATCH", messagePath(i), { body_md: body }));
    }),
    spec(["message", "delete"], "destructive", [ref("message")], [YES_OPTION], async (i) => { requireConfirmation(i); renderResource(i, await request(i, "DELETE", messagePath(i))); }),
    spec(["message", "resolve"], "write", [ref("message")], [option("resolved", "boolean")], async (i) => {
      renderMessages(i, await request(i, "POST", `${messagePath(i)}/resolve`, { resolved: i.options.resolved !== false }));
    }),
    spec(["message", "react"], "write", [ref("message")], [{ ...option("emoji"), required: true }, option("remove", "boolean")], async (i) => {
      renderResource(i, await request(i, "POST", `${messagePath(i)}/reactions`, { emoji: stringOption(i, "emoji"), remove: i.options.remove === true }));
    }),
    spec(["inbox"], "read", [], [option("limit", "integer"), option("cursor")], async (i) => {
      const client = await clientFor(i);
      const result = await client.request({ method: "GET", path: "/api/inbox", query: { limit: integerOption(i, "limit"), cursor: stringOption(i, "cursor") } });
      renderMessages(i, result.data);
    }),
    spec(["inbox", "read"], "write", [ref("conversation")], [option("to", "integer")], async (i) => {
      if (i.positionals[0]?.startsWith("inb_")) throw new CliError("usage", "已移除：改用 remi inbox read <conversation>");
      const to = integerOption(i, "to");
      if (to !== null && to < 0) throw new CliError("usage", "--to must be a non-negative sequence");
      renderResource(i, await request(i, "POST", "/api/inbox/read", { session_id: positional(i, 0, "conversation"), to_seq: to ?? undefined }));
    }),
    spec(["inbox", "read-all"], "write", [], [], async (i) => { renderResource(i, await request(i, "POST", "/api/inbox/read", { all: true })); }),
    spec(["turn", "list"], "read", [], [option("issue"), option("chat"), option("session"), option("agent"), option("status"), option("limit", "integer"), option("cursor")], async (i) => {
      const client = await clientFor(i);
      const result = await client.request({ method: "GET", path: "/api/turns", query: {
        issue: stringOption(i, "issue"), chat: stringOption(i, "chat"), session_id: stringOption(i, "session"), agent: stringOption(i, "agent"),
        status: stringOption(i, "status"), limit: integerOption(i, "limit"), cursor: stringOption(i, "cursor"),
      } });
      renderResource(i, result.data, ["turns"]);
    }),
    spec(["turn", "get"], "read", [ref("turn")], [option("input", "boolean"), option("attempts", "boolean")], async (i) => {
      const client = await clientFor(i);
      const result = await client.request({ method: "GET", path: turnPath(i), query: { input: i.options.input === true, attempts: i.options.attempts === true } });
      new CliRenderer().render(result.data, { mode: outputMode(i) });
    }),
    ...(["cancel", "wrap-up", "retry"] as const).map((action) => spec(["turn", action], action === "wrap-up" ? "write" : "destructive", [ref("turn")], [option("reason"), ...(action === "retry" ? [option("cold", "boolean")] : []), ...(action === "wrap-up" ? [] : [YES_OPTION])], async (i) => {
      if (action !== "wrap-up") requireConfirmation(i);
      renderResource(i, await request(i, "POST", `${turnPath(i)}/${action}`, { reason: stringOption(i, "reason") ?? undefined, ...(action === "retry" ? { cold: i.options.cold === true } : {}) }));
    })),
    spec(["turn", "trace", "read"], "read", [ref("turn")], [option("attempt"), option("after", "integer"), option("limit", "integer")], async (i) => {
      const client = await clientFor(i);
      const result = await client.request({ method: "GET", path: `${turnPath(i)}/trace`, query: { attempt_id: stringOption(i, "attempt"), after_seq: integerOption(i, "after"), limit: integerOption(i, "limit") } });
      new CliRenderer().render(result.data, { mode: outputMode(i) });
    }),
  ];
}

async function send(i: CommandInvocation): Promise<void> {
  const body = content(i) ?? "";
  const attachments = stringOptions(i, "attachment");
  const selected = stringOptions(i, "option");
  if (!body.trim() && !attachments.length && !selected.length) throw new CliError("usage", "message send requires content, an attachment, or an option");
  const kind = stringOption(i, "kind") ?? (stringOption(i, "reply-to") ? "reply" : "request");
  if (!MESSAGE_KINDS.includes(kind as typeof MESSAGE_KINDS[number])) throw new CliError("usage", "invalid --kind");
  const wake = (stringOption(i, "wake") ?? "now").replaceAll("-", "_");
  if (!["now", "next_turn", "inbox_only"].includes(wake)) throw new CliError("usage", "invalid --wake");
  const to = recipient(stringOption(i, "to"), stringOption(i, "to-type"));
  const payload = { body_md: body, to, message_kind: kind, wake_requested: wake, reply_to_id: stringOption(i, "reply-to"),
    dedupe_key: stringOption(i, "dedupe-key"), ...(kind === "decision" ? { options: selected.map(decisionOption) } : selected.length ? { metadata: { selected_options: selected } } : {}) };
  // Validate local files before capability negotiation or any server-side mutation.
  if (attachments.some((path) => /^https?:\/\//i.test(path))) throw new CliError("usage", "--attachment requires a local file path");
  const files: File[] = [];
  for (const path of attachments) {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new CliError("usage", `Attachment ${basename(path)} must be a regular file`);
      if (stat.size > CHAT_ATTACHMENT_MAX_BYTES) throw new CliError("usage", `Attachment ${basename(path)} exceeds the 20MB limit`);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > CHAT_ATTACHMENT_MAX_BYTES) throw new CliError("usage", `Attachment ${basename(path)} exceeds the 20MB limit`);
        chunks.push(chunk);
      }
      if (!size) throw new CliError("usage", `Attachment ${basename(path)} is empty (0 bytes)`);
      const name = basename(path);
      const validationError = chatAttachmentValidationError(name, size);
      if (validationError) throw new CliError("usage", validationError);
      files.push(new File([Buffer.concat(chunks)], name, { type: detectCliContentTypeFromFilename(name) }));
    } finally { await handle.close(); }
  }
  const client = await clientFor(i);
  const conversation = await conversationRef(i, client);
  let requestBody: typeof payload | FormData = payload;
  if (files.length) {
    const form = new FormData();
    form.set("message", JSON.stringify(payload));
    for (const file of files) form.append("file", file);
    requestBody = form;
  }
  const result = await client.request<SendMessageResult>({ method: "POST", path: `/api/sessions/${encodePath(conversation)}/messages`, body: requestBody });
  renderMessages(i, result.data);
  const warning = wakeExplanation(result.data, result.data.message?.to_agent_id ?? stringOption(i, "to") ?? "<agent>");
  if (warning) console.error(warning);
}

export function wakeExplanation(result: Pick<SendMessageResult, "wake_applied" | "wake_reason">, agent: string): string | null {
  if (result.wake_applied === "next_turn") {
    if (result.wake_reason === "agent_pair_not_privileged") return "已降为下一轮：对方不是你的组长或父单负责人";
    if (result.wake_reason === "pair_round_trip_limit") return `已降为下一轮：和 ${agent} 的来回已达 5 次上限，等人介入`;
  }
  if (result.wake_applied === "inbox_only") {
    if (result.wake_reason === "self") return "只留言：不能叫醒自己";
    if (result.wake_reason === "recipient_unavailable") return "只留言：收件人已归档";
  }
  return null;
}

function recipient(value: string | null, type: string | null): MessageRecipient {
  if (type && type !== "agent" && type !== "member") throw new CliError("usage", "--to-type must be agent or member");
  if (type && !value) throw new CliError("usage", "--to-type requires --to");
  if (!value) return { type: "none" };
  const role = value.replaceAll("-", "_");
  if (["leader", "parent_owner", "delegator", "issue_owner", "relay"].includes(role)) return { type: "role", ref: role as Extract<MessageRecipient, { type: "role" }>["ref"] };
  const recipientType = type ?? (value.startsWith("mem_") || value.startsWith("member:") ? "member" : "agent");
  if (recipientType !== "agent" && recipientType !== "member") throw new CliError("usage", "--to-type must be agent or member");
  return { type: recipientType, ref: value.replace(/^(agent|member):/, "") };
}
function decisionOption(value: string): DecisionOption {
  if (value.startsWith("{")) {
    try {
      const option = JSON.parse(value);
      if (typeof option.label === "string" && option.label.trim() && typeof option.value === "string" && option.value.trim()) return option;
    } catch { /* Invalid options are usage errors, before requests. */ }
    throw new CliError("usage", "--option JSON requires label and value");
  }
  return { label: value, value };
}
function content(i: CommandInvocation): string | undefined {
  if (i.options["content-stdin"] === true) return readFileSync(0, "utf8");
  const file = stringOption(i, "content-file");
  return file ? readFileSync(file === "-" ? 0 : file, "utf8") : stringOption(i, "content") ?? undefined;
}
async function conversationRef(i: CommandInvocation, client: Awaited<ReturnType<typeof clientFor>>): Promise<string> {
  const explicit = i.positionals[0]?.trim() || process.env.MULTIREMI_ISSUE_SESSION_ID?.trim()
    || process.env.MULTIREMI_SESSION_ID?.trim() || process.env.MULTIREMI_CHAT_ID?.trim();
  if (explicit) return explicit;
  const { data } = await client.request<{ current?: { session?: { id: string }; chat?: { id: string } } }>({ method: "GET", path: "/api/cli/context" });
  const current = data.current?.session?.id ?? data.current?.chat?.id;
  if (!current) throw new CliError("usage", "No current conversation; supply <conversation>");
  return current;
}
const messagePath = (i: CommandInvocation) => `/api/messages/${encodePath(positional(i, 0, "message"))}`;
const turnPath = (i: CommandInvocation) => `/api/turns/${encodePath(positional(i, 0, "turn"))}`;
async function request(i: CommandInvocation, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  return (await (await clientFor(i)).request({ method, path, body })).data;
}
function renderMessages(i: CommandInvocation, data: unknown): void {
  new CliRenderer().render(data, { mode: outputMode(i), rows: (value) => {
    const record = value as Record<string, unknown>;
    return (Array.isArray(record.messages) ? record.messages : Array.isArray(record.items) ? record.items : [record.message ?? record]) as Record<string, unknown>[];
  }, columns: [
    { header: "ID", value: (row) => String(row.id ?? "-") },
    { header: "CONVERSATION", value: (row) => String(row.session_id ?? "-") },
    { header: "SEQ", value: (row) => String(row.seq ?? "-") },
    { header: "KIND", value: (row) => String(row.message_kind ?? "-") },
    { header: "CONTENT", value: (row) => String(row.body_md ?? ""), maxWidth: 120 },
  ] });
}
