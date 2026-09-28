/**
 * The replica sync protocol (MUL-403 C7 §5, plan 3/6 §1).
 *
 * Six steps, in the plan's order:
 *
 * 1. open a session — read `heads` for `have`, subscribe from `have + 1`;
 * 2. apply `stream.ack` — a changed `log_version` drops the session, a `gap`
 *    (or a hole discovered while applying frames) is backfilled through the read
 *    route until `first_seq`, then frames replay;
 * 3. an `entry` frame inserts and extends coverage, a `patch` frame updates in
 *    place and writes a new `revision`;
 * 4. every write updates `heads`;
 * 5. offline catch-up is not a special path: `from_seq` comes from the database,
 *    so a reconnect is step 1 again and only the missing tail is asked for;
 * 6. freshness is `log_version` equality **and** `head_seq` equality.
 *
 * This module is the decision half of the protocol: it is pure, so the cases
 * that actually break a replica (a patch above the head, a replayed frame, a
 * hole the frames themselves leave behind, a `log_version` flip) are testable
 * without a Worker, OPFS or a socket. The Worker owns only storage.
 */

import type { HubFrame, HubSeqRange, HubStreamAckPayload } from "@multiremi/contracts/live-hub";
import type { SessionLogEntry } from "./port";
import { addRange, highestCoveredSeq, normalizeRanges, type SeqRange } from "./ranges";

/** A session's sync state; this is the row `heads` holds, one per session. */
export interface ReplicaState {
  /**
   * Sparse coverage: which seqs the replica knows the outcome of.
   *
   * Coverage is monotone — the log's seq axis is append-only, so a seq is either
   * unknown or settled, and "settled" includes seqs whose row is hidden or
   * tombstoned. That is why nothing here ever shrinks it: a delete removes a row
   * from `entries`, not from the replica's knowledge.
   */
  ranges: SeqRange[];
  /**
   * Newest `seq` the replica holds, or null before the first write.
   *
   * This is also the cursor step 1 resumes from (`from_seq = head + 1`), which is
   * what makes offline catch-up a ranged read instead of a re-read: the frames
   * that arrived while the tab was offline are addressed by the seq the replica
   * already reached, not by a fresh window query.
   */
  head: number | null;
  /** The `log_version` of the last ack; null until one arrives. */
  logVersion: number | null;
  /** True once an ack has been applied, which is what makes freshness a verdict. */
  synced: boolean;
}

export function emptyReplicaState(): ReplicaState {
  return { ranges: [], head: null, logVersion: null, synced: false };
}

/** The `from_seq` step 1 sends: `have + 1`, from the database, never from a query. */
export function subscribeFromSeq(state: ReplicaState): number {
  return (state.head ?? 0) + 1;
}

/** What applying one frame batch changed. */
export interface FrameApplyResult {
  /** Rows to upsert, already collapsed per seq (last write wins within the batch). */
  upserts: SessionLogEntry[];
  /** Rows to delete: a hidden marker removes its own seq, an edit can tombstone. */
  deletes: number[];
  state: ReplicaState;
  /**
   * The first hole the batch exposed, if it exposed one.
   *
   * A frame that arrives above `head + 1` means the seqs between are missing; the
   * caller backfills exactly `[from, head]` through the read route and then
   * continues with the frames it already has. Reporting the gap rather than
   * silently accepting the jump is what keeps `head` meaning "the replica holds
   * this much, in order".
   */
  missing: HubSeqRange | null;
}

/**
 * Apply one frame batch onto a replica window.
 *
 * `entries` is what the replica currently holds for this session, keyed by
 * `seq`. The caller passes the rows it read from storage, so realtime frames and
 * backfilled rows run through the same code and a patch always lands on the
 * revision the replica actually has.
 */
export function applyFrames(input: {
  frames: readonly HubFrame[];
  state: ReplicaState;
  entries: ReadonlyMap<number, SessionLogEntry>;
}): FrameApplyResult {
  const upserts = new Map<number, SessionLogEntry>();
  const deletes = new Set<number>();
  let ranges = input.state.ranges.map((range) => ({ ...range }));

  for (const frame of input.frames) {
    if (frame.kind === "patch") {
      // A patch addresses a row the replica already holds. Without that row there
      // is nothing to update; the seq is left to the coverage walk below, which
      // either reports it as a hole to read or finds it already covered (a hidden
      // marker keeps coverage without keeping a row).
      const target = patchTargetSeq(frame.payload, frame);
      const held = input.entries.get(target) ?? upserts.get(target) ?? null;
      if (held === null) continue;
      const patched = applyPatch(held, frame.payload);
      if (patched === null) {
        // A tombstone removes the display row but not the seq: the log's axis is
        // append-only, so seq 7 stays "settled, no row" exactly like a hidden
        // marker. Dropping coverage here would make the next sync re-read a seq
        // that can never come back.
        deletes.add(target);
        upserts.delete(target);
        ranges = addRange(ranges, target, target);
        continue;
      }
      upserts.set(target, patched);
      continue;
    }

    const parsed = frameAsEntry(frame);
    if (parsed === null) continue;

    if (parsed.hidden) {
      // A hidden marker is not a display unit, so it never lands in `entries`; it
      // is still covered, because the server does have a row here and re-reading
      // it on every sync would be an infinite backfill.
      deletes.add(parsed.seq);
      upserts.delete(parsed.seq);
      ranges = addRange(ranges, parsed.seq, parsed.seq);
      continue;
    }

    upserts.set(parsed.seq, parsed.entry);
    ranges = addRange(ranges, parsed.seq, parsed.seq);
  }

  const normalized = normalizeRanges(ranges);
  const previousHead = input.state.head;
  const missing = firstHole(normalized, previousHead);
  return {
    upserts: [...upserts.values()],
    deletes: [...deletes],
    state: {
      ranges: normalized,
      // The head only moves when the run reaching it is contiguous. A batch that
      // arrives above a hole leaves the head where it was and reports the hole:
      // advancing it would make a later handoff resume past rows the replica
      // never read, and the plan requires the head to stay contiguous.
      head: contiguousHead(normalized, previousHead),
      logVersion: input.state.logVersion,
      synced: input.state.synced,
    },
    missing,
  };
}

/**
 * The end of the contiguous run that starts right after `previousHead`.
 *
 * This is what keeps the head the resume cursor: it advances only over seqs the
 * replica holds *in order*, so a frame that lands above a hole leaves the head
 * where it was until the hole is read. Using the newest covered seq instead would
 * make a reconnect resume past rows that were never written, which is the one
 * failure the plan's "head 必须连续" rule exists to prevent.
 */
export function contiguousHead(ranges: readonly SeqRange[], previousHead: number | null): number | null {
  const normalized = normalizeRanges(ranges);
  let cursor = (previousHead ?? 0) + 1;
  for (const range of normalized) {
    if (range.to < cursor) continue;
    if (range.from > cursor) break;
    cursor = range.to + 1;
  }
  const reached = cursor - 1;
  return reached > (previousHead ?? 0) ? reached : previousHead;
}

/**
 * The first uncovered run between the replica's head and its newest row.
 *
 * One range at a time: filling it can expose the next one and the caller loops.
 * Reporting every missing seq would turn a 50-row backlog into 50 reads.
 *
 * The walk starts at `previousHead + 1` and stops at the newest covered seq, so a
 * legal sparse window *below* the head (a deep link) is not treated as a hole —
 * it is not on the resume path at all.
 */
export function firstHole(ranges: readonly SeqRange[], previousHead: number | null): HubSeqRange | null {
  const normalized = normalizeRanges(ranges);
  const newest = highestCoveredSeq(normalized);
  if (newest === null) return null;
  let cursor = (previousHead ?? 0) + 1;
  if (newest < cursor) return null;
  for (const range of normalized) {
    if (range.to < cursor) continue;
    if (range.from > cursor) return { from: cursor, to: Math.min(range.from - 1, newest) };
    if (range.to >= newest) return null;
    cursor = range.to + 1;
  }
  return cursor <= newest ? { from: cursor, to: newest } : null;
}

/** The `target_seq` a patch addresses, falling back to the frame's own `seq`. */
function patchTargetSeq(payload: unknown, frame: HubFrame): number {
  if (payload && typeof payload === "object" && "target_seq" in payload) {
    const target = (payload as { target_seq?: unknown }).target_seq;
    if (typeof target === "number" && Number.isFinite(target)) return target;
  }
  return frame.seq;
}

/** The row's `revision`, defaulting to 0 so an older producer still round-trips. */
function payloadRevision(payload: unknown): number {
  if (payload && typeof payload === "object" && "revision" in payload) {
    const revision = (payload as { revision?: unknown }).revision;
    if (typeof revision === "number" && Number.isFinite(revision)) return revision;
  }
  return 0;
}

interface ParsedFrame {
  seq: number;
  entry: SessionLogEntry;
  hidden: boolean;
}

/**
 * Turn an `entry` frame into a row.
 *
 * Nothing here validates the row's shape beyond what the window needs, because
 * the frame's owner is B0/B1: an unknown `kind` still renders, and a missing
 * `body_html` is the documented degrade path rather than an error.
 */
function frameAsEntry(frame: HubFrame): ParsedFrame | null {
  const payload = frame.payload;
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  const sessionId = typeof row.session_id === "string" ? row.session_id : null;
  if (sessionId === null) return null;
  const seq = typeof row.seq === "number" && Number.isFinite(row.seq) ? row.seq : frame.seq;
  if (row.visibility === "hidden") {
    return {
      seq,
      hidden: true,
      entry: {
        session_id: sessionId,
        seq,
        id: typeof row.id === "string" ? row.id : `${sessionId}:${seq}`,
        revision: payloadRevision(row),
        kind: "hidden",
        body_html: null,
        render_version: null,
        body_md: "",
      },
    };
  }
  return {
    seq,
    hidden: false,
    entry: {
      session_id: sessionId,
      seq,
      id: typeof row.id === "string" ? row.id : `${sessionId}:${seq}`,
      revision: payloadRevision(row),
      kind: typeof row.kind === "string" ? row.kind : "unknown",
      body_html: typeof row.body_html === "string" ? row.body_html : null,
      render_version: typeof row.render_version === "string" ? row.render_version : null,
      body_md: typeof row.body_md === "string" ? row.body_md : "",
    },
  };
}

/**
 * In-place update. Only the fields the patch carries change, so a hidden-marker
 * patch and an edit use one path; `deleted_at` removes the row entirely.
 */
function applyPatch(entry: SessionLogEntry, payload: unknown): SessionLogEntry | null {
  if (!payload || typeof payload !== "object") return entry;
  const patch = payload as Record<string, unknown>;
  if (typeof patch.deleted_at === "string" && patch.deleted_at.length > 0) return null;
  const fields = (patch.fields && typeof patch.fields === "object" ? patch.fields : patch) as Record<string, unknown>;
  const revision = payloadRevision(patch);
  return {
    session_id: entry.session_id,
    seq: entry.seq,
    id: typeof patch.id === "string" ? patch.id : entry.id,
    // A patch that does not carry a revision still bumps it: the body changed,
    // and the height cache keys off `revision`, so keeping the old number would
    // serve the old row's reserved height to the new body.
    revision: revision > entry.revision ? revision : entry.revision + 1,
    kind: typeof fields.kind === "string" ? fields.kind : entry.kind,
    body_html:
      typeof fields.body_html === "string" || fields.body_html === null
        ? (fields.body_html as string | null)
        : entry.body_html,
    render_version:
      typeof fields.render_version === "string" || fields.render_version === null
        ? (fields.render_version as string | null)
        : entry.render_version,
    body_md: typeof fields.body_md === "string" ? fields.body_md : entry.body_md,
  };
}

/** What the replica does with a `stream.ack` (protocol step 2). */
export interface AckDecision {
  /** `log_version` moved: every row for the session is suspect and must be dropped. */
  reset: boolean;
  /** Range to read through the read route before replaying frames. */
  backfill: HubSeqRange | null;
  state: ReplicaState;
}

/**
 * Decide what an ack means for the local state (protocol step 2).
 *
 * `reset` and `backfill` are separate because they cost different things: a
 * `log_version` change invalidates every stored row (the render pipeline or the
 * session was rewritten) and restarts from the ack's `first_seq`, while a `gap`
 * means the rows already held are still valid and only the named range is
 * missing. Collapsing them into one "refetch" would either drop good rows or
 * keep stale ones.
 */
export function decideAck(ack: HubStreamAckPayload, current: ReplicaState): AckDecision {
  const logVersion = ack.log_version ?? null;
  const changed =
    current.synced && current.logVersion !== null && logVersion !== null && current.logVersion !== logVersion;

  if (changed) {
    const firstSeq = Number.isFinite(ack.first_seq) ? ack.first_seq : 1;
    return {
      reset: true,
      backfill: firstSeq > 1 ? { from: 1, to: firstSeq - 1 } : null,
      state: { ...emptyReplicaState(), logVersion, synced: true },
    };
  }

  return {
    reset: false,
    backfill: ack.gap ?? null,
    state: { ...current, logVersion, synced: true },
  };
}

/**
 * Freshness (protocol step 6): equal `log_version` **and** equal `head_seq`.
 *
 * `head_seq` alone cannot see an in-place update — a patched row keeps its seq —
 * which is exactly why the ack carries both numbers. A replica that has never
 * received an ack is not fresh, however complete its window looks.
 */
export function computeFresh(input: {
  state: ReplicaState;
  ackHeadSeq: number | null;
  ackLogVersion: number | null;
}): boolean {
  if (!input.state.synced) return false;
  if (input.ackHeadSeq === null || input.ackLogVersion === null) return false;
  if (input.state.logVersion === null) return false;
  if (input.state.logVersion !== input.ackLogVersion) return false;
  const head = input.state.head ?? 0;
  return head === input.ackHeadSeq;
}

/** The newest covered seq, recomputed from ranges (storage round-trip helper). */
export function headFromRanges(ranges: readonly SeqRange[]): number | null {
  return highestCoveredSeq(ranges);
}
