import { infiniteQueryOptions, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";

export { deduplicateInboxItems } from "./grouping";

export const INBOX_PAGE_SIZE = 50;

export const inboxKeys = {
  all: (wsId: string) => ["inbox", wsId] as const,
  list: (wsId: string) => [...inboxKeys.all(wsId), "list"] as const,
  pages: (wsId: string) => [...inboxKeys.all(wsId), "pages"] as const,
  summary: (wsId: string) => [...inboxKeys.all(wsId), "summary"] as const,
};

export function inboxListOptions(wsId: string) {
  return queryOptions({
    queryKey: inboxKeys.list(wsId),
    queryFn: () => api.listInbox(),
  });
}

export function inboxPageOptions(wsId: string) {
  return infiniteQueryOptions({
    queryKey: inboxKeys.pages(wsId),
    queryFn: ({ pageParam }) => api.listInboxPage({
      limit: INBOX_PAGE_SIZE,
      cursor: pageParam,
    }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
  });
}

export function inboxSummaryOptions(wsId: string) {
  return queryOptions({
    queryKey: inboxKeys.summary(wsId),
    queryFn: () => api.getInboxSummary(),
    staleTime: 30_000,
  });
}

/**
 * Unread inbox count for the given workspace, aligned with what the inbox
 * list UI renders: archived items excluded, then deduplicated by issue so a
 * single issue with three unread notifications counts once.
 */
/**
 * Unread totals from `/api/inbox/summary`.
 *
 * `enabled` defaults to true: the inbox page's own unread count must not wait
 * behind anything. The sidebar badge passes the shell's first-screen gate
 * (MUL-472 b) so the summary request stays out of the route's first wave; the
 * hook keeps returning cached numbers either way.
 */
export function useInboxUnreadCount(
  wsId: string | null | undefined,
  enabled = true,
): number {
  const { data } = useQuery({
    ...inboxSummaryOptions(wsId ?? ""),
    enabled: !!wsId && enabled,
    select: (summary) => summary.unread,
  });
  return data ?? 0;
}

export function useInboxAttentionUnreadCount(
  wsId: string | null | undefined,
  enabled = true,
): number {
  const { data } = useQuery({
    ...inboxSummaryOptions(wsId ?? ""),
    enabled: !!wsId && enabled,
    select: (summary) => summary.attention,
  });
  return data ?? 0;
}
