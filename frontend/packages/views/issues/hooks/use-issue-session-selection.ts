"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueSession } from "@multiremi/core/types";
import { issueSessionsOptions } from "@multiremi/core/issues/queries";

export interface IssueSessionSelection {
  list: IssueSession[];
  /** Resolved session id — "" while the session list is empty or pending. */
  activeId: string;
  active: IssueSession | null;
  select: (sessionId: string) => void;
  pending: boolean;
  fetching: boolean;
  refetch: () => void;
}

/**
 * Owns which of the issue's parallel sessions is on screen. Resolution order
 * is explicit selection → the default session → the first one, so a freshly
 * loaded issue always lands on something real.
 */
export function useIssueSessionSelection(
  issueId: string,
  initialIssueSessionId?: string,
): IssueSessionSelection {
  const sessionsQuery = useQuery(issueSessionsOptions(issueId));
  // Stable reference: `?? []` inline would hand children a fresh array on
  // every render and defeat their memoization.
  const list = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const [selectedId, setSelectedId] = useState(initialIssueSessionId ?? "");

  const activeId =
    list.find((session) => session.id === selectedId)?.id
    ?? list.find((session) => session.is_default)?.id
    ?? list[0]?.id
    ?? "";
  const active = list.find((session) => session.id === activeId) ?? null;

  useEffect(() => {
    if (activeId && activeId !== selectedId) {
      setSelectedId(activeId);
    }
  }, [activeId, selectedId]);
  useEffect(() => {
    setSelectedId(initialIssueSessionId ?? "");
  }, [issueId, initialIssueSessionId]);

  return {
    list,
    activeId,
    active,
    select: setSelectedId,
    pending: sessionsQuery.isPending,
    fetching: sessionsQuery.isFetching,
    refetch: () => void sessionsQuery.refetch(),
  };
}
