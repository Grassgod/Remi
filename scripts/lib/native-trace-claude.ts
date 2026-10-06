/**
 * Offline projection of an already verified Claude native task slice. The
 * injected bridge is the installed, version/hash-pinned toAcpNotifications
 * export; this module never creates an SDK session or registers live hooks.
 * Prompt/session/task matching belongs to native-trace-match.ts.
 */
import { createAdapter } from "../../packages/acp/src/adapters/index.js";
import type { ProviderEvent } from "../../packages/contracts/src/provider-types.js";
import { taskMessageToTraceEvent, type TraceEvent } from "../../packages/contracts/src/trace.js";
import { createEventMapper } from "../../packages/server/src/worker/acp-event-mapper.js";
import { sanitizeStoredEvent } from "../../packages/server/src/worker/trace-store.js";
import { claudeInformationalText } from "./native-trace-claude-system.js";

type Row = Record<string, any>;
export type ClaudeAcpNotificationMapper = (
  content: any, role: "assistant" | "user", sessionId: string,
  toolUseCache: Row, client: Row, logger: Row, options: Row,
) => readonly { sessionId: string; update: Row }[];

export interface ClaudeNativeTraceOptions {
  providerSessionId: string;
  toAcpNotifications: ClaudeAcpNotificationMapper;
  mapperVersion: string;
  /** Inventory only. A result with unsupported records must not be published. */
  strict?: boolean;
}

export interface ClaudeNativeTraceIssue {
  recordIndex: number;
  type: string;
  reason: string;
}

export interface ClaudeNativeTraceCoverage {
  sourceRecords: number;
  convertedMessages: number;
  convertedBlocks: number;
  duplicateRecords: number;
  toolCalls: number;
  toolResults: number;
  sanitizedEvents: number;
  metadataRecords: Record<string, number>;
  blockTypes: Record<string, number>;
  unsupported: ClaudeNativeTraceIssue[];
  omissions: ClaudeNativeTraceIssue[];
  unpairedToolUseIds: string[];
  unpairedToolResultIds: string[];
  missingParentToolUseIds: string[];
  mapperVersion: string;
}

export interface ClaudeNativeTraceResult {
  events: TraceEvent[];
  coverage: ClaudeNativeTraceCoverage;
}

export class ClaudeNativeTraceConversionError extends Error {
  constructor(readonly coverage: ClaudeNativeTraceCoverage) {
    super(`Native Claude trace conversion rejected ${coverage.unsupported.length} unsupported or mismatched records`);
    this.name = "ClaudeNativeTraceConversionError";
  }
}

const CALL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);
const RESULT_BLOCKS = new Set(["tool_result", "tool_search_tool_result", "web_fetch_tool_result", "web_search_tool_result",
  "code_execution_tool_result", "bash_code_execution_tool_result", "text_editor_code_execution_tool_result", "mcp_tool_result"]);
// These are native harness bookkeeping/context records, not SDK assistant or
// tool-result messages. Every omission is still recorded in the audit report.
const METADATA_RECORDS = new Set(["queue-operation", "atis-latch", "last-prompt", "ai-title", "cost-state", "mode", "pr-link", "file-history-snapshot"]);
const CONTEXT_ATTACHMENTS = new Set(["hook_success", "hook_additional_context", "environment", "model", "agent_listing_delta",
  "skill_listing", "total_tokens_reminder", "async_hook_response", "session_context", "date", "remote_session_change",
  "prompt_snapshot", "silent_turn_reminder", "command_permissions", "todo", "task_reminder", "budget_hint", "changed_files",
  // Native model-input reminders. SDK getSessionMessages filters attachments
  // before toAcpNotifications; retaining their bodies would expose extra input
  // as agent output. Keep a named allowlist so new execution-bearing kinds fail.
  "instructions", "batching_reminder_sent", "edited_text_file", "nested_memory", "queued_command", "read_truncation_notice",
  "compact_file_reference", "file"]);
const SYSTEM_METADATA = new Set(["turn_duration", "stop_hook_summary", "compact_boundary", "microcompact_boundary", "api_error", "api_retry"]);
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

export function convertClaudeNativeTrace(records: readonly unknown[], options: ClaudeNativeTraceOptions): ClaudeNativeTraceResult {
  if (!options.providerSessionId || !options.mapperVersion || typeof options.toAcpNotifications !== "function") {
    throw new Error("Native Claude conversion requires a provider session and a pinned bridge mapper");
  }
  const coverage: ClaudeNativeTraceCoverage = {
    sourceRecords: records.length, convertedMessages: 0, convertedBlocks: 0, duplicateRecords: 0,
    toolCalls: 0, toolResults: 0, sanitizedEvents: 0, metadataRecords: {}, blockTypes: {}, unsupported: [], omissions: [],
    unpairedToolUseIds: [], unpairedToolResultIds: [], missingParentToolUseIds: [], mapperVersion: options.mapperVersion,
  };
  const reject = (recordIndex: number, type: string, reason: string) => coverage.unsupported.push({ recordIndex, type, reason });
  const omit = (recordIndex: number, type: string, reason: string) => coverage.omissions.push({ recordIndex, type, reason });
  const events: TraceEvent[] = [];
  const seenRecords = new Map<string, string>();
  const calls = new Map<string, { at: number; recordIndex: number; name: string }>();
  const results = new Set<string>();
  const parents = new Set<string>();
  const toolUseCache: Row = Object.create(null);
  const taskState = new Map();
  const emittedToolCalls = new Set<string>();
  let currentTime = 0;
  const map = createEventMapper(createAdapter("claude"), { now: () => currentTime });
  const client = new Proxy({}, { get() { return () => { throw new Error("Offline bridge attempted a client operation"); }; } });
  const logger = { log() {}, warn() {}, info() {}, debug() {}, error() { throw new Error("Offline bridge reported an unsupported record"); } };

  records.forEach((value, recordIndex) => {
    const record = row(value);
    const type = text(record?.type) ?? "<missing>";
    if (!record) { reject(recordIndex, type, "record is not an object"); return; }
    if (record.sessionId && record.sessionId !== options.providerSessionId) { reject(recordIndex, type, "provider session mismatch"); return; }
    const uuid = text(record.uuid);
    if (uuid) {
      const fingerprint = JSON.stringify(record);
      const previous = seenRecords.get(uuid);
      if (previous !== undefined) {
        if (previous !== fingerprint) reject(recordIndex, type, "conflicting native record UUID");
        else coverage.duplicateRecords++;
        return;
      }
      seenRecords.set(uuid, fingerprint);
    }
    if (METADATA_RECORDS.has(type)) {
      increment(coverage.metadataRecords, type); omit(recordIndex, type, "native harness bookkeeping is not an ACP execution event"); return;
    }
    if (type === "attachment") {
      const subtype = text(record.attachment?.type) ?? "<missing>";
      if (!CONTEXT_ATTACHMENTS.has(subtype)) reject(recordIndex, `${type}/${subtype}`, "unknown native context attachment");
      else { increment(coverage.metadataRecords, `${type}/${subtype}`); omit(recordIndex, `${type}/${subtype}`, "model context or hook diagnostic, not an SDK assistant/tool-result message"); }
      return;
    }
    if (type === "system") {
      const subtype = text(record.subtype) ?? "<missing>";
      if (subtype === "informational") {
        try {
          const at = Date.parse(record.timestamp);
          if (!uuid || record.sessionId !== options.providerSessionId || !Number.isFinite(at)) throw new Error("informational record lacks explicit identity/timestamp");
          const content = claudeInformationalText(record)!;
          currentTime = at;
          const parentToolUseId = text(record.parent_tool_use_id);
          if (parentToolUseId) parents.add(parentToolUseId);
          for (const message of map({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: content } } as unknown as ProviderEvent)) {
            const ts = new Date(at).toISOString();
            message.meta = { ...message.meta, native_trace: nativeTraceMeta(record, options, uuid), ...(parentToolUseId ? { parent_tool_call_id: parentToolUseId } : {}) };
            events.push({ ...sanitizeStoredEvent(taskMessageToTraceEvent(message, ts), ts), seq: events.length + 1 });
          }
          coverage.convertedMessages++; coverage.convertedBlocks++;
          increment(coverage.blockTypes, "system/informational");
        } catch (error) { reject(recordIndex, `${type}/${subtype}`, error instanceof Error ? error.message : "invalid informational record"); }
      } else if (!SYSTEM_METADATA.has(subtype)) reject(recordIndex, `${type}/${subtype}`, "unknown nontrivial system record");
      else {
        increment(coverage.metadataRecords, `${type}/${subtype}`);
        omit(recordIndex, `${type}/${subtype}`, subtype === "api_error" || subtype === "api_retry"
          // Pinned live bridge: api_retry breaks without sendUpdate; the
          // system default (including native api_error) calls unreachable(),
          // which only logger.error()s. SDK replay excludes system by default.
          ? "API retry diagnostic: installed live bridge logs/ignores it without a trace update"
          : "native bookkeeping has no recorded live ACP notification");
      }
      return;
    }
    if (type !== "assistant" && type !== "user") { reject(recordIndex, type, "unknown native record type"); return; }
    if (!uuid || record.sessionId !== options.providerSessionId) { reject(recordIndex, type, "message lacks explicit native UUID/session identity"); return; }
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) { reject(recordIndex, type, "message has no valid native timestamp"); return; }
    const message = row(record.message);
    if (!message || (message.role && message.role !== type)) { reject(recordIndex, type, "native message role mismatch"); return; }
    const parentToolUseId = text(record.parent_tool_use_id) ?? text(record.parentToolUseId);
    if (record.isSidechain && !parentToolUseId) { reject(recordIndex, type, "subagent message lacks explicit parent tool attribution"); return; }
    if (parentToolUseId) parents.add(parentToolUseId);
    let blocks: Row[];
    if (typeof message.content === "string") blocks = [{ type: "text", text: message.content }];
    else if (Array.isArray(message.content)) blocks = message.content;
    else { reject(recordIndex, type, "native message has no recorded content"); return; }
    const selected: Row[] = [];
    for (const value of blocks) {
      const block = row(value);
      const blockType = text(block?.type) ?? "<missing>";
      increment(coverage.blockTypes, `${type}/${blockType}`);
      if (!block) { reject(recordIndex, blockType, "content block is not an object"); continue; }
      if (type === "user" && ["text", "image", "document"].includes(blockType)) {
        omit(recordIndex, `user/${blockType}`, "user/system input belongs to task input, not execution output"); continue;
      }
      if (blockType === "redacted_thinking" || blockType === "signature_delta") {
        omit(recordIndex, blockType, "encrypted/signature-only reasoning has no recoverable plaintext"); continue;
      }
      if (CALL_BLOCKS.has(blockType)) {
        if (type !== "assistant" || !text(block.id) || !text(block.name) || !row(block.input)) { reject(recordIndex, blockType, "tool call lacks recorded ID/name/object input"); continue; }
        if (calls.has(block.id)) { reject(recordIndex, blockType, "duplicate tool call ID"); continue; }
        calls.set(block.id, { at, recordIndex, name: block.name }); coverage.toolCalls++;
        if (PLAN_TOOLS.has(block.name)) omit(recordIndex, `tool_use/${block.name}`, "bridge represents plan tools as plan snapshots or suppresses read-only plan lookups");
        if (block.name === "Agent" || block.name === "Task") omit(recordIndex, `tool_use/${block.name}`, "only supplied explicitly attributed child records are recovered; separate subagent files are not inferred");
      } else if (RESULT_BLOCKS.has(blockType)) {
        const id = text(block.tool_use_id);
        if (!id) { reject(recordIndex, blockType, "tool result lacks tool-use ID"); continue; }
        const call = calls.get(id);
        if (!call) { coverage.unpairedToolResultIds.push(id); reject(recordIndex, blockType, "tool result has no preceding selected call"); continue; }
        if (results.has(id)) { reject(recordIndex, blockType, "duplicate tool result ID"); continue; }
        if (at < call.at) { reject(recordIndex, blockType, "tool result timestamp precedes call"); continue; }
        if (!("content" in block)) { reject(recordIndex, blockType, "tool result lacks recorded content"); continue; }
        results.add(id); coverage.toolResults++;
      } else if (type === "assistant" && (blockType === "text" || blockType === "thinking")) {
        const field = blockType === "text" ? "text" : "thinking";
        if (typeof block[field] !== "string") { reject(recordIndex, blockType, "text/thinking block lacks plaintext field"); continue; }
        if (!block[field]) { omit(recordIndex, blockType, "empty/signature-only block has no displayable content"); continue; }
      } else { reject(recordIndex, `${type}/${blockType}`, "unsupported nontrivial content block"); continue; }
      selected.push(block);
    }
    if (!selected.length) return;
    try {
      currentTime = at;
      const notifications = options.toAcpNotifications(selected, type, options.providerSessionId, toolUseCache, client, logger, {
        registerHooks: false, taskState, emittedToolCalls, cwd: record.cwd, parentToolUseId,
        messageId: text(message.id) ?? uuid,
        toolUseResult: type === "user" ? record.toolUseResult ?? record.tool_use_result : undefined,
        toolResultMeta: type === "user" ? record.tool_result_meta : undefined,
        clientCapabilities: { _meta: { "terminal_output": false, "subagent-transcript": true } },
      });
      if (!Array.isArray(notifications)) throw new Error("Bridge returned an invalid notification list");
      for (const notification of notifications) {
        if (notification.sessionId !== options.providerSessionId || !row(notification.update)) throw new Error("Bridge notification identity mismatch");
        const su = notification.update.sessionUpdate;
        if (!["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"].includes(su)) throw new Error("Bridge emitted an unsupported notification");
        const mapped = map(notification.update as ProviderEvent);
        if (!mapped.length && su !== "tool_call_update") throw new Error("Bridge notification contains no recoverable Remi event");
        for (const message of mapped) {
          // The live archived trace stores a string result verbatim. The
          // current generic mapper JSON-encodes rawOutput; remove only that
          // provable extra layer, never decode arbitrary native result text.
          if (message.type === "tool_result" && typeof notification.update.rawOutput === "string"
            && message.output === JSON.stringify(notification.update.rawOutput)) {
            message.output = notification.update.rawOutput;
          }
          const ts = new Date(at).toISOString();
          message.meta = { ...message.meta, native_trace: nativeTraceMeta(record, options, uuid) };
          // Native attribution is explicit. Do not retain the live mapper's
          // temporal "an Agent is open" heuristic for unrelated sibling tools.
          if (parentToolUseId) message.meta.parent_tool_call_id = parentToolUseId;
          else delete message.meta.parent_tool_call_id;
          const rawEvent = taskMessageToTraceEvent(message, ts);
          const stored = sanitizeStoredEvent(rawEvent, ts);
          if (["content", "input", "output", "meta"].some(key => JSON.stringify((rawEvent as Row)[key] ?? null) !== JSON.stringify((stored as Row)[key] ?? null))) {
            coverage.sanitizedEvents++;
            omit(recordIndex, message.type, "standard Remi storage sanitization/caps changed recorded event fields");
          }
          events.push({ ...stored, seq: events.length + 1 });
        }
      }
      coverage.convertedMessages++;
      coverage.convertedBlocks += selected.length;
    } catch (error) {
      reject(recordIndex, type, error instanceof Error ? error.message : "bridge conversion failed");
    }
  });
  for (const [id, call] of calls) if (!results.has(id)) {
    coverage.unpairedToolUseIds.push(id); reject(call.recordIndex, "tool_use", "tool call has no selected result");
  }
  for (const id of parents) if (!calls.has(id)) {
    coverage.missingParentToolUseIds.push(id); reject(-1, "subagent", "parent tool call is outside the verified slice");
  }
  if (coverage.unsupported.length && options.strict !== false) throw new ClaudeNativeTraceConversionError(coverage);
  return { events, coverage };
}

function row(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function text(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function increment(counts: Record<string, number>, key: string): void { counts[key] = (counts[key] ?? 0) + 1; }
function nativeTraceMeta(record: Row, options: ClaudeNativeTraceOptions, uuid: string): Row {
  const source = row(record._remiNativeTraceSource);
  return {
    provider: "claude", provider_session_id: options.providerSessionId, native_record_uuid: uuid,
    ...(text(record.parentUuid) ? { native_parent_uuid: record.parentUuid } : {}), mapper_version: options.mapperVersion,
    ...(source ? { native_source_sha256: source.sha256, native_source_line: source.line, native_agent_id: source.agentId } : {}),
  };
}
