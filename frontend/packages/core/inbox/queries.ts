import { infiniteQueryOptions, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
export const INBOX_PAGE_SIZE = 50;
export const inboxKeys = {
  all: (wsId: string) => ["inbox", wsId] as const,
  pages: (wsId: string) => ["inbox", wsId, "pages"] as const,
  summary: (wsId: string) => ["inbox", wsId, "summary"] as const,
};
export function inboxPageOptions(wsId: string) {
  return infiniteQueryOptions({
    queryKey: inboxKeys.pages(wsId),
    queryFn: ({ pageParam }) => api.listInboxPage({ workspace_id: wsId, limit: INBOX_PAGE_SIZE, cursor: pageParam }),
    refetchInterval: 10_000, refetchIntervalInBackground: false,
    initialPageParam: null as string | null,
    getNextPageParam: page => page.next_cursor ?? undefined,
  });
}
export function inboxSummaryOptions(wsId: string) {
  return queryOptions({ queryKey: inboxKeys.summary(wsId), queryFn: () => api.listInboxPage({ workspace_id: wsId, limit: 1 }), staleTime: 30_000, refetchInterval: 10_000, refetchIntervalInBackground: false });
}
export function useInboxUnreadCount(wsId: string | null | undefined, enabled = true): number {
  return useQuery({ ...inboxSummaryOptions(wsId ?? ""), enabled: !!wsId && enabled, select: page => page.unread_count }).data ?? 0;
}
export function useInboxAttentionUnreadCount(wsId: string | null | undefined, enabled = true): number {
  return useQuery({ ...inboxSummaryOptions(wsId ?? ""), enabled: !!wsId && enabled, select: page => page.attention_count }).data ?? 0;
}
