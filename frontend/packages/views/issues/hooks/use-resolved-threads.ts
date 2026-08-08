"use client";

import { useCallback, useState } from "react";

export interface ResolvedThreadsState {
  /** Comment ids the user has temporarily unfolded from their resolved bar. */
  expanded: ReadonlySet<string>;
  toggle: (commentId: string, expand: boolean) => void;
  clear: (commentId: string) => void;
}

/**
 * Per-session record of which resolved threads the user has temporarily
 * expanded. Not persisted (matches Linear) — reload collapses everything back
 * to bars.
 */
export function useResolvedThreads(): ResolvedThreadsState {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((commentId: string, expand: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (expand) next.add(commentId);
      else next.delete(commentId);
      return next;
    });
  }, []);

  const clear = useCallback((commentId: string) => {
    setExpanded((prev) => {
      if (!prev.has(commentId)) return prev;
      const next = new Set(prev);
      next.delete(commentId);
      return next;
    });
  }, []);

  return { expanded, toggle, clear };
}
