/**
 * ACP session updates and daemon-internal facts -> turn + items trace events
 * (PR 2 §2). One translator per task attempt; it is the only writer of the
 * attempt's events, so permission, question and steer facts are ordered with the
 * provider stream by construction: every call flushes pending deltas first.
 *
 * Vendor `_meta` reading lives in `@acp/adapters/trace-vendor.js`; the fold, the
 * final-reply rule and the caps are the shared ones (`@shared/turn-trace.js`,
 * `@shared/trace-sanitize.js`). `turn.completed` is not emitted here:
 * `DaemonTraceTransport.close()` writes it, so a steer re-prompt after a failed
 * `completeTurn` can keep appending to the same turn.
 */
import type { AgentAdapter } from "@acp/index.js";
import {
  CLAUDE_SUBAGENT_TOOLS,
  classifyTool,
  endsWithAbortMarker,
  compactionFacts,
  contentText,
  diffChanges,
  mergeToolFacts,
  messageId as frameMessageId,
  messagePhase,
  noticeFields,
  parentToolUseId,
  toolLabel,
  readSessionFailure,
  sessionFailureNotice,
  terminalChunk,
  terminalExit,
  type ToolClass,
  type ToolFacts,
  type VendorFrame,
} from "@acp/adapters/trace-vendor.js";
import type { ProviderEvent } from "@shared/contracts/provider-types.js";
import type { PermissionOption } from "@shared/contracts/acp-protocol.js";
import type { MultiremiTaskSteerMessage } from "@multiremi/contracts/types.js";
import type { UnifiedMessage } from "@multiremi/contracts/unified-model.js";
import type {
  CommandAction,
  TraceAgentMessageItem,
  TraceCompactionItem,
  TraceContextUsage,
  TraceEventInput,
  TraceItem,
  TraceItemStatus,
  TracePlanItem,
  TraceReasoningItem,
  TraceSteerResult,
  TraceTurn,
} from "@multiremi/contracts/trace.js";
import { readExecutionModel } from "@shared/agent-execution.js";
import { parseCommand } from "@shared/command-parse.js";
import {
  TRACE_ITEM_OUTPUT_HEAD_BYTES,
  TRACE_ITEM_OUTPUT_MAX_BYTES,
  TRACE_ITEM_OUTPUT_TAIL_BYTES,
  TRACE_ITEM_REASONING_MAX_BYTES,
  TRACE_ITEM_TEXT_MAX_BYTES,
  TRACE_TRUNCATION_MARKER,
  capItemText,
  capLabel,
  capTraceItem,
  utf8ByteLength,
} from "@shared/trace-sanitize.js";
import { selectFinalReply } from "@shared/turn-trace.js";

/** A native steer error is a short diagnostic: label-sized, like a tool name. */
function steerError(error: string | null): string | null {
  return error === null ? null : capLabel(error);
}

/** Coalescing constants, kept from the retired `TaskMessageBatcher`. */
export const TRACE_DELTA_FLUSH_INTERVAL_MS = 200;
export const TRACE_DELTA_BUFFER_BYTES = 16 * 1024;
export const TRACE_DELTA_MAX_BYTES = 64 * 1024;

export interface TraceTranslatorOptions {
  /** ISO clock for item and turn timestamps. */
  now?: () => string;
  /** Millisecond clock for `duration_ms`. */
  nowMs?: () => number;
  /** Applied to agent message text before it is recorded (legacy provider failures). */
  redactText?: (text: string) => string;
  /**
   * A message chunk that is its own message: legacy (untyped) providers report a
   * failure as unmarked message text, often after earlier text with no message
   * id, and the daemon's legacy failure check reads the last message alone.
   */
  standaloneText?: (text: string) => boolean;
  flushIntervalMs?: number;
}

export interface TraceTranslatorStart {
  attemptId: string;
  turnId: string | null;
  agentId: string;
  agentName: string | null;
  provider: string;
  requestedModel: string | null;
  input: UnifiedMessage[];
  /** Used when the attempt carries no input messages (a direct `handleTask`). */
  fallbackText?: string | null;
  attachments?: Array<{ id: string; name: string | null }>;
}

export interface TracePermissionRequest {
  decisionId: string;
  toolCallId: string | null;
  title: string;
  options: PermissionOption[];
}

export interface TracePermissionResolution {
  option: PermissionOption | null;
  outcome: "selected" | "cancelled" | "timeout";
  respondedBy: string | null;
  replyMessageId: string | null;
}

export interface TraceQuestionRequest {
  decisionId: string;
  toolCallId: string | null;
  message: string;
  questions: unknown[];
}

export interface TraceQuestionResolution {
  answers: Record<string, string> | null;
  respondedBy: string | null;
  replyMessageId: string | null;
}

export interface TraceSettlement {
  itemId: string | null;
  text: string | null;
}

export interface TraceTranslator {
  start(input: TraceTranslatorStart): void;
  /** One `session/update`. */
  acp(update: ProviderEvent): void;
  /**
   * Each `session.run()` exit: completes open text items and flushes deltas.
   * `aborted` (a steer or force-answer interrupt cut the round short) also
   * stops the round's tool items that are still open.
   */
  promptEnded(opts?: { aborted?: boolean }): void;
  /**
   * The daemon is aborting the current round: a steer or force-answer
   * interrupt, or the task's cancel. Until `promptEnded`, a tool the bridge
   * closes as `failed` with no exit code and no output of its own ends
   * `stopped`: claude-agent-acp 0.90 closes the calls the abort cut short as
   * `failed` with only an explanatory note. Genuine failures keep `failed`.
   */
  roundAborted(): void;
  permissionRequested(request: TracePermissionRequest): string;
  permissionResolved(itemId: string, resolution: TracePermissionResolution): void;
  questionRequested(request: TraceQuestionRequest): string;
  questionResolved(itemId: string, resolution: TraceQuestionResolution): void;
  /**
   * A steer batch whose delivery is known (ADR 0020): one completed
   * `user_message {origin:"steer"}` per message, carrying `result`.
   */
  steer(messages: MultiremiTaskSteerMessage[], result: TraceSteerResult): void;
  /** The provider's own model report (`getLastResponse().model`). */
  model(model: string): void;
  /** The final-reply rule (spec §2.4); call before each `completeTurn`. */
  settle(): TraceSettlement;
  /** A `compaction_update` was seen in this attempt. */
  readonly sawCompaction: boolean;
  /** The last item an ACP update touched in the most recent prompt round. */
  readonly lastItem: TraceItem | null;
  /** Every item emitted so far, latest version, in first-seen order. */
  readonly items: readonly TraceItem[];
  flush(): void;
}

// ── Delta coalescing ────────────────────────────────────────────────────────

const encoder = new TextEncoder();

/** Split a string into pieces of at most `maxBytes` UTF-8 bytes, on character boundaries. */
function splitUtf8(text: string, maxBytes: number): string[] {
  if (utf8ByteLength(text) <= maxBytes) return [text];
  const out: string[] = [];
  let piece = "";
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes && piece) {
      out.push(piece);
      piece = "";
      bytes = 0;
    }
    piece += char;
    bytes += size;
  }
  if (piece) out.push(piece);
  return out;
}

/**
 * The internal emitter that replaced `TaskMessageBatcher`: deltas of one
 * `(item_id, field)` are buffered for up to 200 ms or 16 KiB; any other event,
 * or a delta for another item, flushes the buffer first; one delta event is at
 * most 64 KiB. Events produced within one translator call go out as one batch.
 */
class TraceEmitter {
  private batch: TraceEventInput[] | null = null;
  private pending: { itemId: string; field: "text" | "output"; text: string; bytes: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sink: (events: TraceEventInput[]) => void, private readonly intervalMs: number) {}

  /** Run `fn` with one outgoing batch; nested calls join the outer batch. */
  run<T>(fn: () => T): T {
    if (this.batch) return fn();
    this.batch = [];
    try {
      return fn();
    } finally {
      const events = this.batch;
      this.batch = null;
      if (events.length) this.sink(events);
    }
  }

  event(body: TraceEventInput): void {
    this.drainPending();
    this.push(body);
  }

  delta(itemId: string, field: "text" | "output", text: string): void {
    if (!text) return;
    if (this.pending && (this.pending.itemId !== itemId || this.pending.field !== field)) this.drainPending();
    if (!this.pending) this.pending = { itemId, field, text: "", bytes: 0 };
    this.pending.text += text;
    this.pending.bytes += utf8ByteLength(text);
    if (this.pending.bytes >= TRACE_DELTA_BUFFER_BYTES) this.drainPending();
    else this.schedule();
  }

  /** Emit the pending delta now, outside any batch if needed. */
  flush(): void {
    this.run(() => this.drainPending());
  }

  private push(body: TraceEventInput): void {
    if (this.batch) this.batch.push(body);
    else this.sink([body]);
  }

  private drainPending(): void {
    this.clearTimer();
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    for (const delta of splitUtf8(pending.text, TRACE_DELTA_MAX_BYTES)) {
      this.push({ type: "item.delta", item_id: pending.itemId, field: pending.field, delta });
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

// ── Output accumulation (head + tail) ───────────────────────────────────────

const decoder = new TextDecoder("utf-8", { fatal: false });

function utf8Tail(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - maxBytes;
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
}

function utf8Head(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * A command's streamed output, bounded: everything while it fits the 64 KiB
 * item cap, then the first 16 KiB and a rolling last 48 KiB.
 */
class OutputBuffer {
  private full = "";
  private head = "";
  private tail = "";
  private bytes = 0;
  overflowed = false;

  /** Append a chunk; returns the part that may still stream as a delta. */
  append(chunk: string): string {
    const size = utf8ByteLength(chunk);
    if (!this.overflowed && this.bytes + size <= TRACE_ITEM_OUTPUT_MAX_BYTES) {
      this.full += chunk;
      this.bytes += size;
      return chunk;
    }
    if (!this.overflowed) {
      this.overflowed = true;
      // The head includes this chunk: one chunk may carry the whole output.
      this.head = utf8Head(this.full + chunk, TRACE_ITEM_OUTPUT_HEAD_BYTES);
      this.tail = this.full;
      this.full = "";
    }
    this.tail = utf8Tail(this.tail + chunk, TRACE_ITEM_OUTPUT_TAIL_BYTES);
    this.bytes += size;
    return "";
  }

  get value(): string | null {
    if (this.bytes === 0) return null;
    return this.overflowed ? `${this.head}\n${TRACE_TRUNCATION_MARKER}\n${this.tail}` : this.full;
  }
}

// ── Translator state ────────────────────────────────────────────────────────

interface TextState {
  id: string;
  kind: "agent_message" | "reasoning";
  messageId: string | null;
  parentId: string | null;
  text: string;
  bytes: number;
  cap: number;
  truncated: boolean;
}

interface ToolState {
  id: string;
  parentId: string | null;
  startedAt: string;
  startedMs: number;
  facts: ToolFacts;
  /** The adapter's tool name guess from the first frame (used when the bridge names none). */
  resolved: string | null;
  cls: Exclude<ToolClass, { type: "suppress" }>;
  output: OutputBuffer;
  /** Complete result (rawOutput / content text) seen on a frame; wins over the stream at completion. */
  result: string | null;
  exitCode: number | null;
  changes: Extract<TraceItem, { type: "file_change" }>["changes"];
  /** Command text the current `actions` were parsed from. */
  parsedCommand: string | null;
  actions: CommandAction[];
  lastShape: string;
  closed: boolean;
  status: TraceItemStatus;
  /** Set at the first completion; later re-emits (late hooks, a decline) keep it. */
  durationMs: number | null;
}

const NO_STATS = { item_count: 0, tool_call_count: 0, process_item_count: 0, type_histogram: [] };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function resultText(frame: VendorFrame): string | null {
  const raw = frame.rawOutput;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === "string") return raw;
    const row = record(raw);
    // Codex 1.x command results; MCP and dynamic tools stay JSON.
    for (const key of ["formatted_output", "aggregated_output"]) {
      if (typeof row?.[key] === "string") return row[key] as string;
    }
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  if (Array.isArray(frame.content)) {
    const text = contentText(frame.content);
    if (text) return text;
  }
  return null;
}

function rawExitCode(frame: VendorFrame): number | null {
  const code = record(frame.rawOutput)?.exit_code;
  return Number.isSafeInteger(code) ? code as number : null;
}

function planEntries(raw: unknown): TracePlanItem["entries"] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const row = record(entry);
    if (!row || typeof row.content !== "string") return [];
    const status = row.status === "in_progress" || row.status === "completed" ? row.status : "pending";
    return [{ content: row.content, status, priority: typeof row.priority === "string" ? row.priority : null }];
  });
}

function attachmentRefs(value: unknown): Array<{ id: string; name: string | null }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = record(entry);
    if (!row || typeof row.id !== "string") return [];
    const name = typeof row.filename === "string" ? row.filename : typeof row.name === "string" ? row.name : null;
    return [{ id: row.id, name }];
  });
}

/** Create the translator for one task attempt. */
export function createTraceTranslator(
  adapter: AgentAdapter,
  emit: (events: TraceEventInput[]) => void,
  opts: TraceTranslatorOptions = {},
): TraceTranslator {
  const now = opts.now ?? (() => new Date().toISOString());
  const nowMs = opts.nowMs ?? (() => Date.now());
  const redact = opts.redactText ?? ((text: string) => text);
  const standalone = opts.standaloneText ?? (() => false);
  const agentType = adapter.agentType;
  const emitter = new TraceEmitter(emit, Math.max(1, opts.flushIntervalMs ?? TRACE_DELTA_FLUSH_INTERVAL_MS));

  /** Latest version of every item, in first-seen order (for settle / lastItem). */
  const items = new Map<string, TraceItem>();
  const usedIds = new Set<string>();
  const openText = new Map<string, TextState>(); // key: `${parent}\u0000${kind}`
  const tools = new Map<string, ToolState>();
  const suppressed = new Set<string>();
  const declined = new Set<string>();
  const compactions = new Map<string, { item: TraceCompactionItem; summary: string }>();
  const failures = new Map<string, number>();
  let synCounter = 0;
  let textCounter = 0;
  let noticeCounter = 0;
  let turnStarted = false;
  let contextUsage: TraceContextUsage | null = null;
  let model: string | null = null;
  let previousInferred: string | null = null;
  let sawCompaction = false;
  let roundLast: TraceItem | null = null;
  let endedRoundLast: TraceItem | null = null;
  let roundOpen = false;
  /** Tool items started in the current prompt round. */
  const roundTools = new Set<string>();
  /** A frame carried `_meta.claudeCode.parentToolUseId`: the bridge stamps parents, so no time-window guess. */
  let sawStampedParent = false;
  /** `roundAborted()` was called and the round has not ended yet. */
  let aborting = false;

  const uniqueId = (base: string): string => {
    if (!usedIds.has(base)) { usedIds.add(base); return base; }
    for (let k = 2; ; k++) {
      const candidate = `${base}:${k}`;
      if (!usedIds.has(candidate)) { usedIds.add(candidate); return candidate; }
    }
  };

  const remember = (item: TraceItem, touchedByAcp: boolean): void => {
    items.set(item.id, item);
    if (touchedByAcp) roundLast = item;
  };

  const write = (type: "item.started" | "item.updated" | "item.completed", item: TraceItem, touchedByAcp = false): void => {
    const capped = capTraceItem(item);
    remember(capped, touchedByAcp);
    emitter.event({ type, item: capped } as TraceEventInput);
  };

  // ── Text items ──────────────────────────────────────────────────────────

  const textItem = (state: TextState, status: TraceItemStatus, completedAt: string | null): TraceAgentMessageItem | TraceReasoningItem => {
    const previous = items.get(state.id) as TraceAgentMessageItem | TraceReasoningItem | undefined;
    const text = state.truncated ? state.text + TRACE_TRUNCATION_MARKER : state.text;
    const base = {
      id: state.id, parent_id: state.parentId, status, started_at: previous?.started_at ?? now(), completed_at: completedAt,
      text, ...(state.truncated ? { truncated: true as const } : {}),
    };
    if (state.kind === "reasoning") return { ...base, type: "reasoning" };
    const phase = previous?.type === "agent_message" ? previous.phase : "unknown";
    return { ...base, type: "agent_message", phase };
  };

  const completeText = (key: string): void => {
    const state = openText.get(key);
    if (!state) return;
    openText.delete(key);
    write("item.completed", textItem(state, "completed", now()));
  };

  /** Another item starts at `parentId`: the text items open at that level end. */
  const boundary = (parentId: string | null, except?: string): void => {
    for (const [key, state] of openText) {
      if (state.parentId === parentId && key !== except) completeText(key);
    }
  };

  const endAllText = (): void => {
    for (const key of [...openText.keys()]) completeText(key);
  };

  const onChunk = (frame: VendorFrame, kind: "agent_message" | "reasoning"): void => {
    let text = contentText(frame.content);
    if (!text) return;
    const alone = kind === "agent_message" && standalone(text);
    if (kind === "agent_message") text = redact(text);
    const parentId = parentToolUseId(frame);
    const id = frameMessageId(frame);
    const key = `${parentId ?? ""}\u0000${kind}`;
    let phase = kind === "agent_message" ? messagePhase(frame) : "unknown";
    // Subagent text is never the turn's answer.
    if (parentId !== null && phase === "final") phase = "commentary";
    let state = openText.get(key);
    if (state && (state.messageId !== id || alone)) {
      completeText(key);
      state = undefined;
    }
    if (!state) {
      boundary(parentId, key);
      const prefix = kind === "agent_message" ? "msg" : "rsn";
      state = {
        id: uniqueId(id ? `${prefix}:${id}` : `${prefix}:${++textCounter}`), kind, messageId: id, parentId,
        text: "", bytes: 0, cap: kind === "agent_message" ? TRACE_ITEM_TEXT_MAX_BYTES : TRACE_ITEM_REASONING_MAX_BYTES,
        truncated: false,
      };
      openText.set(key, state);
      const startedAt = now();
      const started: TraceItem = kind === "reasoning"
        ? { id: state.id, parent_id: parentId, status: "in_progress", started_at: startedAt, completed_at: null, type: "reasoning", text: "" }
        : { id: state.id, parent_id: parentId, status: "in_progress", started_at: startedAt, completed_at: null, type: "agent_message", text: "", phase };
      write("item.started", started, true);
    } else if (kind === "agent_message" && phase !== "unknown") {
      const current = items.get(state.id);
      if (current?.type === "agent_message" && current.phase !== phase) {
        // A late phase label replaces the item; flush its streamed text first.
        write("item.updated", { ...textItem(state, "in_progress", null), phase } as TraceAgentMessageItem, true);
      }
    }
    if (state.truncated) return;
    const size = utf8ByteLength(text);
    let piece = text;
    if (state.bytes + size > state.cap) {
      // Keep exactly the capped head so a re-cap by the store is a no-op.
      piece = capItemText(state.text + text, state.cap).value.slice(state.text.length, -TRACE_TRUNCATION_MARKER.length);
      state.truncated = true;
    }
    state.text += piece;
    state.bytes = utf8ByteLength(state.text);
    const current = items.get(state.id);
    if (current && (current.type === "agent_message" || current.type === "reasoning")) {
      remember({ ...current, text: state.text }, true);
    }
    emitter.delta(state.id, "text", piece);
  };

  // ── Tools ───────────────────────────────────────────────────────────────

  /**
   * Claude-only fallback when the bridge does not stamp a parent: the single
   * open Agent call. Off once any frame of the attempt carried a stamped
   * parent, since an unstamped tool is then top-level (a parallel call). A
   * background subagent runs beside the root, so it is never the guess.
   */
  const timeWindowParent = (id: string, facts: ToolFacts): string | null => {
    if (agentType !== "claude" || sawStampedParent || (facts.name && CLAUDE_SUBAGENT_TOOLS.has(facts.name))) return null;
    let parent: string | null = null;
    for (const [candidateId, candidate] of tools) {
      if (candidateId === id || candidate.closed || candidate.cls.type !== "subagent" || candidate.parentId !== null
        || candidate.cls.background === true) continue;
      if (parent !== null) return null;
      parent = candidateId;
    }
    return parent;
  };

  const toolItem = (state: ToolState, status: TraceItemStatus, completedAt: string | null, final: boolean): TraceItem => {
    const facts = state.facts;
    const tool = toolLabel(facts, state.cls, state.resolved);
    const base = { id: state.id, parent_id: state.parentId, status, started_at: state.startedAt, completed_at: completedAt };
    const output = final ? state.result ?? state.output.value : state.output.value;
    if (completedAt && state.durationMs === null) state.durationMs = Math.max(0, nowMs() - state.startedMs);
    const duration = completedAt ? state.durationMs : null;
    const truncated = !final || state.result === null ? state.output.overflowed : false;
    const flag = truncated ? { output_truncated: true as const } : {};
    switch (state.cls.type) {
      case "command":
        return { ...base, type: "command", tool, source: state.cls.source, command: state.cls.command, cwd: state.cls.cwd,
          actions: state.actions, ...(state.cls.title ? { title: state.cls.title } : {}), output, ...flag,
          exit_code: state.exitCode, duration_ms: duration };
      case "file_change":
        return { ...base, type: "file_change", tool, changes: state.changes, output, ...flag, duration_ms: duration };
      case "web_search":
        return { ...base, type: "web_search", tool, action: state.cls.action, query: state.cls.query, url: state.cls.url,
          output, ...flag, duration_ms: duration };
      case "subagent": {
        // The §13 facts appear only once known; an older reader ignores them.
        const cls = state.cls;
        return { ...base, type: "subagent", tool, title: facts.title, prompt: cls.prompt, output, ...flag, duration_ms: duration,
          ...(cls.agentType !== null ? { agent_type: cls.agentType } : {}), ...(cls.name !== null ? { name: cls.name } : {}),
          ...(cls.background !== null ? { background: cls.background } : {}), ...(cls.model !== null ? { model: cls.model } : {}),
          ...(cls.threadId !== null ? { thread_id: cls.threadId } : {}) };
      }
      case "tool":
        return { ...base, type: "tool", tool, server: state.cls.server, kind: facts.kind, title: facts.title,
          input: facts.input, output, ...flag, duration_ms: duration };
    }
  };

  /** The fields whose change makes an `item.updated` (title, input, command, actions, changes). */
  const shapeOf = (item: TraceItem): string => {
    const { status: _s, completed_at: _c, started_at: _t, seq: _q, ...rest } = item as TraceItem & { output?: unknown; duration_ms?: unknown; exit_code?: unknown };
    const shape = { ...rest } as Record<string, unknown>;
    delete shape.output;
    delete shape.output_truncated;
    delete shape.duration_ms;
    delete shape.exit_code;
    return JSON.stringify(shape);
  };

  const refreshClass = (state: ToolState): void => {
    const cls = classifyTool(agentType, state.facts);
    // The item type is fixed at its start; later frames refine its fields only.
    if (cls.type === state.cls.type) state.cls = cls as ToolState["cls"];
    if (state.cls.type === "command") {
      if (state.cls.actions) state.actions = state.cls.actions;
      else if (state.cls.command !== null && state.cls.command !== state.parsedCommand) {
        state.parsedCommand = state.cls.command;
        state.actions = parseCommand(state.cls.command, state.cls.cwd);
      }
    }
  };

  /** A subagent whose launch the bridge reported as async (`toolResponse.isAsync` / `async_launched`). */
  const isBackgroundLaunch = (state: ToolState): boolean => state.cls.type === "subagent" && state.facts.asyncLaunch === true;

  /**
   * A background launch or anything under one: it runs beside the root, so a
   * round's abort neither cuts it short nor closes it.
   */
  const inBackground = (state: ToolState): boolean => {
    const seen = new Set<string>();
    for (let current: ToolState | undefined = state; current && !seen.has(current.id); current = current.parentId ? tools.get(current.parentId) : undefined) {
      if (isBackgroundLaunch(current)) return true;
      seen.add(current.id);
    }
    return false;
  };

  /**
   * The abort cut this call short, so it ends `stopped` rather than with the
   * bridge's status. claude-agent-acp 0.90 reports such calls as:
   * - an unfinished call: `failed`, no exit code, no output of its own (its
   *   closing note is not the tool's output);
   * - an interrupted Claude command: output ending in the abort marker, with an
   *   AIR-synthesized exit code 1 (`failed`, or `completed` when Claude Code did
   *   not mark the result an error).
   */
  const cutShortByAbort = (state: ToolState, status: string | null): boolean => {
    if (!aborting || inBackground(state)) return false;
    if (status === "failed" && state.exitCode === null && state.output.value === null) return true;
    return agentType === "claude" && state.cls.type === "command" && (status === "failed" || status === "completed")
      && endsWithAbortMarker(state.output.value ?? state.result);
  };

  const completeTool = (state: ToolState, acpStatus: "completed" | "failed" | "cancelled", touchedByAcp = true): void => {
    state.closed = true;
    state.status = declined.has(state.id) ? "declined" : acpStatus === "cancelled" ? "stopped" : acpStatus;
    // A subagent's own text ends with it, not at the next top-level boundary.
    if (state.cls.type === "subagent") boundary(state.id);
    const item = toolItem(state, state.status, now(), true);
    // Uncapped, like the in-progress and late-frame comparisons.
    state.lastShape = shapeOf(item);
    write("item.completed", item, touchedByAcp);
  };

  const onTool = (frame: VendorFrame): void => {
    const id = typeof frame.toolCallId === "string" && frame.toolCallId ? frame.toolCallId : `syn_${synCounter++}`;
    if (suppressed.has(id)) return;
    let state = tools.get(id);
    if (!state) {
      const facts = mergeToolFacts(null, frame, agentType);
      const cls = classifyTool(agentType, facts);
      if (cls.type === "suppress") {
        suppressed.add(id);
        return;
      }
      const parentId = parentToolUseId(frame) ?? timeWindowParent(id, facts);
      boundary(parentId);
      usedIds.add(id);
      let resolved: string | null = null;
      try { resolved = adapter.resolveToolName(frame as never) || null; } catch { resolved = null; }
      state = {
        id, parentId, startedAt: now(), startedMs: nowMs(), facts, resolved, cls, output: new OutputBuffer(), result: null,
        exitCode: null, changes: [], parsedCommand: null, actions: [], lastShape: "", closed: false, status: "in_progress",
        durationMs: null,
      };
      tools.set(id, state);
      roundTools.add(id);
      refreshClass(state);
      const changes = diffChanges(frame);
      if (changes) state.changes = changes;
      const item = toolItem(state, "in_progress", null, false);
      state.lastShape = shapeOf(item);
      write("item.started", item, true);
    } else {
      state.facts = mergeToolFacts(state.facts, frame, agentType);
      refreshClass(state);
      const changes = diffChanges(frame);
      if (changes) state.changes = changes;
    }

    const chunk = terminalChunk(frame);
    if (chunk !== null && !state.closed) {
      const piece = state.output.append(chunk);
      remember({ ...items.get(state.id)!, output: state.output.value } as TraceItem, true);
      if (piece) emitter.delta(state.id, "output", piece);
    }
    const exit = terminalExit(frame);
    if (exit !== undefined) state.exitCode = exit;
    const status = typeof frame.status === "string" ? frame.status : null;
    // `cancelled` is ACP v2's status; the pinned bridges send v1 `failed` (CA renderer.js:11-20).
    let terminal = status === "completed" || status === "failed" || status === "cancelled";
    // An async (background) subagent launch: the call's result only acknowledges
    // the launch, and the subagent keeps working while the bridge holds the turn.
    // The item stays open, without that text, until the turn closes (spec §13).
    const launched = terminal && status === "completed" && !state.closed && isBackgroundLaunch(state);
    if (launched) terminal = false;
    if ((terminal || state.closed) && !launched) {
      const result = resultText(frame);
      if (result !== null) state.result = result;
      if (state.exitCode === null) state.exitCode = rawExitCode(frame);
    }

    if (state.closed) {
      // A late frame after completion (Claude's PostToolUse hook re-sends the
      // final diff): the latest content replaces the completed item.
      const item = toolItem(state, state.status, items.get(state.id)?.completed_at ?? now(), true);
      if (shapeOf(item) !== state.lastShape) {
        state.lastShape = shapeOf(item);
        write("item.completed", item, true);
      }
      return;
    }
    if (terminal) {
      if (cutShortByAbort(state, status)) {
        // Its exit code, if any, is AIR's synthesized 1 for an interrupt.
        state.exitCode = null;
        completeTool(state, "cancelled");
      } else {
        completeTool(state, status as "completed" | "failed" | "cancelled");
      }
      return;
    }
    const item = toolItem(state, "in_progress", null, false);
    const shape = shapeOf(item);
    if (shape !== state.lastShape) {
      state.lastShape = shape;
      write("item.updated", item, true);
    }
  };

  // ── Other updates ───────────────────────────────────────────────────────

  const patchTurn = (patch: { model?: string; context_usage?: TraceContextUsage }): void => {
    if (!turnStarted) return;
    emitter.event({ type: "turn.updated", patch });
  };

  const onPlan = (frame: VendorFrame): void => {
    const entries = planEntries(frame.entries);
    const existing = items.get("plan");
    if (!existing) {
      boundary(null);
      usedIds.add("plan");
    }
    const item: TracePlanItem = {
      id: "plan", parent_id: null, status: "in_progress", started_at: existing?.started_at ?? now(), completed_at: null,
      type: "plan", entries,
    };
    write(existing ? "item.updated" : "item.started", item, true);
  };

  const onCompaction = (frame: VendorFrame): void => {
    const compactionId = typeof frame.compactionId === "string" && frame.compactionId ? frame.compactionId : "compaction";
    sawCompaction = true;
    const id = `cmp:${compactionId}`;
    let entry = compactions.get(id);
    const facts = compactionFacts(frame);
    const status = frame.status === "completed" ? "completed" : frame.status === "failed" ? "failed"
      : frame.status === "cancelled" ? "stopped" : "in_progress";
    if (!entry) {
      boundary(null);
      usedIds.add(id);
      entry = {
        summary: "",
        item: { id, parent_id: null, status: "in_progress", started_at: now(), completed_at: null, type: "compaction",
          trigger: null, summary: null, pre_tokens: null, post_tokens: null, error: null },
      };
      compactions.set(id, entry);
    }
    const summary = Array.isArray(frame.summary) ? contentText(frame.summary) : typeof frame.summary === "string" ? frame.summary : "";
    const error = typeof frame.error === "string" && frame.error ? frame.error
      : record(frame.error) && typeof record(frame.error)!.message === "string" ? record(frame.error)!.message as string : null;
    const next: TraceCompactionItem = {
      ...entry.item, ...facts,
      ...(status !== "in_progress" ? { status, completed_at: entry.item.completed_at ?? now() } : {}),
      summary: summary || entry.item.summary || (status !== "in_progress" && entry.summary ? entry.summary : null),
      error: error ?? entry.item.error,
    };
    const previous = entry.item;
    entry.item = next;
    if (status === "in_progress") {
      if (!items.has(id)) write("item.started", next, true);
      else if (JSON.stringify(previous) !== JSON.stringify(next)) write("item.updated", next, true);
    } else if (JSON.stringify(previous) !== JSON.stringify(next) || !items.has(id)) {
      write("item.completed", next, true);
    }
  };

  const onCompactionChunk = (frame: VendorFrame): void => {
    const compactionId = typeof frame.compactionId === "string" && frame.compactionId ? frame.compactionId : "compaction";
    const entry = compactions.get(`cmp:${compactionId}`);
    // Buffered and emitted only at completion (spec §2.1).
    if (entry) entry.summary += contentText(frame.content);
  };

  const onNotice = (frame: VendorFrame): void => {
    boundary(null);
    const id = uniqueId(`ntc:${++noticeCounter}`);
    const at = now();
    write("item.completed", { id, parent_id: null, status: "completed", started_at: at, completed_at: at, type: "notice",
      ...noticeFields(frame) }, true);
  };

  const onSessionInfo = (frame: VendorFrame): void => {
    const failure = readSessionFailure(frame._meta);
    if (!failure) return;
    const previous = failures.get(failure.id);
    if (previous !== undefined && previous >= failure.revision) return;
    failures.set(failure.id, failure.revision);
    const id = `fail:${failure.id}`;
    if (previous === undefined) { boundary(null); usedIds.add(id); }
    const existing = items.get(id);
    const at = now();
    write("item.completed", { id, parent_id: null, status: "completed", started_at: existing?.started_at ?? at, completed_at: at,
      type: "notice", ...sessionFailureNotice(failure) }, true);
  };

  const onUsage = (frame: VendorFrame): void => {
    if (parentToolUseId(frame)) return;
    const used = frame.used;
    const size = frame.size;
    // `size == 0` frames are billing-only (usage-bridge-patches.ts); billing rides `_meta.remiUsageUnits`.
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || typeof size !== "number" || !(size > 0)) return;
    if (contextUsage && contextUsage.used === used && contextUsage.size === size) return;
    contextUsage = { used, size };
    patchTurn({ context_usage: { used, size } });
  };

  const onModel = (frame: VendorFrame): void => {
    if (parentToolUseId(frame)) return;
    const next = readExecutionModel(frame)?.model;
    if (next) setModel(next);
  };

  const setModel = (next: string): void => {
    if (next === model) return;
    model = next;
    patchTurn({ model: next });
  };

  return {
    start(input) {
      emitter.run(() => {
        const at = now();
        const turn: TraceTurn = {
          id: input.attemptId, turn_id: input.turnId, agent_id: input.agentId, agent_name: input.agentName,
          provider: input.provider, requested_model: input.requestedModel, model: null, status: "running", error: null,
          started_at: at, completed_at: null, duration_ms: null, final_item_id: null, final_started_at: null,
          context_usage: null, stats: NO_STATS,
        };
        turnStarted = true;
        emitter.event({ type: "turn.started", turn });
        const id = uniqueId(`in:${input.attemptId}`);
        const text = capItemText(input.input.length
          ? input.input.map((message) => message.body_md).join("\n\n") : input.fallbackText ?? "");
        write("item.completed", {
          id, parent_id: null, status: "completed", started_at: at, completed_at: at, type: "user_message", origin: "input",
          text: text.value, ...(text.truncated ? { truncated: true as const } : {}),
          message_ids: input.input.map((message) => message.id), attachments: input.attachments ?? [], steer: null,
        });
      });
    },

    acp(update) {
      emitter.run(() => {
        if (!roundOpen) {
          roundOpen = true;
          roundLast = null;
          roundTools.clear();
        }
        const frame = update as unknown as VendorFrame;
        if (!sawStampedParent && parentToolUseId(frame) !== null) sawStampedParent = true;
        switch (frame.sessionUpdate) {
          case "agent_message_chunk":
            onChunk(frame, "agent_message");
            break;
          case "agent_thought_chunk":
            onChunk(frame, "reasoning");
            break;
          case "tool_call":
          case "tool_call_update":
            onTool(frame);
            break;
          case "plan":
            onPlan(frame);
            break;
          case "usage_update":
            onUsage(frame);
            break;
          case "config_option_update":
          case "current_model_update":
            onModel(frame);
            break;
          case "compaction_update":
            onCompaction(frame);
            break;
          case "compaction_summary_chunk":
            onCompactionChunk(frame);
            break;
          case "notice":
            onNotice(frame);
            break;
          case "session_info_update":
            onSessionInfo(frame);
            break;
          default:
            // user_message_chunk, available_commands_update, current_mode_update,
            // subagent_*, async_task_*, state_update, terminal_* and unknown kinds.
            break;
        }
      });
    },

    promptEnded(opts) {
      emitter.run(() => {
        endAllText();
        if (opts?.aborted) {
          // The interrupted calls will not report again; the next round is a new
          // prompt. A background subagent's call already returned and its steps
          // keep running: they end on their own frames, or with the turn.
          for (const id of roundTools) {
            const state = tools.get(id);
            if (state && !state.closed && !inBackground(state)) completeTool(state, "cancelled", false);
          }
        }
        emitter.flush();
      });
      aborting = false;
      roundTools.clear();
      endedRoundLast = roundLast;
      roundLast = null;
      roundOpen = false;
    },

    roundAborted() {
      aborting = true;
    },

    permissionRequested(request) {
      return emitter.run(() => {
        const id = uniqueId(`perm:${request.decisionId}`);
        boundary(null);
        write("item.started", {
          id, parent_id: null, status: "in_progress", started_at: now(), completed_at: null, type: "permission",
          tool_item_id: request.toolCallId, title: request.title, message_id: request.decisionId,
          options: request.options.map((option) => ({ option_id: option.optionId, name: option.name, kind: option.kind })),
          decision: null, outcome: null, responded_by: null, reply_message_id: null,
        });
        return id;
      });
    },

    permissionResolved(itemId, resolution) {
      emitter.run(() => {
        const current = items.get(itemId);
        if (current?.type !== "permission") return;
        const allowed = resolution.outcome === "selected" && !!resolution.option?.kind.startsWith("allow");
        if (!allowed && current.tool_item_id) {
          declined.add(current.tool_item_id);
          const tool = tools.get(current.tool_item_id);
          if (tool?.closed && tool.status !== "declined") {
            tool.status = "declined";
            write("item.completed", toolItem(tool, "declined", items.get(tool.id)?.completed_at ?? now(), true));
          }
        }
        const status: TraceItemStatus = resolution.outcome !== "selected" ? "stopped" : allowed ? "completed" : "declined";
        write("item.completed", {
          ...current, status, completed_at: now(),
          decision: resolution.option
            ? { option_id: resolution.option.optionId, name: resolution.option.name, kind: resolution.option.kind } : null,
          outcome: resolution.outcome, responded_by: resolution.respondedBy, reply_message_id: resolution.replyMessageId,
        } as TraceItem);
      });
    },

    questionRequested(request) {
      return emitter.run(() => {
        const id = uniqueId(`q:${request.decisionId}`);
        boundary(null);
        write("item.started", {
          id, parent_id: null, status: "in_progress", started_at: now(), completed_at: null, type: "question",
          tool_item_id: request.toolCallId, message: request.message, message_id: request.decisionId,
          questions: request.questions, answers: null, responded_by: null, reply_message_id: null,
        });
        return id;
      });
    },

    questionResolved(itemId, resolution) {
      emitter.run(() => {
        const current = items.get(itemId);
        if (current?.type !== "question") return;
        write("item.completed", {
          ...current, status: resolution.answers ? "completed" : "stopped", completed_at: now(),
          answers: resolution.answers, responded_by: resolution.respondedBy, reply_message_id: resolution.replyMessageId,
        } as TraceItem);
      });
    },

    steer(messages, result) {
      emitter.run(() => {
        boundary(null);
        for (const message of messages) {
          const id = uniqueId(`steer:${message.id}`);
          const at = now();
          const text = capItemText(message.content ?? "");
          write("item.completed", {
            id, parent_id: null, status: "completed", started_at: at, completed_at: at, type: "user_message", origin: "steer",
            text: text.value, ...(text.truncated ? { truncated: true as const } : {}),
            message_ids: [message.id], attachments: attachmentRefs(message.attachments),
            steer: { steer_id: message.id, kind: message.kind, injected: result.via !== "none",
              author_type: message.authorType ?? null, author_id: message.authorId ?? null,
              result: { via: result.via, native_outcome: result.native_outcome, error: steerError(result.error) } },
          });
        }
      });
    },

    model(next) {
      emitter.run(() => setModel(next));
    },

    settle() {
      return emitter.run(() => {
        endAllText();
        const selection = selectFinalReply([...items.values()], previousInferred);
        for (const item of selection.reemit) write("item.completed", item);
        previousInferred = selection.rule === "inferred" || selection.rule === "fallback" ? selection.itemId : null;
        return { itemId: selection.itemId, text: selection.text };
      });
    },

    get sawCompaction() {
      return sawCompaction;
    },

    get lastItem() {
      const last = roundOpen ? roundLast : endedRoundLast;
      return last ? items.get(last.id) ?? last : null;
    },

    get items() {
      return [...items.values()];
    },

    flush() {
      emitter.flush();
    },
  };
}
