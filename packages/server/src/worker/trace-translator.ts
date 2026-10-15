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
  autonomousOrigin,
  classifyTool,
  endsWithAbortMarker,
  compactionFacts,
  contentText,
  diffChanges,
  frameSession,
  isNativeAgentHook,
  launchMarker,
  mergeToolFacts,
  messageId as frameMessageId,
  messagePhase,
  nativeAgentFacts,
  nativeAgentId,
  nativeAgentItemId,
  nativeAgentPrompt,
  noticeFields,
  parentToolUseId,
  toolLabel,
  readSessionFailure,
  requestUsageOwner,
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
  TraceSubagentItem,
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
import { selectFinalReply, subagentReply } from "@shared/turn-trace.js";

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
  /**
   * Running subagents changed (PR 5 §3.8): in-progress `subagent` items,
   * top-level and nested. Called with the new counts on every change only.
   */
  onSubagentCounts?: (counts: { top: number; nested: number }) => void;
}

/** The subagent a child session belongs to, for a request it raised (PR 5 §1.3). */
export interface TraceSubagentRef {
  item_id: string;
  /** The subagent's name, else its title; empty when it has neither. */
  name: string;
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
  /**
   * The native subagent whose child session (any generation) raised a
   * permission or question; null for the root session or an unknown one.
   */
  subagentOfSession(sessionId: string | null | undefined): TraceSubagentRef | null;
  /**
   * The bridge still owes this attempt an autonomous round (PR 5 §2.4): a
   * background subagent's notification that the prompt did not consume. False
   * unless the adapter declares autonomous rounds.
   */
  readonly owesAutonomousRound: boolean;
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

/** A native subagent: its child sessions, across resumed generations, are one item (PR 5 §3.5). */
interface NativeAgent {
  id: string;
  parentId: string | null;
  startedMs: number;
  item: TraceSubagentItem;
  /** A hook marker (or the alias of its call) linked the agent to its Agent call. */
  linked: boolean;
  /**
   * The bridge patch's `_meta.remi` said `backgrounded: true` (the SDK's own
   * registration): nothing downgrades it. A patch `false` stays open to the
   * upgrade by inference: a foreground child blocks its caller, so a caller
   * that keeps working while it runs had it moved to the background
   * (`task_updated`, e.g. to take a steer), which no announcement reports.
   */
  authoritative: boolean;
  spawnOrder: number;
  /** Frame order of the state update that ended it last; null while it runs. */
  endedOrder: number | null;
  /** The prompt round it ended in. */
  endedRound: number;
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
  /** Latest revision per session failure (a child's keyed by its session), and the notice item it became. */
  const failures = new Map<string, number>();
  const failureIds = new Map<string, string>();
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

  // Native child sessions (PR 5 §3): one `subagent` item per agent, keyed by
  // its id without the generation suffix.
  const natives = new Map<string, NativeAgent>();
  const nativeById = new Map<string, NativeAgent>();
  /** Every generation's session id -> its agent. */
  const sessionAgent = new Map<string, NativeAgent>();
  /** An Agent call (Claude `toolu_…`) -> the agent it launched, learned from stamped child frames or the hook. */
  const alias = new Map<string, NativeAgent>();
  /** Orphan hook markers waiting for the alias of their call (§3.3). */
  const pendingHooks = new Map<string, boolean>();
  /** A child's request model, by its Agent call, until a child frame reveals the alias (the usage can come first). */
  const pendingModels = new Map<string, string>();
  let spawnCounter = 0;
  /** Order of ACP frames, for the autonomous-round rule (§2.4). */
  let frameOrder = 0;
  /** Frame order of the last autonomous result marker, and of the last top-level tool result. */
  let lastMarkerOrder = 0;
  let lastToolResultOrder = 0;
  /** Without native sessions: background launches (by the round they started in), and the autonomous markers since the first. */
  const backgroundLaunches = new Map<string, number>();
  let markersSinceLaunch = 0;
  /**
   * Prompt rounds ended so far, and the round of the last root result marker of
   * any origin. A result in a later round than a background child's end means
   * the next prompt (a steer's re-prompt) carried its pending notification.
   */
  let roundIndex = 0;
  let lastResultRound = -1;
  /**
   * Root work (text, a thought, a tool call) since the last counted result
   * marker. A marker without any is a placeholder: Claude Code 2.1.274+ answers
   * queued notifications with one model call and gives the others empty
   * `num_turns: 0` results first, each still carrying the marker.
   */
  let rootWorkSinceMarker = false;
  const autonomousOrigins = new Set(adapter.autonomousRounds?.resultOrigins ?? []);
  const runningSubagents = new Map<string, boolean>();
  let subagentCounts = { top: 0, nested: 0 };

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
    if (item.type === "subagent") countSubagent(item);
  };

  /** Keep the running-subagent counts incremental and report a change (§3.8). */
  const countSubagent = (item: TraceSubagentItem): void => {
    const running = item.status === "in_progress";
    if ((runningSubagents.get(item.id) ?? false) === running) return;
    runningSubagents.set(item.id, running);
    const key = item.parent_id === null ? "top" : "nested";
    subagentCounts = { ...subagentCounts, [key]: subagentCounts[key] + (running ? 1 : -1) };
    try {
      opts.onSubagentCounts?.(subagentCounts);
    } catch {
      // A failing listener never breaks the trace.
    }
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

  // ── Native subagents (PR 5 §3) ──────────────────────────────────────────

  /** The agent of a child session, any generation; undefined for the root or an unknown session. */
  const agentOfSession = (sessionId: string | null): NativeAgent | undefined =>
    sessionId ? sessionAgent.get(sessionId) ?? natives.get(nativeAgentId(sessionId)) : undefined;

  /**
   * The parent item of a frame (§3.1): the agent of its child session, else
   * the agent its stamped Agent call launched, else that call itself (Claude
   * without native sessions), else null.
   */
  const frameParent = (frame: VendorFrame): string | null => {
    const agent = agentOfSession(frameSession(frame));
    const stamped = parentToolUseId(frame);
    if (agent) {
      // The first stamped frame of a child session names the Agent call that launched it.
      if (stamped && !alias.has(stamped)) learnAlias(stamped, agent);
      return agent.id;
    }
    if (stamped) return alias.get(stamped)?.id ?? stamped;
    return null;
  };

  const learnAlias = (toolCallId: string, agent: NativeAgent): void => {
    alias.set(toolCallId, agent);
    const model = pendingModels.get(toolCallId);
    if (model !== undefined) {
      pendingModels.delete(toolCallId);
      applyModel(agent, model);
    }
    const marker = pendingHooks.get(toolCallId);
    if (marker === undefined) return;
    pendingHooks.delete(toolCallId);
    applyHook(agent, marker);
  };

  /** The model of the child's first request names the agent's model; it never changes it later. */
  const applyModel = (agent: NativeAgent, model: string): void => {
    if (!agent.item.model) rewriteAgent(agent, { model });
  };

  /**
   * A root billing frame for a subagent's request (Remi's usage patches): its
   * model fills the agent's `model` (the AIR announcement names none, U2).
   * Claude names the Agent call, whose alias may come with the child's next
   * frame; Codex names the child thread.
   */
  const noteRequestModel = (frame: VendorFrame): void => {
    if (!natives.size || frame.sessionUpdate !== "usage_update") return;
    const owner = requestUsageOwner(frame);
    if (!owner?.model) return;
    const agent = owner.parentToolUseId ? alias.get(owner.parentToolUseId) : agentOfSession(owner.providerSessionId);
    if (agent) applyModel(agent, owner.model);
    else if (owner.parentToolUseId && !pendingModels.has(owner.parentToolUseId)) pendingModels.set(owner.parentToolUseId, owner.model);
  };

  /** Re-emit an agent's item with `patch`, keeping its lifecycle event (started/updated vs completed). */
  const rewriteAgent = (agent: NativeAgent, patch: Partial<TraceSubagentItem>): void => {
    agent.item = { ...agent.item, ...patch };
    write(agent.item.status === "in_progress" ? "item.updated" : "item.completed", agent.item, true);
  };

  /** The hook's launch marker sets `background` (§3.3); the agent is linked to its call from now on. */
  const applyHook = (agent: NativeAgent, background: boolean): void => {
    agent.linked = true;
    if (!agent.authoritative && agent.item.background !== background) rewriteAgent(agent, { background });
  };

  /**
   * Absorb Claude's orphan PostToolUse hook update of a native Agent call
   * (§3.3): no item; its marker goes to the agent of its call, found by alias,
   * else the most recently spawned unlinked agent of the calling session, else
   * it waits for a child frame to reveal the alias.
   */
  const absorbHook = (frame: VendorFrame, toolCallId: string): void => {
    const marker = launchMarker(frame)!;
    let agent = alias.get(toolCallId);
    if (!agent) {
      const callerId = (() => {
        const caller = parentToolUseId(frame);
        return caller ? alias.get(caller)?.id ?? null : null;
      })();
      for (const candidate of natives.values()) {
        if (candidate.linked || candidate.parentId !== callerId) continue;
        if (!agent || candidate.spawnOrder > agent.spawnOrder) agent = candidate;
      }
      if (!agent) {
        pendingHooks.set(toolCallId, marker);
        return;
      }
      alias.set(toolCallId, agent);
    }
    applyHook(agent, marker);
  };

  /**
   * Fallback `background` inference (§3.3): a session that keeps working
   * (message, thought or a new tool call) while a child it spawned runs did not
   * wait for it, so that child runs in the background. Claude only.
   */
  const inferBackground = (frame: VendorFrame): void => {
    if (agentType !== "claude" || !natives.size) return;
    const kind = frame.sessionUpdate;
    // The root's result marker while a child still runs: a foreground call would have ended first.
    const result = kind === "usage_update" && frameSession(frame) === null && autonomousOrigin(frame) !== null;
    if (!result) {
      if (kind !== "agent_message_chunk" && kind !== "agent_thought_chunk" && kind !== "tool_call") return;
      if (kind !== "tool_call" && !contentText(frame.content)) return;
    }
    const caller = agentOfSession(frameSession(frame))?.id ?? null;
    for (const agent of natives.values()) {
      // Only ever upgraded: unknown (or the patch's `false`) to true.
      if (agent.parentId === caller && agent.item.status === "in_progress" && agent.item.background !== true && !agent.authoritative) {
        rewriteAgent(agent, { background: true });
      }
    }
  };

  /** An autonomous cycle's result marker on the root (§2.4). */
  const onAutonomousMarker = (frame: VendorFrame): void => {
    if (!autonomousOrigins.size || frameSession(frame) || parentToolUseId(frame)) return;
    const kind = frame.sessionUpdate;
    if (kind === "tool_call" || kind === "tool_call_update"
      || ((kind === "agent_message_chunk" || kind === "agent_thought_chunk") && contentText(frame.content).trim())) {
      rootWorkSinceMarker = true;
      return;
    }
    if (kind !== "usage_update") return;
    const origin = autonomousOrigin(frame);
    // A placeholder result answers nothing yet: the shared follow-up's own result comes later.
    if (!origin || !rootWorkSinceMarker) return;
    rootWorkSinceMarker = false;
    lastResultRound = roundIndex;
    if (!autonomousOrigins.has(origin)) return;
    lastMarkerOrder = frameOrder;
    if (backgroundLaunches.size) markersSinceLaunch++;
  };

  const onSpawned = (frame: VendorFrame): void => {
    const sessionId = typeof frame.subagentSessionId === "string" ? frame.subagentSessionId : "";
    if (!sessionId) return;
    const baseId = nativeAgentId(sessionId);
    const known = natives.get(baseId);
    if (known) {
      reopenAgent(known, sessionId, frame);
      return;
    }
    const parentId = agentOfSession(frameSession(frame))?.id ?? null;
    boundary(parentId);
    // Deterministic, so a request raised before this frame reaches the trace can name it (the daemon's fallback).
    const id = nativeAgentItemId(baseId);
    usedIds.add(id);
    const name = typeof frame.name === "string" && frame.name.trim() ? frame.name : null;
    // The AIR-form announcement names no type or model; Remi's Claude bridge patch adds the
    // SDK's background verdict and type (`_meta.remi`, authoritative). Else `background` comes
    // from the hook or inference, and `model` from the child's first request.
    const facts = nativeAgentFacts(frame);
    const item: TraceSubagentItem = {
      id, parent_id: parentId, status: "in_progress", started_at: now(), completed_at: null, type: "subagent",
      tool: agentType === "codex" ? "spawnAgent" : "Agent", title: name, name, prompt: nativeAgentPrompt(frame),
      output: null, duration_ms: null, thread_id: baseId,
      ...(facts.agentType ? { agent_type: facts.agentType } : {}), ...(facts.background !== null ? { background: facts.background } : {}),
    };
    const agent: NativeAgent = { id, parentId, startedMs: nowMs(), item, linked: false, authoritative: facts.background === true,
      spawnOrder: ++spawnCounter, endedOrder: null, endedRound: -1 };
    natives.set(baseId, agent);
    nativeById.set(id, agent);
    sessionAgent.set(sessionId, agent);
    write("item.started", item, true);
  };

  /**
   * A resumed agent (`<id>:generation:N`) is the same item (§3.5): it reopens,
   * and the message that resumed it (Claude's SendMessage text) becomes its
   * next instructions, a child `user_message`.
   */
  const reopenAgent = (agent: NativeAgent, sessionId: string, frame: VendorFrame): void => {
    sessionAgent.set(sessionId, agent);
    const facts = nativeAgentFacts(frame);
    if (facts.background === true) agent.authoritative = true;
    if (agent.item.status !== "in_progress") {
      agent.endedOrder = null;
      // Claude Code resumes a subagent in the background (CA/acp-agent.js "always resumes … in the background").
      const background = facts.background ?? (agentType === "claude" ? true : undefined);
      rewriteAgent(agent, { status: "in_progress", completed_at: null, duration_ms: null,
        ...(background !== undefined ? { background } : {}),
        ...(facts.agentType && !agent.item.agent_type ? { agent_type: facts.agentType } : {}) });
    }
    const prompt = typeof frame.prompt === "string" && frame.prompt.trim() ? frame.prompt : null;
    if (!prompt) return;
    boundary(agent.id);
    const at = now();
    const text = capItemText(prompt);
    write("item.completed", {
      id: uniqueId(`in:${sessionId}`), parent_id: agent.id, status: "completed", started_at: at, completed_at: at,
      type: "user_message", origin: "input", text: text.value, ...(text.truncated ? { truncated: true as const } : {}),
      message_ids: [], attachments: [], steer: null,
    }, true);
  };

  /** A child's `subagent_state_update` (§3.4): its open text and tools close, then the item ends. */
  const onSubagentState = (frame: VendorFrame): void => {
    const sessionId = typeof frame.subagentSessionId === "string" ? frame.subagentSessionId : "";
    const agent = agentOfSession(sessionId);
    if (!agent || agent.item.status !== "in_progress") return;
    const status: TraceItemStatus = frame.state === "completed" ? "completed" : frame.state === "failed" ? "failed" : "stopped";
    boundary(agent.id);
    for (const tool of tools.values()) {
      if (tool.parentId === agent.id && !tool.closed) completeTool(tool, "cancelled");
    }
    const completedAt = now();
    const ended = { ...agent.item, status, completed_at: completedAt };
    const reply = subagentReply([...items.values()].map((item) => item.id === agent.id ? ended : item), agent.id);
    agent.endedOrder = frameOrder;
    agent.endedRound = roundIndex;
    // A resumed generation without a reply of its own (claude-agent-acp 0.90 drops its frames) keeps the last known result.
    rewriteAgent(agent, { status, completed_at: completedAt, duration_ms: Math.max(0, nowMs() - agent.startedMs),
      output: reply?.text ?? agent.item.output ?? null });
  };

  const onChunk = (frame: VendorFrame, kind: "agent_message" | "reasoning"): void => {
    let text = contentText(frame.content);
    if (!text) return;
    const alone = kind === "agent_message" && standalone(text);
    if (kind === "agent_message") text = redact(text);
    const parentId = frameParent(frame);
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
    let id: string | null = state.id;
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      const tool = tools.get(id);
      if (tool) {
        if (isBackgroundLaunch(tool)) return true;
        id = tool.parentId;
        continue;
      }
      // A native child session's agent (PR 5 §3.3).
      const agent = nativeById.get(id);
      if (!agent) return false;
      if (agent.item.background === true) return true;
      id = agent.parentId;
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
    // A root tool's result went back to the model: a notification due then rode along (§2.4).
    if (touchedByAcp && state.parentId === null && state.cls.type !== "subagent") lastToolResultOrder = frameOrder;
    write("item.completed", item, touchedByAcp);
  };

  const onTool = (frame: VendorFrame): void => {
    const id = typeof frame.toolCallId === "string" && frame.toolCallId ? frame.toolCallId : `syn_${synCounter++}`;
    if (suppressed.has(id)) return;
    let state = tools.get(id);
    if (!state && agentType === "claude" && natives.size && frameSession(frame) === null && isNativeAgentHook(frame)) {
      // The bridge swallowed this Agent call; only its hook update leaked to the root.
      absorbHook(frame, id);
      return;
    }
    if (!state) {
      const facts = mergeToolFacts(null, frame, agentType);
      const cls = classifyTool(agentType, facts);
      if (cls.type === "suppress") {
        suppressed.add(id);
        return;
      }
      const parentId = frameParent(frame) ?? timeWindowParent(id, facts);
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
    // Without native sessions, each top-level background launch owes one autonomous result (§2.4).
    if (isBackgroundLaunch(state) && state.parentId === null && !backgroundLaunches.has(state.id)) backgroundLaunches.set(state.id, roundIndex);

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
    // A child session's notice (codex-acp warns once per thread it starts) belongs to its agent (PR 5 §3.7).
    const session = frameSession(frame);
    const parentId = session ? agentOfSession(session)?.id ?? null : null;
    boundary(parentId);
    const id = uniqueId(`ntc:${++noticeCounter}`);
    const at = now();
    write("item.completed", { id, parent_id: parentId, status: "completed", started_at: at, completed_at: at, type: "notice",
      ...noticeFields(frame) }, true);
  };

  /**
   * An AIR session failure becomes a notice. A child session's failure is a
   * notice under its agent (PR 5 §3.7) and never fails the root turn; the
   * child's other session info (Codex thread status, titles) is ignored.
   */
  const onSessionInfo = (frame: VendorFrame): void => {
    const failure = readSessionFailure(frame._meta);
    if (!failure) return;
    const session = frameSession(frame);
    const parentId = session ? agentOfSession(session)?.id ?? null : null;
    const key = session ? `${session}\u0000${failure.id}` : failure.id;
    const previous = failures.get(key);
    if (previous !== undefined && previous >= failure.revision) return;
    failures.set(key, failure.revision);
    let id = failureIds.get(key);
    if (id === undefined) {
      boundary(parentId);
      id = session ? uniqueId(`fail:${failure.id}`) : `fail:${failure.id}`;
      usedIds.add(id);
      failureIds.set(key, id);
    }
    const existing = items.get(id);
    const at = now();
    write("item.completed", { id, parent_id: parentId, status: "completed", started_at: existing?.started_at ?? at, completed_at: at,
      type: "notice", ...sessionFailureNotice(failure) }, true);
  };

  const onUsage = (frame: VendorFrame): void => {
    // A subagent's context occupancy is its own (PR 5 §1.4).
    if (parentToolUseId(frame) || frameSession(frame)) return;
    const used = frame.used;
    const size = frame.size;
    // `size == 0` frames are billing-only (usage-bridge-patches.ts); billing rides `_meta.remiUsageUnits`.
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || typeof size !== "number" || !(size > 0)) return;
    if (contextUsage && contextUsage.used === used && contextUsage.size === size) return;
    contextUsage = { used, size };
    patchTurn({ context_usage: { used, size } });
  };

  const onModel = (frame: VendorFrame): void => {
    if (parentToolUseId(frame) || frameSession(frame)) return;
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
        frameOrder++;
        onAutonomousMarker(frame);
        noteRequestModel(frame);
        inferBackground(frame);
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
          case "subagent_spawned":
            onSpawned(frame);
            break;
          case "subagent_state_update":
            onSubagentState(frame);
            break;
          default:
            // user_message_chunk, available_commands_update, current_mode_update,
            // async_task_*, state_update, terminal_* and unknown kinds.
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
      roundIndex++;
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

    subagentOfSession(sessionId) {
      const agent = agentOfSession(sessionId ?? null);
      return agent ? { item_id: agent.id, name: agent.item.name?.trim() || agent.item.title?.trim() || "" } : null;
    },

    get owesAutonomousRound() {
      if (!autonomousOrigins.size) return false;
      for (const agent of natives.values()) {
        if (agent.parentId !== null || agent.item.background !== true) continue;
        if (agent.item.status === "in_progress") return true;
        // Ended after the last autonomous result; neither a root tool result nor a later prompt carried its notification since.
        if (agent.endedOrder !== null && agent.endedOrder > lastMarkerOrder && !(lastToolResultOrder > agent.endedOrder)
          && !(lastResultRound > agent.endedRound)) return true;
      }
      const latestLaunch = Math.max(-1, ...backgroundLaunches.values());
      return backgroundLaunches.size > markersSinceLaunch && !(lastResultRound > latestLaunch);
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
