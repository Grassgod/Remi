"use client";

/**
 * SessionLogList — the flat session log both the Issue detail timeline and Chat
 * will mount (MUL-403 plan 3/6 §3, ADR 0007 §3).
 *
 * The list is deliberately not virtualized. It renders a bounded window of rows
 * in document order, capped at {@link SESSION_LOG_DOM_LIMIT}, and relies on three
 * facts that make a flat list cheaper than a virtualizer here:
 *
 * - the server rendered each row's body (`body_html`), so mounting a row is an
 *   `innerHTML` assignment rather than a markdown parse plus a Shiki round trip;
 * - its height is cached, so a row that has been seen before paints at its final
 *   size on the first frame;
 * - the reveal hook hides the whole list until the anchor has a position, so the
 *   first visible frame is already the final one.
 *
 * The two hooks are MUL-450's, consumed exactly as the plan prescribes:
 * `dataReady` is the replica's own "I have answered" gate, `fresh` is the
 * replica's `log_version` + `head_seq` verdict, `layoutSettled` is trivially
 * true for a flat list, and the budget stays at its default. Nothing here
 * implements stickiness or reveal: those are the hooks' jobs and the list only
 * renders what their state says.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { ArrowDown } from "lucide-react";
import type { SessionLogEntry, SessionReplicaPort } from "@multiremi/core/replica";
import { useAnchoredReveal, type RevealAnchor } from "../use-anchored-reveal";
import { useStickToBottom } from "../use-stick-to-bottom";
import { useT } from "../../i18n";
import { EntryHtml } from "./entry-html";
import { reservedRowHeight, useRowHeights, type MeasurableRow } from "./use-row-heights";

/** DOM ceiling from plan 5/6 §1: the newest end is kept, the oldest is dropped. */
export const SESSION_LOG_DOM_LIMIT = 300;

/** The chip's visual cap, per the design spec (`99+`). */
export const NEW_MESSAGE_DISPLAY_CAP = 99;

/** Stable identity for the empty window, so `useSyncExternalStore` sees no change. */
const EMPTY_SNAPSHOT = { sessionId: "", entries: [], head: null, fresh: false, ready: false } as const;

export interface SessionLogListRenderArgs {
  entry: SessionLogEntry;
  /** `min-height` from the height cache, or null when the row is unmeasured. */
  reservedHeight: number | null;
}

export interface SessionLogListProps {
  sessionId: string;
  /** The read-only replica port (C7 in production, the memory one in tests). */
  replica: SessionReplicaPort;
  /**
   * Where the reveal lands. `bottom` for a live session; an element anchor when
   * the caller opened a deep link and knows the row id.
   */
  anchor?: RevealAnchor;
  /** Changes force the reveal state machine to restart (session/deep-link switch). */
  resetKey?: string;
  /**
   * Rendered instead of `body_html` when the replica has not rendered the row
   * yet. The consumer supplies the client renderer; this component never
   * re-parses markdown itself.
   */
  renderFallback?: (entry: SessionLogEntry) => React.ReactNode;
  /**
   * Called once per row that had to render on the client because `body_html` was
   * missing — the `degraded_render` count from plan 3/6 §3. The list also
   * publishes its own running total on the scroll root as
   * `data-session-log-degraded`, so a probe can read it without a consumer.
   */
  onDegradedRender?: (entry: SessionLogEntry) => void;
  /** Rendered per row instead of the default `EntryHtml`. */
  renderEntry?: (args: SessionLogListRenderArgs) => React.ReactNode;
  /** What to render before the replica answers at all. */
  renderPending?: () => React.ReactNode;
  className?: string;
  /** Element carrying the scroll root's data attributes, for tests and probes. */
  testIdPrefix?: string;
  perfScroll?: "session-log" | "issue-detail";
  latestAnchor?: "latest-message" | "latest-comment";
  initialPositioned?: boolean;
  /** Local display preferences must be applied before the SSR list is shown. */
  initialDisplayReady?: boolean;
  /** Additional content above the anchor must settle before the list reveals. */
  contentReady?: boolean;
  onRevealed?: () => void;
  afterEntry?: (entry: SessionLogEntry, context: { highlightedId: string | null }) => React.ReactNode;
  header?: React.ReactNode;
  footer?: React.ReactNode;
  transformEntries?: (entries: readonly SessionLogEntry[]) => readonly SessionLogEntry[];
  entryKey?: (entry: SessionLogEntry) => string;
  showPendingSkeleton?: boolean;
  /** A local send can be displayed before an empty session's first server window arrives. */
  localDataReady?: boolean;
  onReturnToLatest?: () => void;
  onScrollRoot?: (el: HTMLDivElement | null) => void;
}

/**
 * New-message chip. Purely a scroll affordance: it renders only while the reader
 * is released, and the count on screen is deliberately cosmetic (capped at 99+
 * per the design spec) while the accessible name carries the real number, which
 * is the only place the true count is exposed.
 */
function NewMessagesChip({
  count,
  onReturn,
  label,
}: {
  count: number;
  onReturn: () => void;
  label: string;
}): React.ReactElement {
  const display = count > NEW_MESSAGE_DISPLAY_CAP ? `${NEW_MESSAGE_DISPLAY_CAP}+` : String(count);
  return (
    <button
      type="button"
      data-session-log-new-messages=""
      onClick={onReturn}
      aria-label={label}
      title={label}
      // Absolutely positioned overlay: the design spec's rule that a dynamic
      // affordance must not be inserted between rows, because inserting it would
      // move every row below it by its own height.
      className="absolute right-4 bottom-4 z-20 inline-flex items-center gap-1.5 rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-md"
    >
      <ArrowDown className="size-3.5" aria-hidden="true" />
      {/* Tabular numerals keep the chip from resizing as the count ticks up. */}
      <span className="tabular-nums">{display}</span>
    </button>
  );
}

export function SessionLogList({
  sessionId,
  replica,
  anchor = { kind: "bottom" },
  resetKey,
  renderFallback,
  onDegradedRender,
  renderEntry,
  renderPending,
  className,
  testIdPrefix = "session-log",
  perfScroll = "session-log",
  latestAnchor = "latest-message",
  initialPositioned = false,
  initialDisplayReady = true,
  contentReady = true,
  onRevealed,
  afterEntry,
  header,
  footer,
  transformEntries,
  entryKey,
  showPendingSkeleton = true,
  localDataReady = false,
  onReturnToLatest,
  onScrollRoot,
}: SessionLogListProps): React.ReactElement {
  const { t } = useT("chat");
  const scrollId = useId();

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  /**
   * Degraded rows (`body_html` missing, so the row rendered on the client).
   *
   * Counted in state rather than written to the DOM imperatively: React
   * re-applies a declarative attribute on every render, so a ref-counted
   * attribute would be reset to its initial value by the next render — the same
   * trap `EntryHtml` documents for `dangerouslySetInnerHTML`. The cost is one
   * re-render per batch of degraded rows, and updates from effects in the same
   * commit are batched, so a window of them costs one.
   */
  const [degradedCount, setDegradedCount] = useState(0);
  const reportDegraded = useCallback((entry: SessionLogEntry) => {
    setDegradedCount((count) => count + 1);
    onDegradedRender?.(entry);
  }, [onDegradedRender]);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
  const elementRefs = useRef(new Map<number, HTMLElement>());

  const subscribe = useCallback(
    (listener: () => void) => replica.subscribe(sessionId, listener),
    [replica, sessionId],
  );
  const getSnapshot = useCallback(
    () => (sessionId ? replica.getSnapshot(sessionId) : EMPTY_SNAPSHOT),
    [replica, sessionId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  /**
   * The window the list renders: the newest {@link SESSION_LOG_DOM_LIMIT} rows.
   * Dropping the oldest end is what bounds the DOM; the caller keeps the full
   * window in the replica, so `head`-relative counts stay correct.
   */
  const entries = useMemo(() => {
    const all = transformEntries ? transformEntries(snapshot.entries) : snapshot.entries;
    return all.length > SESSION_LOG_DOM_LIMIT ? all.slice(all.length - SESSION_LOG_DOM_LIMIT) : all;
  }, [snapshot.entries, transformEntries]);

  const anchorId = anchor.kind === "element" ? anchor.id : null;
  const [highlighted, setHighlighted] = useState(Boolean(anchorId));
  useEffect(() => {
    setHighlighted(Boolean(anchorId));
    if (!anchorId) return;
    const timeout = setTimeout(() => setHighlighted(false), 2500);
    return () => clearTimeout(timeout);
  }, [anchorId]);
  const latestEntry = latestAnchor === "latest-comment"
    ? entries.findLast(entry => entry.kind === "message")
    : entries.at(-1);

  const reveal = useAnchoredReveal({
    scrollEl,
    contentEl,
    resetKey: resetKey ?? `${sessionId}:${anchorId ?? "bottom"}`,
    dataReady: (snapshot.ready || localDataReady) && contentReady && initialDisplayReady,
    anchor,
    // Trivially true: the flat list has no virtualizer whose measurement window
    // has to close before the anchor position is final (plan 3/6 §3).
    layoutSettled: true,
    // Only the replica's own verdict: a list that happened to hold every row it
    // was given is not the same claim as "this equals the server's head".
    fresh: snapshot.fresh,
    initialPositioned,
  });
  useEffect(() => { if (reveal.revealed) onRevealed?.(); }, [reveal.revealed, onRevealed]);

  const stick = useStickToBottom({
    scrollEl,
    contentEl,
    mode: anchor.kind === "bottom" ? { kind: "bottom" } : { kind: "element", id: anchor.id },
    enabled: reveal.revealed,
    // A deep link lands on a row, not on the end of the stream: pinning there
    // would fight the reader from the first frame (ADR 0008 §4).
    initialState: anchor.kind === "element" ? "released" : "pinned",
  });

  // The count is derived rather than stored: `head` minus the newest row the
  // reader was at when they released. Keeping it derived means a re-render, a
  // resize or a remount cannot drift from the replica.
  const [releasedAtSeq, setReleasedAtSeq] = useState<number | null>(null);
  const previousStateRef = useRef(stick.state);
  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = stick.state;
    if (previous === "pinned" && stick.state === "released") {
      const newest = entries.length > 0 ? entries[entries.length - 1]!.seq : null;
      setReleasedAtSeq(newest);
      return;
    }
    if (stick.state === "pinned") setReleasedAtSeq(null);
  }, [stick.state, entries]);

  const head = snapshot.head;
  const newMessageCount = stick.state === "released" && head !== null && releasedAtSeq !== null
    ? Math.max(0, head - releasedAtSeq)
    : 0;

  // The height hook reads rows through a getter, and the getter reads the two
  // things that are only correct after commit: the element refs (populated by
  // React) and the current window. Resolving the pairs during render instead
  // would hand the hook an empty list on the first pass, and nothing would
  // re-render the list to fix it.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const getRows = useCallback((): MeasurableRow[] => {
    const rows: MeasurableRow[] = [];
    for (const entry of entriesRef.current) {
      const element = elementRefs.current.get(entry.seq);
      if (!element) continue;
      rows.push({
        element,
        revision: entry.revision,
        renderVersion: entry.render_version,
        seq: entry.seq,
      });
    }
    return rows;
  }, []);

  // The window's own identity: a seq list plus the revision of each row, so a
  // patch that changes a row's height re-scans without an array prop.
  const windowVersion = useMemo(
    () => entries.map((entry) => `${entry.seq}.${entry.revision}.${entry.render_version ?? ""}`).join(","),
    [entries],
  );

  useRowHeights({
    replica,
    sessionId,
    scrollEl,
    widthPx,
    getRows,
    version: windowVersion,
    enabled: reveal.revealed,
  });

  // Content width, in the same units the cache keys on. A ResizeObserver rather
  // than a window listener: the list's width changes when a sidebar opens, which
  // fires no window resize at all.
  useEffect(() => {
    if (!contentEl) return;
    setWidthPx(contentEl.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setWidthPx(contentEl.clientWidth));
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [contentEl]);

  const setRowRef = useCallback((seq: number) => (element: HTMLElement | null) => {
    if (element) elementRefs.current.set(seq, element);
    else elementRefs.current.delete(seq);
  }, []);

  const reserve = useCallback(
    (entry: SessionLogEntry): number | null => reservedRowHeight(replica, sessionId, entry, widthPx),
    [replica, sessionId, widthPx],
  );

  // The accessible name is built from the real count and never from the capped
  // one: "99+" is a display convention, not something to read out.
  const newMessagesLabel = t(($) => $.session_log.new_messages_jump, {
    count: newMessageCount,
  });

  const handleReturn = useCallback(() => {
    if (onReturnToLatest) { onReturnToLatest(); return; }
    stick.returnToBottom();
  }, [stick, onReturnToLatest]);

  return (
    <div className={`relative min-h-0 flex-1 ${className ?? ""}`}>
      <div
        id={scrollId}
        ref={useCallback((el: HTMLDivElement | null) => { setScrollEl(el); onScrollRoot?.(el); }, [onScrollRoot])}
        data-tab-scroll-root=""
        data-session-log-scroll=""
        data-ssr-initial={initialPositioned ? "" : undefined}
        data-ssr-display-ready={initialPositioned ? (initialDisplayReady ? "1" : "0") : undefined}
        data-ssr-expected={initialPositioned ? entries.length : undefined}
        data-ssr-anchor-id={initialPositioned ? anchorId ?? undefined : undefined}
        data-session-log-degraded={degradedCount}
        data-perf-scroll={perfScroll}
        data-perf-state={initialPositioned ? "pending" : undefined}
        data-perf-fresh={snapshot.fresh ? "1" : "0"}
        data-stick-state={stick.state}
        className="relative h-full overflow-y-auto"
      >
        {/* The reveal hook hides this subtree until its gates hold, so the first
            frame that shows content is already at its final position. It keeps
            `visibility: hidden` rather than unmounting because the hook measures
            real heights to know where "final" is. */}
        <div ref={setContentEl} style={initialPositioned ? { visibility: "hidden" } : undefined} className="relative mx-auto w-full max-w-4xl px-4 py-6">
          {showPendingSkeleton && reveal.state === "pending" && (
            <div
              data-slot="skeleton"
              data-testid={`${testIdPrefix}-skeleton`}
              className="visible absolute inset-0 z-10 flex flex-col justify-end gap-3 bg-background"
            >
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-16 rounded-md bg-muted/40" />
              ))}
            </div>
          )}
          {!snapshot.ready && renderPending ? renderPending() : null}
          {header}
          {entries.map((entry) => {
            const reservedHeight = reserve(entry);
            const isLatest = entry === latestEntry;
            return (
              <div
                key={entryKey?.(entry) ?? entry.seq}
                ref={setRowRef(entry.seq)}
                id={`comment-${entry.id}`}
                data-perf-item="message"
                data-perf-key={entry.id}
                {...(anchorId === `comment-${entry.id}` ? { "data-perf-anchor": "target-comment" } : null)}
                {...(isLatest && anchorId !== `comment-${entry.id}` ? { "data-perf-anchor": latestAnchor } : null)}
                style={reservedHeight === null ? undefined : { minHeight: `${reservedHeight}px` }}
                className={`pb-3 transition-colors duration-500 ${highlighted && anchorId === `comment-${entry.id}` ? "bg-warning/10" : ""}`}
              >
                {renderEntry
                  ? renderEntry({ entry, reservedHeight })
                  : (
                    <EntryHtml
                      html={entry.body_html}
                      markdown={entry.body_md}
                      onDegradedRender={() => reportDegraded(entry)}
                      fallback={renderFallback ? renderFallback(entry) : null}
                    />
                  )}
                {afterEntry?.(entry, { highlightedId: highlighted ? anchorId : null })}
              </div>
            );
          })}
          {footer}
          {anchorId && <div aria-hidden="true" className="h-[50vh]" />}
        </div>
      </div>
      {newMessageCount > 0 && stick.state === "released" && (
        <NewMessagesChip count={newMessageCount} onReturn={handleReturn} label={newMessagesLabel} />
      )}
    </div>
  );
}
