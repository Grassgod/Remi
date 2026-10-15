/**
 * The one fold over a turn + items trace (PR 2). The daemon (completion summary,
 * `trace.read view=turn`), the web (transcript, Chat steps), Feishu, the CLI and
 * the organizer all read a trace through this module, so they agree on item
 * order, the final reply and the tool count by construction.
 *
 * Event rules (spec §1.4):
 * - `turn.started` / `turn.completed` replace the turn; `turn.updated` merges its
 *   patch. A turn event at or below the seq the turn already reflects is skipped.
 * - `item.started` / `item.updated` / `item.completed` upsert by `id`, keeping the
 *   first-seen position. An upsert at or below the item's `seq` is skipped.
 * - `item.delta` appends only while the item is `in_progress` and only when
 *   `event.seq > item.seq`.
 * - Applying an event sets `item.seq = event.seq`.
 *
 * So replaying events at or below a snapshot's head, or stitching pages taken at
 * different heads, is idempotent. A `stream.gap` refetches a page and replaces
 * the state ({@link turnTraceFromPage}).
 *
 * Pure: no I/O, no clock, no platform APIs. Relative imports are extensionless
 * because the web bundles this module and its webpack setup cannot resolve `.js`
 * specifiers against TS sources.
 */

import type { DaemonTaskCompletionFields } from "@multiremi/contracts/daemon-protocol";
import {
  TRACE_TOOL_ITEM_TYPES,
  type TraceAgentMessageItem,
  type TraceEventBody,
  type TraceHistogramBucket,
  type TraceItem,
  type TraceItemStatus,
  type TraceTurn,
  type TraceTurnPage,
  type TraceTurnPatch,
  type TraceTurnSnapshot,
  type TraceTurnStats,
  type TraceTurnStatus,
  type TraceEvent,
} from "@multiremi/contracts/trace";
import { utf8ByteLength } from "./utf8";

/** Reader state of one turn trace. Treat as immutable; every update returns a new object. */
export interface TurnTraceState {
  readonly turn: TraceTurn | null;
  /** Every item at any depth, in first-seen order. */
  readonly items: readonly TraceItem[];
  /** Highest seq applied from events or reported by a page. */
  readonly head: number;
  /** Seq the `turn` object reflects (its last turn event, or the page head it came from). */
  readonly turnSeq: number;
  /** True once the trace is sealed (page `closed`, `stream.closed`). */
  readonly closed: boolean;
}

export const EMPTY_TURN_TRACE: TurnTraceState = Object.freeze({
  turn: null,
  items: Object.freeze([]) as readonly TraceItem[],
  head: 0,
  turnSeq: 0,
  closed: false,
});

const TOOL_TYPES: ReadonlySet<string> = new Set(TRACE_TOOL_ITEM_TYPES);

export function isToolItem(item: TraceItem): boolean {
  return TOOL_TYPES.has(item.type);
}

// ── Draft: the shared mutation core ─────────────────────────────────────────

/**
 * Working copy for one batch. `items` and `index` start shared with the input
 * state and are copied on first write, so a batch that changes nothing returns
 * the input state itself and an item that did not change keeps its identity.
 */
interface Draft {
  turn: TraceTurn | null;
  items: TraceItem[];
  index: Map<string, number>;
  head: number;
  turnSeq: number;
  closed: boolean;
  ownsItems: boolean;
  ownsIndex: boolean;
  changed: boolean;
}

/** Index of an items array by id, cached per array. */
const INDEX_CACHE = new WeakMap<readonly TraceItem[], Map<string, number>>();

function indexOf(items: readonly TraceItem[]): Map<string, number> {
  let index = INDEX_CACHE.get(items);
  if (!index) {
    index = new Map();
    items.forEach((item, position) => index!.set(item.id, position));
    INDEX_CACHE.set(items, index);
  }
  return index;
}

function openDraft(state: TurnTraceState): Draft {
  return {
    turn: state.turn,
    items: state.items as TraceItem[],
    index: indexOf(state.items),
    head: state.head,
    turnSeq: state.turnSeq,
    closed: state.closed,
    ownsItems: false,
    ownsIndex: false,
    changed: false,
  };
}

function closeDraft(state: TurnTraceState, draft: Draft): TurnTraceState {
  if (!draft.changed) return state;
  if (draft.ownsItems) INDEX_CACHE.set(draft.items, draft.index);
  return { turn: draft.turn, items: draft.items, head: draft.head, turnSeq: draft.turnSeq, closed: draft.closed };
}

function writeItem(draft: Draft, position: number | undefined, item: TraceItem): void {
  if (!draft.ownsItems) {
    draft.items = draft.items.slice();
    draft.ownsItems = true;
  }
  if (position === undefined) {
    if (!draft.ownsIndex) {
      draft.index = new Map(draft.index);
      draft.ownsIndex = true;
    }
    draft.index.set(item.id, draft.items.length);
    draft.items.push(item);
  } else {
    draft.items[position] = item;
  }
  draft.changed = true;
}

function setHead(draft: Draft, seq: number): void {
  if (seq > draft.head) {
    draft.head = seq;
    draft.changed = true;
  }
}

function definedPatch(patch: TraceTurnPatch): TraceTurnPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) out[key] = value;
  return out as TraceTurnPatch;
}

function appendField(item: TraceItem, field: "text" | "output", delta: string): TraceItem | null {
  if (field === "text") {
    if (item.type !== "agent_message" && item.type !== "reasoning" && item.type !== "user_message") return null;
    return { ...item, text: item.text + delta };
  }
  switch (item.type) {
    case "command":
    case "file_change":
    case "web_search":
    case "tool":
    case "subagent":
      return { ...item, output: (item.output ?? "") + delta };
    default:
      return null;
  }
}

function applyEvent(draft: Draft, event: TraceEvent): void {
  const seq = event.seq;
  if (!Number.isSafeInteger(seq) || seq < 1) return;
  switch (event.type) {
    case "turn.started":
    case "turn.completed":
      if (seq > draft.turnSeq) {
        draft.turn = event.turn;
        draft.turnSeq = seq;
        draft.changed = true;
      }
      break;
    case "turn.updated":
      if (draft.turn && seq > draft.turnSeq) {
        draft.turn = { ...draft.turn, ...definedPatch(event.patch) };
        draft.turnSeq = seq;
        draft.changed = true;
      }
      break;
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const position = draft.index.get(event.item.id);
      const existing = position === undefined ? undefined : draft.items[position];
      if (existing && (existing.seq ?? 0) >= seq) break;
      writeItem(draft, position, { ...event.item, seq });
      break;
    }
    case "item.delta": {
      const position = draft.index.get(event.item_id);
      const existing = position === undefined ? undefined : draft.items[position];
      if (!existing || existing.status !== "in_progress" || (existing.seq ?? 0) >= seq) break;
      const next = appendField(existing, event.field, event.delta);
      if (next) writeItem(draft, position, { ...next, seq });
      break;
    }
    default:
      // Unknown event types are skipped; they still advance the head.
      break;
  }
  setHead(draft, seq);
}

function applyPage(draft: Draft, page: TraceTurnPage): void {
  if (page.turn && page.head >= draft.turnSeq && page.turn !== draft.turn) {
    draft.turn = page.turn;
    draft.turnSeq = page.head;
    draft.changed = true;
  }
  for (const item of page.items) {
    // A page item reflects every event up to the page head.
    const seq = item.seq ?? page.head;
    const position = draft.index.get(item.id);
    const existing = position === undefined ? undefined : draft.items[position];
    if (existing && (existing.seq ?? 0) >= seq) continue;
    writeItem(draft, position, item.seq === seq ? item : { ...item, seq });
  }
  setHead(draft, page.head);
  if (page.closed && !draft.closed) {
    draft.closed = true;
    draft.changed = true;
  }
}

// ── Immutable API (web, Feishu presentation) ────────────────────────────────

/** Apply live events in order. Returns `state` itself when nothing changed. */
export function applyTurnTraceEvents(state: TurnTraceState, events: readonly TraceEvent[]): TurnTraceState {
  if (events.length === 0) return state;
  const draft = openDraft(state);
  for (const event of events) applyEvent(draft, event);
  return closeDraft(state, draft);
}

export function applyTurnTraceEvent(state: TurnTraceState, event: TraceEvent): TurnTraceState {
  return applyTurnTraceEvents(state, [event]);
}

/**
 * Merge one `view=turn` page. Apply a read's pages in cursor order before the
 * live events that follow it; items keep the order they are first seen in. A
 * legacy (v1) page carries no turn and no items, so the state stays empty.
 */
export function applyTurnTracePage(state: TurnTraceState, page: TraceTurnPage): TurnTraceState {
  const draft = openDraft(state);
  applyPage(draft, page);
  return closeDraft(state, draft);
}

/** Fresh state from a first page; also the reset after a `stream.gap`. */
export function turnTraceFromPage(page: TraceTurnPage): TurnTraceState {
  return applyTurnTracePage(EMPTY_TURN_TRACE, page);
}

export function turnTraceFromSnapshot(snapshot: TraceTurnSnapshot): TurnTraceState {
  return turnTraceFromPage({
    view: "turn",
    format: "v2",
    turn: snapshot.turn,
    items: snapshot.items,
    next_item_cursor: null,
    head: snapshot.head,
    closed: snapshot.closed,
  });
}

/** Mark the trace sealed (`stream.closed`). */
export function closeTurnTrace(state: TurnTraceState): TurnTraceState {
  return state.closed ? state : { ...state, closed: true };
}

// ── Mutable fold (daemon transport) ─────────────────────────────────────────

/**
 * The same rules as {@link applyTurnTraceEvents}, owned by one writer: the daemon
 * keeps one per running attempt and applies every stored batch, so it never
 * copies the item list. `state()` hands out an immutable view.
 */
export class TurnTraceFold {
  private draft: Draft;
  private applied = 0;

  constructor(initial: TurnTraceState = EMPTY_TURN_TRACE) {
    const draft = openDraft(initial);
    draft.items = draft.items.slice();
    draft.index = new Map(draft.index);
    draft.ownsItems = true;
    draft.ownsIndex = true;
    this.draft = draft;
  }

  apply(events: readonly TraceEvent[]): void {
    for (const event of events) {
      if (event.seq > this.draft.head) this.applied++;
      applyEvent(this.draft, event);
    }
  }

  /** Events applied with a new head; equals `event_count` for a dense trace. */
  get eventCount(): number {
    return this.applied;
  }

  get turn(): TraceTurn | null {
    return this.draft.turn;
  }

  get items(): readonly TraceItem[] {
    return this.draft.items;
  }

  get head(): number {
    return this.draft.head;
  }

  /** A snapshot of the current fold; later `apply` calls do not change it. */
  state(): TurnTraceState {
    const { turn, items, head, turnSeq, closed } = this.draft;
    const copy = items.slice();
    INDEX_CACHE.set(copy, new Map(this.draft.index));
    return { turn, items: copy, head, turnSeq, closed };
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export function topLevelItems(items: readonly TraceItem[]): TraceItem[] {
  return items.filter((item) => item.parent_id === null);
}

/** Direct children of a subagent item, in order. */
export function childItems(items: readonly TraceItem[], parentId: string): TraceItem[] {
  return items.filter((item) => item.parent_id === parentId);
}

function isFinalMessage(item: TraceItem): item is TraceAgentMessageItem {
  return item.type === "agent_message" && item.parent_id === null && item.phase === "final";
}

/**
 * The turn's final reply item: `finalItemId` when given (a completed turn's
 * `final_item_id`), otherwise the last top-level `agent_message` with
 * `phase: "final"`.
 */
export function finalItem(items: readonly TraceItem[], finalItemId?: string | null): TraceAgentMessageItem | null {
  if (finalItemId) {
    const item = items.find((candidate) => candidate.id === finalItemId);
    return item?.type === "agent_message" ? item : null;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (isFinalMessage(item)) return item;
  }
  return null;
}

/** Items that name a tool bucket under it; every other item buckets under null. */
function histogramTool(item: TraceItem): string | null {
  return "tool" in item && typeof item.tool === "string" ? item.tool : null;
}

/**
 * Item types the Chat fold never renders as process rows: the user's own
 * message, the permission / question exchanges (Chat has its own dock and
 * question UI for those; decision Q1 of PR 2), and reasoning, which only feeds
 * the live label (decision D-count).
 */
const NON_PROCESS_TYPES: ReadonlySet<TraceItem["type"]> = new Set(["user_message", "permission", "question", "reasoning"]);

/**
 * Whether a top-level item produces a row in the Chat fold (decision D-count):
 * anything but a final reply, a user message, a permission, a question,
 * reasoning, or an agent message with no visible text. The frontend's
 * `buildTurnSteps(items).processCount` must equal {@link processItemCount}.
 */
export function isProcessItem(item: TraceItem): boolean {
  if (item.parent_id !== null || NON_PROCESS_TYPES.has(item.type)) return false;
  return item.type !== "agent_message" || (item.phase !== "final" && item.text.trim().length > 0);
}

/**
 * Turn statistics. `tool_call_count` is the single tool-count rule:
 * `TRACE_TOOL_ITEM_TYPES` items at any depth. `process_item_count` counts
 * exactly what the Chat fold renders ({@link isProcessItem}). The histogram is
 * bucketed by `(type, tool)` in first-appearance order.
 */
export function turnTraceStats(items: readonly TraceItem[]): TraceTurnStats {
  const buckets = new Map<string, TraceHistogramBucket>();
  let toolCalls = 0;
  let processItems = 0;
  for (const item of items) {
    if (isToolItem(item)) toolCalls++;
    if (isProcessItem(item)) processItems++;
    const tool = histogramTool(item);
    const key = `${item.type}\u0000${tool ?? ""}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count++;
    else buckets.set(key, { type: item.type, tool, count: 1 });
  }
  return {
    item_count: items.length,
    tool_call_count: toolCalls,
    process_item_count: processItems,
    type_histogram: [...buckets.values()],
  };
}

export function processItemCount(items: readonly TraceItem[]): number {
  return turnTraceStats(items).process_item_count;
}

function elapsedMs(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

/** "Worked for": `final_started_at - started_at`, or null without a final reply. */
export function turnWorkedMs(turn: Pick<TraceTurn, "started_at" | "final_started_at"> | null): number | null {
  return turn ? elapsedMs(turn.started_at, turn.final_started_at) : null;
}

// ── Close (daemon transport) ────────────────────────────────────────────────

/**
 * `item.completed` bodies for every item still open when the attempt ends
 * (spec §2.3): tools become `stopped`; text, plans and steer/input messages
 * become `completed`, or `stopped` when the turn was cancelled; anything else
 * (permission, question, compaction, notice) becomes `stopped`.
 *
 * A background subagent (`background: true`, spec §13) is the exception among
 * tools: it stays open after its launch is acknowledged, and the bridge holds
 * the turn until it settles, so the turn's end is its end. It becomes
 * `completed`, with its duration, when the turn completed; a failed or
 * cancelled turn may have cut it short, so it becomes `stopped`.
 */
export function closeOpenItems(
  items: readonly TraceItem[],
  turnStatus: TraceTurnStatus,
  completedAt: string,
): TraceEventBody[] {
  const textStatus: TraceItemStatus = turnStatus === "cancelled" ? "stopped" : "completed";
  const out: TraceEventBody[] = [];
  for (const item of items) {
    if (item.status !== "in_progress") continue;
    const { seq: _seq, ...rest } = item;
    if (item.type === "subagent" && item.background === true) {
      out.push({ type: "item.completed", item: {
        ...rest, status: turnStatus === "completed" ? "completed" : "stopped", completed_at: completedAt,
        duration_ms: item.duration_ms ?? elapsedMs(item.started_at, completedAt),
      } as TraceItem });
      continue;
    }
    const status: TraceItemStatus = isToolItem(item) ? "stopped"
      : item.type === "agent_message" || item.type === "reasoning" || item.type === "user_message" || item.type === "plan"
        ? textStatus
        : "stopped";
    out.push({ type: "item.completed", item: { ...rest, status, completed_at: completedAt } as TraceItem });
  }
  return out;
}

/**
 * The `turn.completed` turn: status, error, timing, the final item and stats,
 * all derived from the fold. Call after the open items are closed.
 */
export function completeTurn(
  state: Pick<TurnTraceState, "turn" | "items">,
  outcome: { status: Exclude<TraceTurnStatus, "running">; error?: TraceTurn["error"]; completedAt: string },
): TraceTurn | null {
  if (!state.turn) return null;
  const final = finalItem(state.items);
  return {
    ...state.turn,
    status: outcome.status,
    error: outcome.error ?? null,
    completed_at: outcome.completedAt,
    duration_ms: elapsedMs(state.turn.started_at, outcome.completedAt),
    final_item_id: final?.id ?? null,
    final_started_at: final?.started_at ?? null,
    stats: turnTraceStats(state.items),
  };
}

/** The fold at its head as a snapshot, or null before `turn.started`. */
export function turnTraceSnapshot(state: TurnTraceState, closed: boolean = state.closed): TraceTurnSnapshot | null {
  if (!state.turn) return null;
  return { turn: state.turn, items: state.items.slice(), head: state.head, closed };
}

/**
 * One `view=turn` page from `itemCursor`: at most `limit` items and, after the
 * first, at most `maxBytes` of serialized items (UTF-8).
 */
export function pageTurnTrace(
  state: TurnTraceState,
  options: { itemCursor: number; limit: number; maxBytes: number },
): TraceTurnPage {
  const start = Math.max(0, Math.floor(options.itemCursor));
  const items: TraceItem[] = [];
  let bytes = 0;
  for (let i = start; i < state.items.length && items.length < Math.max(1, options.limit); i++) {
    const item = state.items[i]!;
    const size = utf8ByteLength(JSON.stringify(item));
    if (items.length > 0 && bytes + size > options.maxBytes) break;
    items.push(item);
    bytes += size;
  }
  const next = start + items.length;
  return {
    view: "turn",
    format: "v2",
    turn: state.turn,
    items,
    next_item_cursor: next < state.items.length ? next : null,
    head: state.head,
    closed: state.closed,
  };
}

/**
 * Completion fields for `task.complete` / `task.fail` (spec §3.5), from the fold
 * after `turn.completed`.
 */
export function turnCompletionFields(
  state: Pick<TurnTraceState, "turn" | "items" | "head">,
  counts: { eventCount: number },
): DaemonTaskCompletionFields {
  const stats = turnTraceStats(state.items);
  const turn = state.turn;
  const final = finalItem(state.items, turn?.final_item_id);
  const reply = final?.text.trim() ?? "";
  return {
    trace: {
      head: state.head,
      event_count: counts.eventCount,
      closed: true,
      tool_call_count: stats.tool_call_count,
      type_histogram: stats.type_histogram.map((bucket) => ({ ...bucket })),
    },
    final_reply_md: reply || null,
    model: turn?.provider && turn.model ? { provider: turn.provider, model: turn.model } : null,
    context_usage: turn?.context_usage ? { ...turn.context_usage } : null,
    worked_ms: turn?.final_started_at ? turnWorkedMs(turn) : null,
    process_item_count: stats.process_item_count,
  };
}

// ── Final reply (spec §2.4, the one rule) ───────────────────────────────────

export interface FinalReplySelection {
  /** The final item, or null when no top-level agent_message qualifies. */
  itemId: string | null;
  /** Its text, untrimmed; null without a final item. */
  text: string | null;
  /**
   * Rule 1 (`phase`: a bridge-labelled final), rule 2 (`inferred`, Claude) or
   * its fallback (`fallback`, decision D-final).
   */
  rule: "phase" | "inferred" | "fallback" | null;
  /**
   * Messages whose phase changes, already updated and without `seq`: the
   * translator re-emits each as `item.completed`, in this order.
   */
  reemit: TraceAgentMessageItem[];
}

/** Top-level items after which an `unknown` message is not the answer (rule 2). */
function blocksInferredFinal(item: TraceItem): boolean {
  // Claude's AskUserQuestion raises a question with no tool item (spec §11).
  return isToolItem(item) || item.type === "question";
}

/**
 * Choose the final reply among the top-level agent messages.
 *
 * 1. If any has `phase: "final"` from the bridge, the last one is final and the
 *    earlier ones become `commentary`.
 * 2. Otherwise take the last non-empty one with no top-level tool or question
 *    item after it and mark it `final`. Only `unknown`-phase messages qualify,
 *    and a `commentary` message after one blocks it like a tool does: a message
 *    the bridge labelled commentary is never the answer (as in today's
 *    `TraceFinalReplyAccumulator`). Claude labels nothing, so all of its
 *    messages are `unknown`. A question blocks because Claude's
 *    AskUserQuestion has no tool item.
 * 3. If rule 2 finds nothing (the turn ended on a tool or question after its
 *    last text), the last non-empty `unknown` message is final anyway
 *    (decision D-final): the old `LastAssistantMessage` behaviour, so such a
 *    turn does not regress to "Task completed.".
 *
 * `previousInferred` is the item an earlier call promoted by rule 2 or 3
 * (steer re-prompts call this once per round). Its `final` phase is ours, not
 * the bridge's, so rule 1 ignores it, and it is demoted to `unknown` when this
 * call picks another item or none.
 */
export function selectFinalReply(items: readonly TraceItem[], previousInferred: string | null = null): FinalReplySelection {
  const top = topLevelItems(items);
  const messages = top.filter((item): item is TraceAgentMessageItem => item.type === "agent_message");
  const reemit: TraceAgentMessageItem[] = [];
  const withPhase = (item: TraceAgentMessageItem, phase: TraceAgentMessageItem["phase"]) => {
    const { seq: _seq, ...rest } = item;
    reemit.push({ ...rest, phase });
  };
  // The previous pick is `unknown` underneath its promoted phase.
  const candidate = (item: TraceAgentMessageItem) =>
    (item.phase === "unknown" || item.id === previousInferred) && item.text.trim().length > 0;

  let chosen: TraceAgentMessageItem | null = null;
  let rule: FinalReplySelection["rule"] = null;
  const natives = messages.filter((item) => item.phase === "final" && item.id !== previousInferred);
  if (natives.length > 0) {
    chosen = natives[natives.length - 1]!;
    rule = "phase";
    for (const item of natives.slice(0, -1)) withPhase(item, "commentary");
  } else {
    for (let i = top.length - 1; i >= 0; i--) {
      const item = top[i]!;
      if (item.type === "agent_message") {
        if (candidate(item)) {
          chosen = item;
          rule = "inferred";
          break;
        }
        if (item.phase === "commentary") break;
      } else if (blocksInferredFinal(item)) {
        break;
      }
    }
    for (let i = messages.length - 1; !chosen && i >= 0; i--) {
      if (candidate(messages[i]!)) {
        chosen = messages[i]!;
        rule = "fallback";
      }
    }
    if (chosen && chosen.phase !== "final") withPhase(chosen, "final");
  }

  if (previousInferred && previousInferred !== chosen?.id) {
    const previous = messages.find((item) => item.id === previousInferred);
    if (previous && previous.phase !== "unknown") withPhase(previous, "unknown");
  }
  return { itemId: chosen?.id ?? null, text: chosen?.text ?? null, rule, reemit };
}

/**
 * The reply body: the final text, else the provider's own last response when
 * the turn produced no agent message at all, else "Task completed." (the
 * current `LastAssistantMessage.result` fallback).
 */
export function finalReplyBody(
  selection: Pick<FinalReplySelection, "text">,
  items: readonly TraceItem[],
  providerFallback?: string | null,
): string {
  const text = selection.text?.trim();
  if (text) return text;
  const sawMessage = items.some((item) => item.type === "agent_message");
  return (!sawMessage ? providerFallback?.trim() : "") || "Task completed.";
}
