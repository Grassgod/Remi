/**
 * The read-only seam between the browser replica and the flat session log
 * (MUL-403 C8 §5, `frontend/packages/views/common/session-log/`).
 *
 * Two implementations exist on purpose:
 *
 * - C8 (this issue) ships {@link MemorySessionReplica}, the in-memory one the
 *   unit tests and the zero-jump fixture page drive.
 * - C7 (MUL-442) implements the real one — Web Locks leader, DedicatedWorker,
 *   OPFS SQLite — against this same interface. 谁先合入 `agent/MUL-403` 谁定稿：
 *   this file is the first commit of C8, so it is the definition the other side
 *   aligns to.
 *
 * What the list needs from a replica and nothing more:
 *
 * - **the window entries** it renders, ascending by `seq`;
 * - **`fresh`** — the replica's own verdict that its head equals the server's
 *   (plan 3/6 §1.6: equal `log_version` *and* equal `head_seq`). The list never
 *   recomputes it from the entries it happens to hold; a window can be complete
 *   for its range and still stale, which is a different fact.
 * - **`head`** — the newest `seq` the replica holds, for the "N new messages"
 *   count and for the consumer's own bookkeeping.
 * - **`ready`** — the replica has answered for this session at least once, which
 *   is `useAnchoredReveal`'s `dataReady` gate ("副本窗口已就绪").
 * - **row heights** — read to reserve a row before it is measured, written back
 *   once it is (see {@link rowHeightKey}).
 *
 * The port is read-only in the sense that the list can only *read* the window;
 * the single write surface is the height cache, which is a measurement the list
 * itself produces rather than a change to the log.
 */

/** One display unit, as far as the flat list is concerned. */
export interface SessionLogEntry {
  session_id: string;
  /** Position on the session's seq axis; the window is ordered by it. */
  seq: number;
  /** Source row id (`cmt_*`, `sevt_*`, chat message id). Keys the DOM id. */
  id: string;
  /** Increments on every in-place update; part of the height-cache key. */
  revision: number;
  /** B1's `ConversationLogKind`, kept as a string: unknown kinds still render. */
  kind: string;
  /**
   * Server-rendered, sanitized body (C4's `renderMarkdown`). `null` until the
   * backfill has rendered the row, which is the degrade path: the list falls
   * back to rendering `body_md` on the client and counts `degraded_render`.
   */
  body_html: string | null;
  /** Pipeline that produced `body_html`; part of the height-cache key. */
  render_version: string | null;
  /** Raw markdown, the client-side fallback source. */
  body_md: string;
}

/**
 * B1's `ConversationLogEntry` is the full row: `(session_id, seq)` plus `id`,
 * `kind`, `visibility`, `author_type`, `author_id`, `task_id`, `body_md`,
 * `body_html`, `render_version`, `parent_id`, `metadata`, `revision`,
 * `created_at`, `updated_at`, `deleted_at`. {@link SessionLogEntry} restates the
 * subset C8 reads, so the full row is assignable to it without a cast; when B0
 * (`packages/contracts/src/conversation-log.ts`) reaches this branch, this
 * interface becomes a `Pick<>` of it — the same swap C0 documents for
 * `packages/server/src/api/hub/upstream-contracts.ts`.
 */
export type SessionLogEntryLike = SessionLogEntry;

/** One session's window plus the replica's own freshness verdict. */
export interface SessionReplicaSnapshot {
  sessionId: string;
  /** Ascending by `seq`. Sparse windows are legal: the replica may hold one. */
  entries: readonly SessionLogEntry[];
  /** Newest `seq` the replica holds, or null before the first sync. */
  head: number | null;
  /** Server `head_seq` agrees with {@link head} and `log_version` matches. */
  fresh: boolean;
  /** The replica has answered for this session at least once. */
  ready: boolean;
}

/**
 * The port. Every method is synchronous: the replica keeps its window in memory
 * and only its *writes* are asynchronous, so a reader never waits on storage.
 */
export interface SessionReplicaPort<
  TEntry extends SessionLogEntry = SessionLogEntry,
> {
  /**
   * Current window for one session. The returned object's identity must change
   * only when the window does — it feeds `useSyncExternalStore`, where a fresh
   * object per call is an infinite render loop.
   */
  getSnapshot(sessionId: string): SessionReplicaSnapshot & { entries: readonly TEntry[] };
  /** Notified when that session's window changes. Returns the unsubscribe. */
  subscribe(sessionId: string, listener: () => void): () => void;
  /** Cached height for one row variant and width bucket, or null when unmeasured. */
  readRowHeight(sessionId: string, seq: number, key: string): number | null;
  /** Record the measured height. Persisted by the real replica, in-memory here. */
  writeRowHeight(sessionId: string, seq: number, key: string, height: number): void;
}

/** The 8px width bucket from plan 3/6 §3: heights are cached per container width. */
export const ROW_HEIGHT_WIDTH_BUCKET_PX = 8;

/**
 * Floor a content width to its bucket.
 *
 * Flooring (not rounding) means a bucket only ever claims heights measured at
 * least that wide, so a narrower container never inherits a taller row's
 * reservation. Non-finite and negative widths fall back to 0 rather than
 * producing a `NaN` key that would silently collide for every row.
 */
export function widthBucket(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 0;
  return Math.floor(widthPx / ROW_HEIGHT_WIDTH_BUCKET_PX) * ROW_HEIGHT_WIDTH_BUCKET_PX;
}

export interface RowHeightKeyInput {
  /** The entry's `revision`. */
  revision: number;
  /** The entry's `render_version`; null on the degrade path. */
  renderVersion: string | null;
  /** Content width the height was measured at, in CSS pixels. */
  widthPx: number;
}

/** `"<revision>:<render_version>"`, the variant half of the cache key. */
export function renderVariant(revision: number, renderVersion: string | null): string {
  return `${revision}:${renderVersion ?? ""}`;
}

/**
 * Height-cache key from plan 3/6 §3: `(session_id, seq, "<revision>:<render_version>",
 * 宽度桶)`. `session_id` and `seq` are the port's own arguments, so this string
 * is the remaining pair. A row whose body was edited (revision) or re-rendered
 * by a new pipeline (render_version) has no cached height, which is correct: its
 * height can have changed.
 */
export function rowHeightKey(input: RowHeightKeyInput): string {
  return `${renderVariant(input.revision, input.renderVersion)}@${widthBucket(input.widthPx)}`;
}
