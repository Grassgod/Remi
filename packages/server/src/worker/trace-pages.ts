/**
 * The two `trace.read` views over a {@link TraceStore} (PR 2 §1.3, §3.2). The
 * daemon transport answers the socket RPC with these, and the server's in-memory
 * reader (tests, in-process wiring) answers through the same functions, so both
 * paths page a trace identically.
 *
 * - `turn`: a running trace pages the fold; a closed one pages its persisted
 *   snapshot parts; a v1 file answers `format: "legacy"` with no turn and no items.
 * - `events`: raw stored lines after `after_seq`, v1 lines included.
 */

import {
  isTraceEvent,
  type TraceEventPage,
  type TraceItem,
  type TraceTurn,
  type TraceTurnPage,
} from "@multiremi/contracts/trace.js";
import { pageTurnTrace, turnTraceStats, TurnTraceFold, type TurnTraceState } from "@shared/turn-trace.js";
import type { TraceStore } from "./trace-store.js";

/** Store reads used to rebuild a fold; a page this large is one stored read. */
const FOLD_READ_LIMIT = 500;
const FOLD_READ_BYTES = 1024 * 1024;

export interface TraceTurnPageRequest {
  /** Index of the first item to return. */
  itemCursor: number;
  /** At most this many items (at least one is returned when any remain). */
  limit: number;
  /** Serialized-size budget of the items after the first. */
  maxBytes: number;
}

export interface TraceEventPageRequest {
  /** Exclusive cursor. */
  afterSeq: number;
  limit: number;
  maxBytes: number;
}

/** A fold of every v2 event a trace holds, plus how many lines it stores. */
export interface RebuiltTraceFold {
  fold: TurnTraceFold;
  /** Event lines stored, valid or not; equals `head` for a dense trace. */
  eventCount: number;
}

/**
 * Fold a stored trace from its first line. Lines that are not v2 events (a v1
 * file's fragments, a type this reader does not know) are counted, not folded.
 */
export function foldStoredTrace(store: TraceStore, taskId: string): RebuiltTraceFold {
  const entry: RebuiltTraceFold = { fold: new TurnTraceFold(), eventCount: 0 };
  if (store.format(taskId) === null) return entry;
  let after = 0;
  for (;;) {
    const page = store.read(taskId, after, FOLD_READ_LIMIT, FOLD_READ_BYTES);
    entry.eventCount += page.events.length;
    entry.fold.apply(page.events.filter(isTraceEvent));
    if (page.eof || !page.events.length) break;
    after = page.events.at(-1)!.seq;
  }
  return entry;
}

/** The answer for a v1 file: no turn, no items. The UI shows nothing; `view=events` has the raw lines. */
export function legacyTurnPage(head: { head: number; closed: boolean }): TraceTurnPage {
  return { view: "turn", format: "legacy", turn: null, items: [], next_item_cursor: null, head: head.head, closed: head.closed };
}

/**
 * One page of a running fold. The turn's `stats` are the live statistics of the
 * whole fold rather than the zeros `turn.started` carried, so a reader that needs
 * counts (organizer inspection) gets them from one page.
 */
export function runningTurnPage(state: TurnTraceState, request: TraceTurnPageRequest): TraceTurnPage {
  const turn: TraceTurn | null = state.turn ? { ...state.turn, stats: turnTraceStats(state.items) } : null;
  return pageTurnTrace({ ...state, turn, closed: false }, request);
}

/**
 * Page a closed trace's snapshot parts by global item index. `partSizes` caches
 * the item count of each part read so far, so a later page reads only the parts
 * it returns; pass the same array back for the same trace.
 */
export function snapshotTurnPage(
  store: TraceStore,
  taskId: string,
  head: number,
  request: TraceTurnPageRequest,
  partSizes: number[] = [],
): TraceTurnPage {
  const cursor = Math.max(0, Math.floor(request.itemCursor));
  const limit = Math.max(1, Math.floor(request.limit));
  const items: TraceItem[] = [];
  let turn: TraceTurn | null = null;
  let parts = Number.POSITIVE_INFINITY;
  let offset = 0;
  let bytes = 0;
  let more = false;
  for (let part = 0; part < parts && !more; part++) {
    const known = partSizes[part];
    if (known !== undefined && turn !== null && offset + known <= cursor) {
      offset += known;
      continue;
    }
    const snapshot = store.snapshotPart(taskId, part);
    if (!snapshot) break;
    turn = snapshot.turn;
    parts = snapshot.parts;
    partSizes[part] = snapshot.items.length;
    for (let i = Math.max(0, cursor - offset); i < snapshot.items.length; i++) {
      const item = snapshot.items[i]!;
      const size = Buffer.byteLength(JSON.stringify(item), "utf8");
      if (items.length >= limit || (items.length > 0 && bytes + size > request.maxBytes)) {
        more = true;
        break;
      }
      items.push(item);
      bytes += size;
    }
    offset += snapshot.items.length;
  }
  return { view: "turn", format: "v2", turn, items, next_item_cursor: more ? cursor + items.length : null, head, closed: true };
}

/**
 * One `view=turn` page of a stored trace, or null when the store has never seen
 * it. `live` supplies the running fold when the caller keeps one (the daemon
 * transport); without it the fold is rebuilt from the stored lines.
 */
export function readTurnPage(
  store: TraceStore,
  taskId: string,
  request: TraceTurnPageRequest,
  live?: () => TurnTraceState,
  partSizes?: number[],
): TraceTurnPage | null {
  const head = store.head(taskId);
  if (!head) return null;
  if (store.format(taskId) === "v1") return legacyTurnPage(head);
  if (!head.closed) {
    const state = live ? live() : foldStoredTrace(store, taskId).fold.state();
    // Lines the fold skips (a newer producer's types) still count toward the stored head.
    return runningTurnPage({ ...state, head: Math.max(state.head, head.head) }, request);
  }
  return snapshotTurnPage(store, taskId, head.head, request, partSizes);
}

/** One `view=events` page: raw stored lines (v1 fragments included), or null for a trace the store has never seen. */
export function readEventPage(store: TraceStore, taskId: string, request: TraceEventPageRequest): TraceEventPage | null {
  const head = store.head(taskId);
  if (!head) return null;
  const page = store.read(taskId, request.afterSeq, request.limit, request.maxBytes);
  return {
    view: "events",
    format: store.format(taskId) === "v1" ? "legacy" : "v2",
    events: page.events,
    next_after_seq: page.events.at(-1)?.seq ?? request.afterSeq,
    head: page.head,
    eof: page.eof,
    closed: head.closed,
  };
}
