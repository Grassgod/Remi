"use client";

import { useCallback, useState } from "react";

export interface ActivityExpansionState {
  /**
   * The default rule is "only the trailing block is expanded"; `isTrailing`
   * carries that default and the user's overrides win over it.
   */
  isExpanded: (id: string, isTrailing: boolean) => boolean;
  toggle: (id: string, currentlyExpanded: boolean) => void;
  isShowingOlder: (id: string) => boolean;
  showOlder: (id: string) => void;
}

/**
 * Per-session activity-block expansion overrides.
 *
 * Two sets are needed because "default" can flip when a new activity block
 * appends — without an explicit collapse override, a manually-collapsed older
 * block would re-expand when it stops being the trailing one (or vice versa).
 * Not persisted, matching the resolved-thread behaviour.
 *
 * `showOlder` records blocks where the user has explicitly chosen to also
 * reveal the older (pre-last-8) entries. Kept independent of the
 * expanded/collapsed sets so collapsing then re-expanding preserves the "show
 * all" choice, and so the choice survives the block losing its trailing
 * position when a new comment lands after it.
 */
export function useActivityExpansion(): ActivityExpansionState {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [showOlderIds, setShowOlderIds] = useState<Set<string>>(() => new Set());

  const isExpanded = useCallback(
    (id: string, isTrailing: boolean) =>
      expandedIds.has(id) ? true : collapsedIds.has(id) ? false : isTrailing,
    [expandedIds, collapsedIds],
  );

  const toggle = useCallback((id: string, currentlyExpanded: boolean) => {
    if (currentlyExpanded) {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setExpandedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } else {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
      setCollapsedIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const isShowingOlder = useCallback((id: string) => showOlderIds.has(id), [showOlderIds]);

  const showOlder = useCallback((id: string) => {
    setShowOlderIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  return { isExpanded, toggle, isShowingOlder, showOlder };
}
