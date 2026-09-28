"use client";

/**
 * Height cache for the flat log list (MUL-403 plan 3/6 §3).
 *
 * Three rules from the plan shape this hook, and each is a decision rather than
 * an implementation detail:
 *
 * - **Only rows inside the scroll viewport are observed.** Measuring every row
 *   would make a 300-row window pay 300 observers for the dozen on screen, and
 *   the cache is only ever read back for rows that are about to be looked at.
 * - **The key carries the width.** A row's height is a function of the width it
 *   was laid out at, so the bucket is part of the key: after a resize the old
 *   entry is a miss rather than a wrong reservation.
 * - **The reader reserves before measuring.** The list reads a cached height and
 *   renders the row with `min-height`, so a row never paints short and then
 *   grows — which is what the reveal hook's settled-layout gate needs.
 *
 * The hook writes through {@link SessionReplicaPort.writeRowHeight}; it keeps no
 * second copy of the cache in React state, because a second copy is a second
 * truth. Rows arrive through a getter rather than an array prop: a ref callback
 * that called `setState` would re-render, rebind the refs and re-render again,
 * so the elements are read from the map the list already maintains.
 */

import { useCallback, useEffect, useRef } from "react";
import type { SessionLogEntry, SessionReplicaPort } from "@multiremi/core/replica";
import { rowHeightKey } from "@multiremi/core/replica";

/** A row the hook may measure: its own element plus the fields that key the cache. */
export interface MeasurableRow {
  element: HTMLElement;
  revision: number;
  renderVersion: string | null;
  seq: number;
}

export interface UseRowHeightsOptions {
  replica: SessionReplicaPort;
  sessionId: string;
  /** The scroll root; rows outside its box are not observed. */
  scrollEl: HTMLElement | null;
  /** Content width the rows are laid out at, in CSS pixels. */
  widthPx: number;
  /** Current rows, read at measure time so the observer never goes stale. */
  getRows: () => readonly MeasurableRow[];
  /**
   * Bumped by the list when the window changes (new entries, a resize, an
   * expansion), so the set of observed rows is recomputed without making the
   * hook depend on an array whose identity changes every render.
   */
  version: string | number;
  /**
   * Gate: nothing is observed until the reveal has happened. Before that the
   * content is `visibility: hidden` but already laid out, so measuring early
   * would only cache the state the reveal is about to change.
   */
  enabled: boolean;
}

/** True when the row's rect overlaps the scroll root's own box at all. */
export function rowIntersectsViewport(row: DOMRect, viewport: DOMRect): boolean {
  return row.bottom > viewport.top && row.top < viewport.bottom;
}

export function useRowHeights(options: UseRowHeightsOptions): void {
  const { replica, sessionId, scrollEl, widthPx, getRows, version, enabled } = options;

  // Read inside the ResizeObserver callback, which must not be re-created on
  // every render: a changing dependency would tear the observer down exactly
  // when it has work queued.
  const getRowsRef = useRef(getRows);
  getRowsRef.current = getRows;
  const widthRef = useRef(widthPx);
  widthRef.current = widthPx;

  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef(new WeakSet<HTMLElement>());

  const measure = useCallback((element: HTMLElement): void => {
    const row = getRowsRef.current().find((candidate) => candidate.element === element);
    if (!row) return;
    const height = element.getBoundingClientRect().height;
    if (!(height > 0)) return;
    const key = rowHeightKey({
      revision: row.revision,
      renderVersion: row.renderVersion,
      widthPx: widthRef.current,
    });
    const cached = replica.readRowHeight(sessionId, row.seq, key);
    // Sub-pixel churn would otherwise rewrite the cache on every layout pass.
    if (cached !== null && Math.abs(cached - height) < 0.5) return;
    replica.writeRowHeight(sessionId, row.seq, key, Math.round(height * 100) / 100);
  }, [replica, sessionId]);

  /** Observe the rows in view and release the ones that scrolled away. */
  const sync = useCallback((): void => {
    const observer = observerRef.current;
    if (!observer || !scrollEl) return;
    const viewport = scrollEl.getBoundingClientRect();
    for (const row of getRowsRef.current()) {
      const inView = rowIntersectsViewport(row.element.getBoundingClientRect(), viewport);
      const observed = observedRef.current.has(row.element);
      if (inView && !observed) {
        observedRef.current.add(row.element);
        observer.observe(row.element);
        // A row that just scrolled into view may have no cache entry; measure it
        // now rather than waiting for a resize that may never come.
        measure(row.element);
      } else if (!inView && observed) {
        observedRef.current.delete(row.element);
        observer.unobserve(row.element);
      }
    }
  }, [measure, scrollEl]);

  useEffect(() => {
    if (!enabled || !scrollEl) return;
    if (typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.target as HTMLElement);
    });
    observerRef.current = observer;
    observedRef.current = new WeakSet();

    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };

    sync();
    scrollEl.addEventListener("scroll", schedule, { passive: true });
    const windowObject = scrollEl.ownerDocument.defaultView;
    windowObject?.addEventListener("resize", schedule);

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scrollEl.removeEventListener("scroll", schedule);
      windowObject?.removeEventListener("resize", schedule);
      observer.disconnect();
      observerRef.current = null;
      observedRef.current = new WeakSet();
    };
  }, [enabled, measure, scrollEl, sync]);

  // The window changed: re-scan immediately instead of waiting for a scroll.
  useEffect(() => {
    if (!enabled) return;
    sync();
  }, [enabled, sync, version, widthPx]);
}

/**
 * Reserve a row's height before it is measured.
 *
 * Returns the `min-height` the row should render with, or null when there is no
 * usable cache entry (a new row, an edited row, a re-rendered pipeline, or a
 * width this row has never been laid out at). Growing only: the caller must not
 * shrink a row below its content.
 */
export function reservedRowHeight(
  replica: SessionReplicaPort,
  sessionId: string,
  entry: SessionLogEntry,
  widthPx: number,
): number | null {
  const key = rowHeightKey({
    revision: entry.revision,
    renderVersion: entry.render_version,
    widthPx,
  });
  const cached = replica.readRowHeight(sessionId, entry.seq, key);
  return cached !== null && cached > 0 ? cached : null;
}
