"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue } from "@multiremi/core/types";

// ---------------------------------------------------------------------------
// Sidebar progressive disclosure
// ---------------------------------------------------------------------------
//
// Properties shown in the sidebar split into two groups:
//   - core: always rendered (status / assignee / project)
//   - optional: rendered only when the issue has a value for that field OR
//     the user explicitly added it via "+ Add property" in this session
//     (priority / start_date / due_date / labels)
//
// Parent is not in either group — it has its own standalone section below
// the Properties block, rendered only when the issue actually has a parent.
//
// `OPTIONAL_PROP_KEYS` is the open set — adding a new optional field means
// appending here, wiring its row in the sidebar switch, and adding a locale
// key. The picker, visibility rules, and add-property menu all flow from this
// one list.
export const OPTIONAL_PROP_KEYS = ["priority", "start_date", "due_date", "labels"] as const;
export type OptionalPropKey = (typeof OPTIONAL_PROP_KEYS)[number];

export function isOptionalPropSet(
  issue: Issue,
  key: OptionalPropKey,
  attachedLabelsCount: number,
): boolean {
  switch (key) {
    case "priority":
      return issue.priority !== "none";
    case "start_date":
      return !!issue.start_date;
    case "due_date":
      return !!issue.due_date;
    case "labels":
      return attachedLabelsCount > 0;
  }
}

export interface OptionalPropsState {
  /**
   * Per-issue set of optional properties currently visible in the sidebar
   * Properties section. Seeded on issue switch with whichever fields are
   * already set; "+ Add property" adds an entry, clearing a value does *not*
   * remove one (avoids row-flicker on edit → clear).
   */
  visible: ReadonlySet<OptionalPropKey>;
  /**
   * Optional property to auto-open as soon as it is mounted (the user just
   * picked it from "+ Add property" and we want them dropped straight into
   * edit state). Consumed by the row that matches this key, cleared after.
   */
  autoOpen: OptionalPropKey | null;
  /**
   * Controlled state for the "+ Add property" popover. Base UI's Popover
   * doesn't auto-dismiss on item click (it's not a Menu primitive), so the
   * popover would stay open behind the newly auto-opened picker — two popovers
   * stacked. `add` closes it explicitly.
   */
  popoverOpen: boolean;
  setPopoverOpen: (open: boolean) => void;
  add: (key: OptionalPropKey) => void;
}

export function useOptionalProps(
  issue: Issue | null,
  attachedLabelsCount: number,
): OptionalPropsState {
  const [visible, setVisible] = useState<Set<OptionalPropKey>>(() => new Set());
  const [autoOpen, setAutoOpen] = useState<OptionalPropKey | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  // Seed the visible set:
  //   - on issue switch, reset to whichever fields are currently set
  //   - on the SAME issue, additively pick up fields the user just set
  //     (so the row stays visible after they edit + clear in one session)
  // Removal happens only on issue switch — never on clear.
  const seededIssueIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!issue) return;
    if (seededIssueIdRef.current !== issue.id) {
      seededIssueIdRef.current = issue.id;
      setAutoOpen(null);
      const seed = new Set<OptionalPropKey>();
      for (const k of OPTIONAL_PROP_KEYS) {
        if (isOptionalPropSet(issue, k, attachedLabelsCount)) seed.add(k);
      }
      setVisible(seed);
      return;
    }
    setVisible((prev) => {
      let next = prev;
      for (const k of OPTIONAL_PROP_KEYS) {
        if (isOptionalPropSet(issue, k, attachedLabelsCount) && !next.has(k)) {
          if (next === prev) next = new Set(prev);
          next.add(k);
        }
      }
      return next;
    });
  }, [issue, attachedLabelsCount]);

  const add = useCallback((key: OptionalPropKey) => {
    setVisible((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    setAutoOpen(key);
    // Dismiss the "+ Add property" popover so it doesn't sit stacked behind
    // the picker we're about to auto-open.
    setPopoverOpen(false);
  }, []);

  // Clear the auto-open flag after the next render so pickers (which read
  // `defaultOpen` once via a useState initializer) keep the open state they
  // captured on mount, but later interactions don't re-trigger it.
  useEffect(() => {
    if (autoOpen === null) return;
    setAutoOpen(null);
  }, [autoOpen]);

  return { visible, autoOpen, popoverOpen, setPopoverOpen, add };
}
