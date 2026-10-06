/**
 * Offline Codex history projection. The caller must first prove the provider
 * session and Remi task -> native turn correspondence; this module verifies
 * that identity on every scoped item but never chooses a task by wall clock.
 *
 * Native item_completed snapshots are authoritative. response_item and old
 * event_msg prose/tool records are mirrors and are counted, never replayed a
 * second time. Unknown nontrivial record/item types stop the conversion.
 *
 * The ACP shapes follow codex-acp's CodexToolCallMapper/createHistoryUpdates.
 * File diffs are retained verbatim: unlike the interactive ACP history mapper
 * we never read today's working files to reconstruct historical old/new text.
 * A recovered trace preserves semantic messages and native timestamps, not
 * the original live token chunk boundaries or original Remi sequence numbers.
 */
import { createAdapter } from "../../packages/acp/src/adapters/index.js";
import { fileURLToPath } from "node:url";
import type { ProviderEvent } from "../../packages/contracts/src/provider-types.js";
import { taskMessageToTraceEvent, type TraceEvent } from "../../packages/contracts/src/trace.js";
import { createEventMapper } from "../../packages/server/src/worker/acp-event-mapper.js";
import { sanitizeStoredEvent } from "../../packages/server/src/worker/trace-store.js";

type Row = Record<string, unknown>;
interface RecordedFunctionCall { name: string; input: unknown; output?: unknown; }

export interface CodexNativeTraceOptions {
  providerSessionId: string;
  /** Explicitly verified native turns, possibly several turns after steer. */
  turnIds: readonly string[];
  /** false is for inventory only. Partial conversions must not be published. */
  strict?: boolean;
}

export interface CodexNativeTraceIssue {
  recordIndex: number;
  type: string;
  reason: string;
}

export interface CodexNativeTraceCoverage {
  sourceRecords: number;
  completedItems: number;
  convertedItems: number;
  duplicateItems: number;
  mirroredRecords: Record<string, number>;
  metadataRecords: Record<string, number>;
  itemTypes: Record<string, number>;
  unsupported: CodexNativeTraceIssue[];
  missingToolDurations: number;
}

export interface CodexNativeTraceResult {
  events: TraceEvent[];
  coverage: CodexNativeTraceCoverage;
}

export class CodexNativeTraceConversionError extends Error {
  constructor(readonly coverage: CodexNativeTraceCoverage) {
    super(`Native Codex trace conversion rejected ${coverage.unsupported.length} unsupported or mismatched records`);
    this.name = "CodexNativeTraceConversionError";
  }
}

interface TimedUpdate {
  at: number;
  order: number;
  update: Row;
  turnId: string;
  itemId?: string;
  durationKnown?: boolean;
}

// Usage and thread settings remain on the original task row. These auxiliary
// snapshots can cover earlier turns too, so migration does not replace usage
// totals or claim that replaying one snapshot is a fresh model invocation.
const METADATA_EVENTS = new Set(["task_started", "task_complete", "task_completed", "turn_aborted", "user_message", "token_count", "thread_settings_applied"]);
const MIRROR_EVENTS = new Set(["agent_message", "agent_reasoning", "agent_reasoning_raw_content", "agent_reasoning_section_break",
  "exec_command_begin", "exec_command_end", "exec_command_output_delta", "patch_apply_begin", "patch_apply_end",
  "web_search_begin", "web_search_end", "view_image_tool_call", "context_compacted", "item_started"]);
const MIRROR_RESPONSES = new Set(["message", "reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "web_search_call"]);

/** Fail closed by default; strict:false provides a report for skipped tasks. */
export function convertCodexNativeTrace(records: readonly unknown[], options: CodexNativeTraceOptions): CodexNativeTraceResult {
  if (!options.providerSessionId || !options.turnIds.length || options.turnIds.some(id => !id)) {
    throw new Error("Native Codex conversion requires a provider session and explicit verified turn IDs");
  }
  const allowedTurns = new Set(options.turnIds);
  const coverage: CodexNativeTraceCoverage = {
    sourceRecords: records.length, completedItems: 0, convertedItems: 0, duplicateItems: 0,
    mirroredRecords: {}, metadataRecords: {}, itemTypes: {}, unsupported: [], missingToolDurations: 0,
  };
  const updates: TimedUpdate[] = [];
  // Codex projects request_user_input_async into an AgentMessage whose id is
  // the function call ID. It is the question card's fallback text, not model
  // prose. Its exact response_item call/result pair disambiguates it.
  const functionCalls = new Map<string, RecordedFunctionCall>();
  for (const value of records) {
    const record = row(value), payload = row(record?.payload);
    if (record?.type !== "response_item" || !payload) continue;
    const callId = string(payload.call_id);
    if (!callId) continue;
    if (payload.type === "function_call" && payload.name === "request_user_input_async") {
      const input = typeof payload.arguments === "string" ? parseJson(payload.arguments) : payload.arguments;
      functionCalls.set(callId, { name: payload.name, input });
    } else if (payload.type === "function_call_output" && functionCalls.has(callId)) {
      functionCalls.get(callId)!.output = payload.output;
    }
  }
  const seenItems = new Map<string, string>();
  const completedTurns = new Set<string>();
  const mirroredTurns = new Set<string>();
  let currentTurn: string | undefined;
  const reject = (recordIndex: number, type: string, reason: string) => coverage.unsupported.push({ recordIndex, type, reason });

  records.forEach((value, recordIndex) => {
    const record = row(value);
    const payload = row(record?.payload);
    const type = string(record?.type) ?? "<missing>";
    if (!record || !payload) { reject(recordIndex, type, "record or payload is not an object"); return; }
    if (type === "session_meta") {
      if (payload.id !== options.providerSessionId) reject(recordIndex, type, "provider session mismatch");
      else increment(coverage.metadataRecords, type);
      return;
    }
    const explicitThread = string(payload.thread_id) ?? string(payload.threadId);
    if (explicitThread && explicitThread !== options.providerSessionId) {
      reject(recordIndex, type, "provider session mismatch"); return;
    }
    const explicitTurn = string(payload.turn_id) ?? string(payload.turnId);
    if (explicitTurn && !allowedTurns.has(explicitTurn)) {
      reject(recordIndex, type, "native turn is outside the verified task"); return;
    }
    if (explicitTurn) currentTurn = explicitTurn;
    const turnId = explicitTurn ?? currentTurn;
    if (type === "turn_context" || type === "token_usage_record" || type === "world_state") {
      increment(coverage.metadataRecords, type); return;
    }
    if (type === "response_item") {
      const responseType = string(payload.type) ?? "<missing>";
      if (!MIRROR_RESPONSES.has(responseType)) { reject(recordIndex, `${type}/${responseType}`, "unknown response item"); return; }
      if (!turnId) { reject(recordIndex, type, "mirror has no verified turn context"); return; }
      mirroredTurns.add(turnId);
      increment(coverage.mirroredRecords, `${type}/${responseType}`);
      return;
    }
    if (type === "compacted") { increment(coverage.metadataRecords, type); return; }
    if (type !== "event_msg") { reject(recordIndex, type, "unknown native record type"); return; }
    const eventType = string(payload.type) ?? "<missing>";
    if (METADATA_EVENTS.has(eventType)) { increment(coverage.metadataRecords, eventType); return; }
    if (MIRROR_EVENTS.has(eventType)) {
      if (!turnId) { reject(recordIndex, eventType, "mirror has no verified turn context"); return; }
      mirroredTurns.add(turnId);
      increment(coverage.mirroredRecords, eventType);
      return;
    }
    if (eventType !== "item_completed") { reject(recordIndex, eventType, "unknown native event"); return; }
    coverage.completedItems++;
    // item_completed carries explicit native identity. Inherited context alone
    // is insufficient for publishing it under a Remi task.
    if (!explicitTurn || !explicitThread) { reject(recordIndex, eventType, "completed item lacks explicit thread/turn identity"); return; }
    const item = row(payload.item);
    const itemType = string(item?.type) ?? "<missing>";
    increment(coverage.itemTypes, itemType);
    if (!item) { reject(recordIndex, eventType, "completed item is not an object"); return; }
    const itemId = string(item.id);
    if (itemId) {
      const key = `${explicitTurn}\0${itemId}`;
      const fingerprint = canonical(item);
      const previous = seenItems.get(key);
      if (previous !== undefined) {
        if (previous !== fingerprint) reject(recordIndex, itemType, "conflicting completed snapshots for one item");
        else coverage.duplicateItems++;
        return;
      }
      seenItems.set(key, fingerprint);
    }
    try {
      const end = epoch(payload.completed_at_ms ?? payload.completedAtMs) ?? timestamp(record.timestamp);
      if (end === undefined) throw new Error("completed item has no valid native timestamp");
      const start = epoch(payload.started_at_ms ?? payload.startedAtMs);
      if (start !== undefined && start > end) throw new Error("native start is later than completion");
      const emit = (update: Row, at = end, durationKnown?: boolean) => updates.push({
        update, at, order: updates.length, turnId: explicitTurn, itemId, durationKnown,
      });
      mapCompletedItem(item, start, end, emit, coverage, itemId ? functionCalls.get(itemId) : undefined);
      completedTurns.add(explicitTurn);
      coverage.convertedItems++;
    } catch (error) {
      reject(recordIndex, itemType, error instanceof Error ? error.message : "unsupported item");
    }
  });
  for (const turnId of mirroredTurns) {
    if (!completedTurns.has(turnId)) reject(-1, "mirror", "verified turn has mirrors but no authoritative completed items");
  }
  if (coverage.unsupported.length && options.strict !== false) throw new CodexNativeTraceConversionError(coverage);

  let currentTime = 0;
  const map = createEventMapper(createAdapter("codex"), { now: () => currentTime });
  const events: TraceEvent[] = [];
  updates.sort((left, right) => left.at - right.at || left.order - right.order);
  for (const timed of updates) {
    currentTime = timed.at;
    const ts = new Date(timed.at).toISOString();
    for (const message of map(timed.update as unknown as ProviderEvent)) {
      if (timed.durationKnown === false && message.meta) delete message.meta.duration_ms;
      message.meta = { ...message.meta, native_trace: {
        provider: "codex", provider_session_id: options.providerSessionId, turn_id: timed.turnId,
        ...(timed.itemId ? { item_id: timed.itemId } : {}),
      } };
      events.push({ ...sanitizeStoredEvent(taskMessageToTraceEvent(message, ts), ts), seq: events.length + 1 });
    }
  }
  return { events, coverage };
}

function mapCompletedItem(
  item: Row, start: number | undefined, end: number,
  emit: (update: Row, at?: number, durationKnown?: boolean) => void,
  coverage: CodexNativeTraceCoverage,
  functionCall?: RecordedFunctionCall,
): void {
  const type = normalized(string(item.type) ?? "");
  if (type === "usermessage") return;
  if (type === "agentmessage") {
    if (functionCall) {
      const input = row(functionCall.input);
      if (!input || !Array.isArray(input.questions) || functionCall.output === undefined) {
        throw new Error("native question card lacks its exact function call/result pair");
      }
      const durationKnown = start !== undefined;
      if (!durationKnown) coverage.missingToolDurations++;
      emit({ sessionUpdate: "tool_call", toolCallId: item.id, kind: "other", title: "AskUserQuestion", status: "in_progress",
        rawInput: { name: "AskUserQuestion", ...input } }, start ?? end, durationKnown);
      emit({ sessionUpdate: "tool_call_update", toolCallId: item.id, status: "completed",
        rawOutput: functionCall.output }, end, durationKnown);
      increment(coverage.metadataRecords, "item/question_card_from_function_call");
      return;
    }
    if (!("content" in item) && !("text" in item)) throw new Error("agent message lacks recorded content");
    for (const text of textParts(item.content ?? item.text)) emit({
      sessionUpdate: "agent_message_chunk", content: { type: "text", text },
      ...(item.phase ? { _meta: { codex: { phase: item.phase } } } : {}),
    });
    return;
  }
  if (type === "reasoning") {
    if (!["summary", "summary_text", "content", "text", "raw_content"].some(key => key in item)) {
      throw new Error("reasoning item lacks a supported recorded content field");
    }
    const summary = textParts(item.summary ?? item.summary_text);
    for (const text of summary.length ? summary : textParts(item.content ?? item.text ?? item.raw_content)) emit({
      // The bridge emits summaryPartAdded as two newlines before each native
      // summary part, including the first. This also matches archived live
      // traces after stream chunks are concatenated.
      sessionUpdate: "agent_thought_chunk", content: { type: "text", text: summary.length ? `\n\n${text}` : text },
    });
    return;
  }
  const id = string(item.id);
  if (!id) throw new Error("tool item lacks a stable tool call ID");
  const emitTool = (kind: string, title: string, input: Row, output?: unknown, locations?: Row[]) => {
    const status = item.status === undefined ? "completed" : toolStatus(item.status);
    const durationKnown = start !== undefined;
    if (!durationKnown) coverage.missingToolDurations++;
    emit({ sessionUpdate: "tool_call", toolCallId: id, kind, title, status: "in_progress", rawInput: input,
      ...(locations?.length ? { locations } : {}) }, start ?? end, durationKnown);
    emit({ sessionUpdate: "tool_call_update", toolCallId: id, status, ...(output !== undefined ? { rawOutput: output } : {}) }, end, durationKnown);
  };
  switch (type) {
    case "commandexecution": {
      const command = item.command;
      if (typeof command !== "string" && !(Array.isArray(command) && command.every(part => typeof part === "string"))) {
        throw new Error("command execution lacks a command");
      }
      const actions = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : Array.isArray(item.commandActions) ? item.commandActions : [];
      const action = actions.length === 1 ? row(actions[0]) : undefined;
      const actionType = string(action?.type);
      const displayCommand = typeof command === "string" ? command : shellCommand(command as string[]);
      const commandText = string(action?.cmd) ?? string(action?.command) ?? displayCommand;
      const input: Row = { command: commandText, cwd: nativePath(item.cwd), ...(Array.isArray(command) ? { argv: command } : {}) };
      let kind = "execute", title = commandText;
      const locations: Row[] = [];
      if (actionType === "read") {
        kind = "read";
        const path = string(nativePath(action?.path));
        if (!path) throw new Error("native read action lacks recorded path");
        title = `Read file '${path}'`; input.file_path = path; locations.push({ path });
      } else if (actionType === "search") {
        kind = "search"; title = "Search files";
        if (typeof action?.query === "string") input.query = action.query;
        if (typeof action?.path === "string") input.path = nativePath(action.path);
      } else if (actionType === "list_files" || actionType === "listFiles") {
        kind = "read"; title = "List files";
        if (typeof action?.path === "string") input.path = nativePath(action.path);
      } else if (actionType && actionType !== "unknown") {
        throw new Error("unknown native command action");
      }
      emitTool(kind, title, input, {
        // formatted_output is Codex's model-facing truncated rendering.
        // app-server/ACP use aggregatedOutput, which preserves terminal bytes.
        formatted_output: item.aggregated_output ?? item.aggregatedOutput ?? item.formatted_output ?? item.formattedOutput ?? item.stdout ?? "",
        exit_code: item.exit_code ?? item.exitCode ?? null,
        ...(typeof item.stderr === "string" && item.stderr ? { stderr: item.stderr } : {}),
      }, locations);
      return;
    }
    case "filechange": {
      const changes = item.changes;
      if (!Array.isArray(changes) && !row(changes)) throw new Error("file change lacks recorded changes");
      const paths = Array.isArray(changes)
        ? changes.map(change => string(row(change)?.path)).filter((path): path is string => Boolean(path))
        : Object.keys(changes as Row);
      emitTool("edit", "Editing files", { changes }, { changes, ...(item.stdout ? { stdout: item.stdout } : {}),
        ...(item.stderr ? { stderr: item.stderr } : {}) }, paths.map(path => ({ path })));
      return;
    }
    case "extension":
    case "websearch": {
      if (type === "extension" && normalized(string(item.kind) ?? "") === "clocksleep") {
        // codex-acp createHistoryUpdates returns [] for ThreadItem.sleep, as
        // does the live item handler. Keep the omission explicit in the audit.
        if (typeof item.durationMs !== "number" || item.durationMs < 0) throw new Error("invalid native sleep duration");
        increment(coverage.metadataRecords, "item/clock.sleep");
        return;
      }
      if (type === "extension" && normalized(string(item.kind) ?? "") !== "websearch") throw new Error("unsupported extension kind");
      emitTool("search", `Web Search ${string(item.query) ?? ""}`.trim(), { name: "web_search", query: item.query, action: item.action },
        item.results === undefined ? undefined : { results: item.results });
      return;
    }
    case "imageview": {
      const path = string(nativePath(item.path));
      if (!path) throw new Error("image view lacks a recorded path");
      emitTool("read", `View Image ${path}`, { path }, undefined, [{ path }]);
      return;
    }
    case "contextcompaction":
      emitTool("other", "Compact conversation", {}, item.summary === undefined ? undefined : { summary: item.summary });
      return;
    default: throw new Error("unsupported completed item type");
  }
}

function toolStatus(value: unknown): string {
  switch (normalized(string(value) ?? "")) {
    case "completed": case "success": return "completed";
    case "failed": case "declined": case "error": return "failed";
    case "cancelled": case "canceled": return "cancelled";
    default: throw new Error("completed tool item has unknown or nonterminal status");
  }
}
function textParts(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) throw new Error("unsupported prose content shape");
  return value.flatMap(part => {
    if (typeof part === "string") return part ? [part] : [];
    const object = row(part);
    if (typeof object?.text === "string") return object.text ? [object.text] : [];
    throw new Error("unsupported nontext prose block");
  });
}
function row(value: unknown): Row | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function normalized(value: string): string { return value.replace(/[_.-]/g, "").toLowerCase(); }
function epoch(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : undefined; }
function timestamp(value: unknown): number | undefined { if (typeof value !== "string") return undefined; const result = Date.parse(value); return Number.isFinite(result) ? result : undefined; }
function increment(counts: Record<string, number>, key: string): void { counts[key] = (counts[key] ?? 0) + 1; }
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
function shellCommand(argv: string[]): string {
  return argv.map(part => /^[A-Za-z0-9_/:=+.,@%-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
}
/** Codex native paths are file URLs; app-server/ACP expose filesystem paths. */
function nativePath(value: unknown): unknown {
  return typeof value === "string" && value.startsWith("file:") ? fileURLToPath(value) : value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = row(value);
  return object ? `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}` : JSON.stringify(value);
}
