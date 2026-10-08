import { DAEMON_FRAME_MAX_BYTES, DAEMON_OFFER_BUDGET_BYTES } from "@multiremi/contracts/daemon-protocol.js";
import { expandHint, TRIGGER_MESSAGE_INLINE_CHARS } from "@multiremi/contracts/session-input.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MultiremiTaskWithAgent } from "@multiremi/contracts/types.js";
import { taskSessionInput } from "@multiremi/store/task-session-input.js";

type Payload = Record<string, any>;

function prefix(body: string, limit: number): string {
  if (limit > 0 && /[\uD800-\uDBFF]/.test(body[limit - 1] ?? "")) limit--;
  return body.slice(0, limit);
}

/** Normal routing values stay intact; the emergency pass also folds pathological URLs/paths. */
function truncateOfferStrings(response: Payload, runtimeId: string, budget: number, emergency = false): void {
  const protectedKey = /^(?:id|.*[Ii]d|.*_id|auth_token|.*[Tt]oken|.*_token|.*[Pp]ath|.*_path|.*[Uu]rl|.*_url|provider|model|status|type|kind|expand|expand_hint|command|version|created_at|updated_at)$/;
  const identityKey = /^(?:id|.*[Ii]d|.*_id|.*[Tt]oken|.*_token|execution_scope|executionScope|execution_fingerprint|executionFingerprint)$/;
  const candidates: { owner: Payload; key: string; body: string; command: string }[] = [];
  const projections: { owner: Payload; key: string; entries: Payload[] }[] = [];
  const taskCommand = `remi task get ${response.id}`;
  const visit = (value: any, command: string, executionBinding = false) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && (key === "jsonl" || key === "content_jsonl")) {
        const entries = child.split("\n").filter(Boolean).map(line => JSON.parse(line));
        projections.push({ owner: value, key, entries });
        for (const entry of entries) {
          if (entry.type === "triggering_message") visit(entry, entry.expand ?? `remi session log get ${value.session_id} ${entry.seq}`);
        }
      } else if (typeof child === "string" && (!protectedKey.test(key) && !identityKey.test(key) && !executionBinding
        && !["work_dir", "workDir", "prior_work_dir", "priorWorkDir", "branch_name", "branchName", "branch", "executable"].includes(key)
        || emergency && !identityKey.test(key) && child.length > TRIGGER_MESSAGE_INLINE_CHARS
          && (!executionBinding || /(?:url|path|dir)$/i.test(key)))) {
        candidates.push({ owner: value, key, body: child, command });
      } else if (child && typeof child === "object") {
        const source = ["agent", "issue", "project"].includes(key) && (child as Payload).id
          ? `remi ${key} get ${(child as Payload).id}` : command;
        visit(child, source, executionBinding || ["resource_ref", "resourceRef", "runtime_workspace", "codex_profile", "claude_profile",
          "plugin_snapshot", "workspace_env", "custom_env", "custom_args", "mcp_config", "allowed_tools"].includes(key));
      }
    }
  };
  visit(response, taskCommand);
  const sync = () => { for (const projection of projections) projection.owner[projection.key] = projection.entries.map(entry => JSON.stringify(entry)).join("\n"); };
  candidates.sort((a, b) => Buffer.byteLength(JSON.stringify(b.body)) - Buffer.byteLength(JSON.stringify(a.body)));
  for (const { owner, key, body, command } of candidates) {
    if (Buffer.byteLength(JSON.stringify(`\n${expandHint(body.length, command)}`)) >= Buffer.byteLength(JSON.stringify(body))) continue;
    sync();
    const excess = taskOfferBytes(response, runtimeId) - budget;
    if (excess <= 0) return;
    const folded = (limit: number) => {
      const start = prefix(body, limit);
      return `${start}\n${expandHint(body.length - start.length, command)}`;
    };
    const target = Buffer.byteLength(JSON.stringify(body)) - excess;
    if (Buffer.byteLength(JSON.stringify(folded(0))) >= Buffer.byteLength(JSON.stringify(body))) continue;
    let low = 0, high = body.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(folded(mid))) <= target) low = mid;
      else high = mid - 1;
    }
    if (key === "body" && owner.type === "triggering_message") {
      const start = prefix(body, low);
      owner.body = start;
      owner.body_omitted_chars = (owner.body_omitted_chars ?? 0) + body.length - start.length;
      owner.body_folded = true;
      owner.expand = command;
      owner.expand_hint = expandHint(owner.body_omitted_chars, command);
    } else owner[key] = folded(low);
  }
  sync();
}

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
  const readSeq = store.getSessionAgentReadProgress(projection.session_id, task.agentId, task.id).seq;
  const coldStart = projection.mode === "bootstrap";
  projection.jsonl = taskSessionInput({ sessionId: projection.session_id, agentId: task.agentId,
    fromSeq: coldStart ? 0 : Math.min(readSeq, projection.to_seq),
    toSeq: projection.to_seq, entries, triggerSeqs: triggers, coldStart });
  if (triggers.size) response.prompt = "Respond to the triggering messages in Current Session Context. 动手前先读完未读的部分，了解上下文。";
  if (triggers.size) delete response.chat_message;
  delete response.trigger_comment_content;
  response.issue_session_results = [];
  const inherited = response.inherited_session_projection;
  if (inherited?.session_id) {
    inherited.jsonl = taskSessionInput({ sessionId: inherited.session_id, agentId: task.agentId,
      fromSeq: Math.min(store.getSessionAgentReadProgress(inherited.session_id, task.agentId).seq, inherited.to_seq), toSeq: inherited.to_seq,
      entries: store.listConversationLogEntries(inherited.session_id, { toSeq: inherited.to_seq }),
      triggerSeqs: new Set() });
  }
  const bound = response.bound_issue_log;
  if (bound?.session_id) {
    bound.content_jsonl = taskSessionInput({ sessionId: bound.session_id, agentId: task.agentId,
      fromSeq: Math.min(store.getSessionAgentReadProgress(bound.session_id, task.agentId, task.id).seq, bound.to_seq), toSeq: bound.to_seq,
      entries: store.listConversationLogEntries(bound.session_id, { toSeq: bound.to_seq }),
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
    : `${prefix(body, limit)}\n${expandHint(body.length - prefix(body, limit).length, command)}`;
  const promptCommand = `remi task get ${response.id}`;
  const originalPrompt = response.prompt;
  if (typeof response.prompt === "string") response.prompt = fold(response.prompt,
    promptCommand, TRIGGER_MESSAGE_INLINE_CHARS);
  delete response.project_docs;
  const projectLists: Payload[][] = [response.project_wiki_docs ?? [], ...(response.project_contexts ?? []).map((context: Payload) => context.docs ?? [])];
  const repositoryDocs: Payload[] = (response.repository_wiki_contexts ?? []).flatMap((context: Payload) => context.docs ?? []);
  if (supportsWikiFetch) {
    for (const doc of [...projectLists.flat(), ...repositoryDocs]) doc.body = "";
    steps.push("knowledge_metadata");
  } else if (taskOfferBytes(response, runtimeId) > budget) {
    const omitted = new Set<string>();
    for (const doc of [...repositoryDocs, ...projectLists.flat()].sort((a, b) => Buffer.byteLength(b.body ?? "") - Buffer.byteLength(a.body ?? ""))) {
      if (taskOfferBytes(response, runtimeId) <= budget) break;
      if (!doc.body) continue;
      if (repositoryDocs.includes(doc)) {
        doc.body = "";
        doc.status = "unavailable";
        doc.status_message = "Wiki body omitted from task offer budget; Fetch it with remi wiki repository.";
      } else {
        for (const docs of projectLists) {
          for (let index = docs.length - 1; index >= 0; index--) if (docs[index]!.id === doc.id) docs.splice(index, 1);
        }
      }
      omitted.add(doc.id);
    }
    if (omitted.size) warnings.push(`${omitted.size} 页暂不可用，用 remi wiki 取；保留已有本地副本。`);
    steps.push("knowledge");
  }
  for (const limit of [4_000, 1_000, 200]) {
    if (taskOfferBytes(response, runtimeId) <= budget) break;
    for (const key of ["session_projection", "inherited_session_projection"]) {
      const projection = response[key];
      if (!projection?.jsonl) continue;
      projection.jsonl = projection.jsonl.split("\n").map((line: string) => {
        const entry = JSON.parse(line);
        if (entry.type !== "triggering_message" || typeof entry.body !== "string" || entry.body.length <= limit) return line;
        const start = prefix(entry.body, limit);
        entry.body_omitted_chars = (entry.body_omitted_chars ?? 0) + entry.body.length - start.length;
        entry.body = start;
        entry.body_folded = true;
        entry.expand = `remi session log get ${projection.session_id} ${entry.seq}`;
        entry.expand_hint = expandHint(entry.body_omitted_chars, entry.expand);
        return JSON.stringify(entry);
      }).join("\n");
    }
    if (typeof originalPrompt === "string") response.prompt = fold(originalPrompt,
      promptCommand, limit);
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
    if (response.agent) response.agent.skills = [];
    for (const key of ["skills", "project_contexts", "repository_wiki_contexts"]) {
      delete response[key];
    }
    steps.push("optional_context");
  }
  if (taskOfferBytes(response, runtimeId) > budget) {
    truncateOfferStrings(response, runtimeId, budget - 1_024);
    steps.push("strings");
  }
  if (taskOfferBytes(response, runtimeId) > DAEMON_FRAME_MAX_BYTES) {
    truncateOfferStrings(response, runtimeId, budget - 1_024, true);
    steps.push("protected_strings");
  }
  const parts = Object.fromEntries(Object.entries(response)
    .map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value) ?? "null")]));
  const bytes = taskOfferBytes(response, runtimeId);
  return { response, report: { bytes, parts, steps } };
}
