import { DAEMON_FRAME_MAX_BYTES, DAEMON_OFFER_BUDGET_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { expandHint, TRIGGER_MESSAGE_INLINE_CHARS } from "@multiremi/contracts/session-input.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import { taskSessionInput } from "@multiremi/store/task-session-input.js";
import { createHash } from "node:crypto";

type Payload = Record<string, any>;

export function useTaskSessionInput(store: MultiremiStore, task: MultiremiTaskWithAgent, response: Payload): void {
  const projection = response.session_projection;
  if (!projection?.session_id) return;
  const entries = store.listConversationLogEntries(projection.session_id, { toSeq: projection.to_seq });
  const triggers = new Set(store.getTaskWakeSequences(task.id));
  if (task.chatSessionId) {
    for (const entry of entries) {
      if (entry.kind === "message" && (entry.task_id === task.id || entry.metadata.agent_delivery_task_id === task.id)) {
        triggers.add(entry.seq);
      }
    }
  }
  for (const entry of entries) {
    if (!triggers.size && entry.kind === "turn" && entry.task_id === task.id) triggers.add(entry.seq);
  }
  projection.jsonl = taskSessionInput({ sessionId: projection.session_id, agentId: task.agentId,
    fromSeq: projection.from_seq, toSeq: projection.to_seq, entries, triggerSeqs: triggers });
  if (triggers.size) response.prompt = "Respond to the triggering messages in Current Session Context. 动手前先读完未读的部分，了解上下文。";
  if (triggers.size) delete response.chat_message;
  delete response.trigger_comment_content;
  response.issue_session_results = [];
  const inherited = response.inherited_session_projection;
  if (inherited?.session_id) {
    inherited.jsonl = taskSessionInput({ sessionId: inherited.session_id, agentId: task.agentId,
      fromSeq: inherited.from_seq, toSeq: inherited.to_seq,
      entries: store.listConversationLogEntries(inherited.session_id, { sinceSeq: inherited.from_seq, toSeq: inherited.to_seq }),
      triggerSeqs: new Set() });
  }
  const bound = response.bound_issue_log;
  if (bound?.session_id) {
    bound.content_jsonl = taskSessionInput({ sessionId: bound.session_id, agentId: task.agentId,
      fromSeq: bound.from_seq, toSeq: bound.to_seq,
      entries: store.listConversationLogEntries(bound.session_id, { sinceSeq: bound.from_seq, toSeq: bound.to_seq }),
      triggerSeqs: new Set() });
  }
}

export function taskOfferBytes(response: Payload, runtimeId: string): number {
  // Include room for protocol sequence, timestamp, acknowledgement and auth metadata.
  return Buffer.byteLength(JSON.stringify({ v: 2, t: "task.offer", rt: runtimeId, p: response })) + 1_024;
}

export function fitTaskOfferToBudget(response: Payload, runtimeId: string, budget = DAEMON_OFFER_BUDGET_BYTES, supportsWikiFetch = false): {
  response: Payload; report: { bytes: number; parts: Record<string, number>; steps: string[] };
} {
  const steps: string[] = [];
  const warnings = response.knowledge_warnings = [...(response.knowledge_warnings ?? [])];
  const fold = (body: string, command: string, limit: number): string => body.length <= limit ? body
    : `${body.slice(0, limit)}\n${expandHint(body.length - limit, command)}`;
  const sessionId = response.issue_session_id ?? response.chat_session_id;
  if (typeof response.prompt === "string") response.prompt = fold(response.prompt,
    sessionId ? `remi session log get ${sessionId} --from 0 --to ${response.session_projection?.to_seq ?? 0}`
      : `remi task get ${response.id}`, TRIGGER_MESSAGE_INLINE_CHARS);
  // Knowledge bodies travel over HTTP after claim; legacy daemons get directories and fetch hints.
  for (const context of response.repository_wiki_contexts ?? []) {
    for (const doc of context.docs ?? []) {
      if (supportsWikiFetch && typeof doc.body === "string") doc.content_sha256 = createHash("sha256").update(doc.body).digest("hex");
      if (doc.body) {
        doc.body = "";
        if (!supportsWikiFetch) {
          doc.status = "unavailable";
          doc.status_message = "Wiki body omitted from task offer; Fetch it with remi wiki repository.";
        }
      }
    }
  }
  response.project_wiki_docs = supportsWikiFetch ? (response.project_wiki_docs ?? []).map((doc: Payload) => ({
    ...doc, content_sha256: createHash("sha256").update(doc.body ?? "").digest("hex"), body: "",
  })) : [];
  delete response.project_docs;
  for (const context of response.project_contexts ?? []) context.docs = supportsWikiFetch
    ? (context.docs ?? []).map((doc: Payload) => ({ ...doc,
      content_sha256: createHash("sha256").update(doc.body ?? "").digest("hex"), body: "" })) : [];
  warnings.push("Wiki bodies omitted from task offer. The daemon fetches them separately; use remi wiki if unavailable.");
  steps.push("knowledge");
  for (const limit of [4_000, 1_000, 200]) {
    if (taskOfferBytes(response, runtimeId) <= budget) break;
    for (const key of ["session_projection", "inherited_session_projection"]) {
      const projection = response[key];
      if (!projection?.jsonl) continue;
      projection.jsonl = projection.jsonl.split("\n").map((line: string) => {
        const entry = JSON.parse(line);
        if (entry.type !== "triggering_message" || typeof entry.body !== "string" || entry.body.length <= limit) return line;
        entry.body_omitted_chars = (entry.body_omitted_chars ?? 0) + entry.body.length - limit;
        entry.body = entry.body.slice(0, limit);
        entry.body_folded = true;
        entry.expand = `remi session log get ${projection.session_id} ${entry.seq}`;
        entry.expand_hint = expandHint(entry.body_omitted_chars, entry.expand);
        return JSON.stringify(entry);
      }).join("\n");
    }
    if (typeof response.prompt === "string") response.prompt = fold(response.prompt,
      sessionId ? `remi session log get ${sessionId} --from 0 --to ${response.session_projection?.to_seq ?? 0}` : `remi task get ${response.id}`, limit);
    steps.push(`triggers:${limit}`);
  }
  if (taskOfferBytes(response, runtimeId) > budget) {
    for (const [key, command] of [["issue", `remi issue get ${response.issue?.id}`], ["project", `remi project get ${response.project?.id}`]]) {
      if (typeof response[key]?.description === "string") response[key].description = fold(response[key].description, command!, 2_000);
    }
    steps.push("descriptions");
  }
  if (taskOfferBytes(response, runtimeId) > budget) {
    warnings.push("Large optional execution context omitted; retrieve relevant context using remi CLI.");
    for (const key of ["plugin_snapshot", "skills", "project_contexts", "repository_wiki_contexts", "project_resources"]) {
      delete response[key];
    }
    steps.push("optional_context");
  }
  const parts = Object.fromEntries(Object.entries(response).filter(([key]) => key !== "auth_token")
    .map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value) ?? "null")]));
  const bytes = taskOfferBytes(response, runtimeId);
  if (bytes > DAEMON_FRAME_MAX_BYTES) warnings.push("Task offer still exceeds transport capacity; it will remain queued.");
  return { response, report: { bytes, parts, steps } };
}
