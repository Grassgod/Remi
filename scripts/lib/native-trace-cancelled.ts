import { fileURLToPath } from "node:url";
import { sha256, type NativeRecord } from "./native-trace-match.js";

/** Narrow exception for a cancelled task whose start acknowledgement was lost. */
export interface CancelledCodexTask {
  id: string;
  provider: "codex";
  workspaceId: string;
  runtimeId: string;
  agentId: string;
  nativeSessionId: string;
  workDir: string;
  prompt: string;
  status: "cancelled";
  startedAt: null;
  createdAt: string;
  cancelledAt: string;
}

export interface CancelledNativeTaskWitness {
  line: number;
  itemId: string;
  kind: "remi-context-current-task" | "remi-message-task-id";
  path: "current.task.id" | "task.id" | "task_id" | "message.taskId";
  outputSha256: string;
  /** A native output cap can truncate later context fields after the task ID. */
  truncatedJsonSuffix: boolean;
}

export interface CancelledCodexMatch {
  records: NativeRecord[];
  proof: {
    method: "cancelled-session-prompt-explicit-task-id-native-terminal";
    taskId: string;
    nativeSessionId: string;
    turnIds: [string];
    firstLine: number;
    lastLine: number;
    promptSha256: string;
    nativeOutputSha256: string;
    nativeStartedAt: string;
    nativeCompletedAt: string;
    databaseSessionTaskIds: [string];
    explicitTaskWitnesses: CancelledNativeTaskWitness[];
  };
}

export class CancelledNativeRecoveryMismatch extends Error {
  constructor(readonly code: string) { super(code); this.name = "CancelledNativeRecoveryMismatch"; }
}

/**
 * Caller supplies ALL database task IDs owning this workspace/runtime/provider
 * session, not just migration candidates. Import rechecks this same unique
 * ownership against the database before publication. No status/result is
 * synthesized: the source proves an executed turn, the server remains cancelled.
 */
export function matchCancelledCodexTask(
  records: readonly NativeRecord[],
  task: CancelledCodexTask,
  databaseSessionTaskIds: readonly string[],
): CancelledCodexMatch {
  const reject = (code: string): never => { throw new CancelledNativeRecoveryMismatch(code); };
  if (task.status !== "cancelled" || task.provider !== "codex" || task.startedAt !== null
    || ![task.id, task.workspaceId, task.runtimeId, task.agentId, task.nativeSessionId, task.workDir, task.prompt].every(v => typeof v === "string" && v.trim())) {
    reject("cancelled_null_start_identity_required");
  }
  if (databaseSessionTaskIds.length !== 1 || databaseSessionTaskIds[0] !== task.id) reject("provider_session_not_uniquely_owned");
  const from = Date.parse(task.createdAt), to = Date.parse(task.cancelledAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) reject("invalid_cancelled_task_interval");
  const metas = records.filter(r => r.value.type === "session_meta");
  if (metas.length !== 1 || metas[0]!.value.payload?.id !== task.nativeSessionId) reject("native_session_mismatch");
  if (nativePath(metas[0]!.value.payload?.cwd) !== nativePath(task.workDir)) reject("native_workdir_mismatch");
  const starts = records.filter(r => r.value.type === "event_msg" && r.value.payload?.type === "task_started");
  const ends = records.filter(r => r.value.type === "event_msg" && r.value.payload?.type === "task_complete");
  if (starts.length !== 1 || ends.length !== 1) reject("exactly_one_complete_native_turn_required");
  const start = starts[0]!, end = ends[0]!;
  const turnId = start.value.payload.turn_id;
  if (typeof turnId !== "string" || !turnId || end.value.payload.turn_id !== turnId || start.line >= end.line) reject("native_terminal_mismatch");
  const begin = Date.parse(start.value.timestamp), finish = Date.parse(end.value.timestamp);
  if (!Number.isFinite(begin) || !Number.isFinite(finish) || begin < from || finish > to || begin >= finish) reject("native_turn_outside_cancelled_task");
  const selected = records.filter(r => r.line >= start.line && r.line <= end.line);
  const items: NativeRecord[] = [];
  for (const record of selected) {
    const r = record.value, p = r.payload;
    const at = Date.parse(r.timestamp);
    if (!Number.isFinite(at) || at < begin || at > finish) reject("native_record_outside_turn");
    if (p?.thread_id && p.thread_id !== task.nativeSessionId) reject("native_session_mismatch");
    if (p?.turn_id && p.turn_id !== turnId) reject("interleaved_native_turns");
    if (r.type === "turn_context" && nativePath(p?.cwd) !== nativePath(task.workDir)) reject("native_workdir_mismatch");
    if (r.type === "event_msg" && p?.type === "item_completed") {
      if (p.thread_id !== task.nativeSessionId || p.turn_id !== turnId) reject("item_lacks_explicit_identity");
      if (typeof p.started_at_ms !== "number" || typeof p.completed_at_ms !== "number"
        || p.started_at_ms < begin || p.completed_at_ms > finish || p.started_at_ms > p.completed_at_ms) reject("item_outside_native_turn");
      items.push(record);
    }
  }
  const users = selected.filter(r => r.value.type === "response_item" && r.value.payload?.role === "user");
  const anchors = users.filter(r => contentText(r.value.payload.content).includes(task.prompt));
  if (anchors.length !== 1) reject("unique_prompt_anchor_required");
  const anchor = anchors[0]!;
  // Codex records an environment snapshot before the real user prompt. It is
  // context, not a second instruction. Any other user input requires a broader
  // multi-turn proof and is outside this narrow cancelled-task path.
  for (const user of users) if (user !== anchor) {
    const text = contentText(user.value.payload.content).trim();
    if (user.line >= anchor.line || !text.startsWith("<environment_context>") || !text.endsWith("</environment_context>")) reject("unverified_additional_user_input");
  }
  const userItems = items.filter(r => r.value.payload.item?.type === "UserMessage");
  if (userItems.length !== 1 || contentText(userItems[0]!.value.payload.item.content) !== contentText(anchor.value.payload.content)) reject("native_user_item_mismatch");
  const assistant = selected.filter(r => r.value.type === "response_item" && r.value.payload?.role === "assistant");
  const lastItem = items.filter(r => r.value.payload.item?.type === "AgentMessage").at(-1);
  const final = contentText(lastItem?.value.payload.item.content);
  if (!final || !assistant.length || end.value.payload.last_agent_message !== final
    || contentText(assistant.at(-1)!.value.payload.content) !== final) reject("native_final_anchor_mismatch");
  const witnesses: CancelledNativeTaskWitness[] = [];
  for (const record of items) {
    const item = record.value.payload.item;
    if (item?.type !== "CommandExecution" || item.status !== "completed" || item.exit_code !== 0) continue;
    const command = commandText(item.command);
    const output = typeof item.aggregated_output === "string" ? item.aggregated_output : item.stdout;
    if (!command || typeof output !== "string") continue;
    if (/^(?:[A-Za-z0-9_./:-]+\/)?remi\s+context(?:\s+--(?:output\s+json|json))?\s*$/.test(command)) {
      const parsed = readCurrentTaskJsonPrefix(output);
      if (!parsed) continue;
      const ids = [parsed.currentTaskId, parsed.taskId, parsed.rootTaskId].filter(value => value !== undefined);
      if (ids.some(id => id !== task.id)) reject("context_current_task_mismatch");
      const direct = parsed.currentTaskId ?? parsed.taskId ?? parsed.rootTaskId;
      if (direct === task.id) witnesses.push({ line: record.line, itemId: item.id, kind: "remi-context-current-task",
        path: parsed.currentTaskId !== undefined ? "current.task.id" : parsed.taskId !== undefined ? "task.id" : "task_id",
        outputSha256: sha256(output), truncatedJsonSuffix: parsed.truncated });
    } else if (/^(?:[A-Za-z0-9_./:-]+\/)?remi\s+/.test(command)) {
      // A newly authored message's taskId ties the tool credential to this task;
      // arbitrary quoted IDs, list results and parentTaskId do not count.
      let value: any;
      try { value = JSON.parse(output); } catch { continue; }
      if (value?.message?.taskId === task.id) witnesses.push({ line: record.line, itemId: item.id,
        kind: "remi-message-task-id", path: "message.taskId", outputSha256: sha256(output), truncatedJsonSuffix: false });
    }
  }
  if (!witnesses.some(w => w.kind === "remi-context-current-task") || !witnesses.some(w => w.kind === "remi-message-task-id")) {
    reject("independent_structured_task_id_witnesses_required");
  }
  return { records: selected, proof: {
    method: "cancelled-session-prompt-explicit-task-id-native-terminal", taskId: task.id, nativeSessionId: task.nativeSessionId,
    turnIds: [turnId], firstLine: start.line, lastLine: end.line, promptSha256: sha256(task.prompt),
    nativeOutputSha256: sha256(assistant.map(r => contentText(r.value.payload.content)).join("")),
    nativeStartedAt: start.value.timestamp, nativeCompletedAt: end.value.timestamp,
    databaseSessionTaskIds: [task.id], explicitTaskWitnesses: witnesses,
  } };
}

/**
 * Parse actual JSON syntax, permitting only an unfinished suffix. Tool stdout
 * can be capped after an already complete `.task.id` string. No substring or
 * regex matching of message bodies counts as identity. Duplicate keys and any
 * malformed syntax fail, even after a matching field was seen.
 */
export function readCurrentTaskJsonPrefix(text: string): { currentTaskId?: string; taskId?: string; rootTaskId?: string; truncated: boolean } | null {
  const incomplete = Symbol("incomplete-json");
  let cursor = 0;
  const found: { currentTaskId?: string; taskId?: string; rootTaskId?: string; truncated: boolean } = { truncated: false };
  const whitespace = () => { while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++; };
  const need = (): string => { if (cursor >= text.length) throw incomplete; return text[cursor]!; };
  const quoted = (): string => {
    const from = cursor;
    if (need() !== '"') throw new Error("not a JSON string");
    cursor++;
    let escaped = false;
    for (;;) {
      const c = need(); cursor++;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') return JSON.parse(text.slice(from, cursor));
    }
  };
  const value = (path: string[], depth: number): void => {
    if (depth > 100) throw new Error("JSON nesting limit");
    whitespace();
    const c = need();
    if (c === '"') {
      const result = quoted();
      if (path.length === 3 && path[0] === "current" && path[1] === "task" && path[2] === "id") found.currentTaskId = result;
      if (path.length === 2 && path[0] === "task" && path[1] === "id") found.taskId = result;
      if (path.length === 1 && path[0] === "task_id") found.rootTaskId = result;
      return;
    }
    if (c === "{" || c === "[") {
      const object = c === "{", end = object ? "}" : "]", keys = new Set<string>();
      cursor++; whitespace();
      if (need() === end) { cursor++; return; }
      for (let index = 0;; index++) {
        let key = String(index);
        if (object) {
          key = quoted();
          if (keys.has(key)) throw new Error("duplicate JSON key");
          keys.add(key); whitespace();
          if (need() !== ":") throw new Error("missing colon");
          cursor++;
        }
        value([...path, key], depth + 1); whitespace();
        const separator = need(); cursor++;
        if (separator === end) return;
        if (separator !== ",") throw new Error("missing comma");
        whitespace();
      }
    }
    const from = cursor;
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor]!)) cursor++;
    const token = text.slice(from, cursor);
    if (cursor === text.length) {
      // EOF inside a valid number/literal prefix is truncation; arbitrary
      // garbage after a real task ID is malformed JSON, not evidence.
      if (["true", "false", "null"].some(literal => literal.startsWith(token))
        || /^-?(?:0|[1-9]\d*)(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(token)) throw incomplete;
      throw new Error("invalid partial JSON token");
    }
    JSON.parse(token);
  };
  try {
    whitespace();
    if (need() !== "{") return null;
    value([], 0); whitespace();
    if (cursor !== text.length) return null;
  } catch (error) {
    if (error !== incomplete) return null;
    found.truncated = true;
  }
  return found;
}

function nativePath(value: unknown): unknown { return typeof value === "string" && value.startsWith("file:") ? fileURLToPath(value) : value; }
function contentText(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? value.flatMap(v => typeof v?.text === "string" ? [v.text] : []).join("") : "";
}
function commandText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length !== 3 || typeof value[2] !== "string"
    || !/(?:^|\/)(?:ba|z)?sh$/.test(value[0]) || !/^-[lc]+$/.test(value[1])) return undefined;
  return value[2];
}
