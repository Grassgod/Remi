import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { TimelineEntry, TimelinePage } from "../types";
import {
  ISSUE_TIMELINE_PAGE_SIZE,
  issueKeys,
} from "./queries";

export type IssueTimelineData = InfiniteData<TimelinePage, string | null>;

export function timelineDataFromPage(page: TimelinePage): IssueTimelineData {
  return { pages: [page], pageParams: [null] };
}

export function timelineEntries(data: IssueTimelineData | undefined): TimelineEntry[] {
  return [...(data?.pages ?? [])].reverse().flatMap((page) => page.entries);
}

export function timelineOlderEntryCount(data: IssueTimelineData | undefined): number {
  return (data?.pages ?? []).slice(1).reduce((count, page) => count + page.entries.length, 0);
}

export function mapTimelineEntries(
  data: IssueTimelineData | undefined,
  update: (entry: TimelineEntry) => TimelineEntry | null,
): IssueTimelineData | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const entries: TimelineEntry[] = [];
    let pageChanged = false;
    for (const entry of page.entries) {
      const next = update(entry);
      if (next !== entry) pageChanged = true;
      if (next) entries.push(next);
    }
    if (!pageChanged) return page;
    changed = true;
    return { ...page, entries };
  });
  return changed ? { ...data, pages } : data;
}

export function appendTimelineEntry(
  data: IssueTimelineData | undefined,
  entry: TimelineEntry,
): IssueTimelineData | undefined {
  if (!data?.pages.length) return data;
  if (data.pages.some((page) => page.entries.some((candidate) => candidate.id === entry.id))) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page, index) => index === 0
      ? { ...page, entries: [...page.entries, entry] }
      : page),
  };
}

export function removeTimelineCommentTree(
  data: IssueTimelineData | undefined,
  rootId: string,
): IssueTimelineData | undefined {
  if (!data) return data;
  const entries = data.pages.flatMap((page) => page.entries);
  const idsToRemove = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (
        entry.parent_id
        && idsToRemove.has(entry.parent_id)
        && !idsToRemove.has(entry.id)
      ) {
        idsToRemove.add(entry.id);
        changed = true;
      }
    }
  }
  return mapTimelineEntries(data, (entry) => idsToRemove.has(entry.id) ? null : entry);
}

function compareTimelineEntries(left: TimelineEntry, right: TimelineEntry): number {
  return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
}

/** Replace the newest server window while retaining entries shifted into loaded history. */
export function mergeTimelineLatestPage(
  current: IssueTimelineData | undefined,
  latest: TimelinePage,
): IssueTimelineData {
  // A short latest page is the complete server timeline, so it is also
  // authoritative for removals. A full page with older history only replaces
  // its covered range; rows shifted past its oldest key must be retained.
  if (!current?.pages.length || !latest.has_more || latest.entries.length === 0) {
    return timelineDataFromPage(latest);
  }

  const latestIds = new Set(latest.entries.map((entry) => entry.id));
  const oldestLatest = latest.entries[0]!;
  const seenOlderIds = new Set<string>();
  const olderEntries = current.pages
    .flatMap((page) => page.entries)
    .filter((entry) => !latestIds.has(entry.id) && compareTimelineEntries(entry, oldestLatest) < 0)
    .sort(compareTimelineEntries)
    .filter((entry) => {
      if (seenOlderIds.has(entry.id)) return false;
      seenOlderIds.add(entry.id);
      return true;
    });
  if (!olderEntries.length) return timelineDataFromPage(latest);

  const oldestLoadedPage = current.pages[current.pages.length - 1]!;
  return {
    pages: [
      latest,
      { ...oldestLoadedPage, entries: olderEntries },
    ],
    pageParams: [null, current.pageParams[current.pageParams.length - 1] ?? null],
  };
}

export function seedIssueTimelinePage(
  qc: QueryClient,
  issueId: string,
  page: TimelinePage,
  requestStartedAt: number,
): void {
  if (!page.issue_session_id) return;
  const queryKey = issueKeys.timeline(issueId, page.issue_session_id);
  const currentState = qc.getQueryState(queryKey);
  // A gated real-session request completed after this primer started. Its
  // snapshot wins even if the earlier primer happens to resolve last.
  if (currentState?.dataUpdatedAt && currentState.dataUpdatedAt >= requestStartedAt) return;
  qc.setQueryData<IssueTimelineData>(
    queryKey,
    (old) => mergeTimelineLatestPage(old, page),
  );
}

export function markIssueTimelineDirty(qc: QueryClient, issueId: string): number {
  const key = issueKeys.timelineSyncVersion(issueId);
  const next = (qc.getQueryData<number>(key) ?? 0) + 1;
  qc.setQueryData(key, next);
  return next;
}

export function isIssueTimelineDirty(
  qc: QueryClient,
  issueId: string,
  issueSessionId?: string,
): boolean {
  const version = qc.getQueryData<number>(issueKeys.timelineSyncVersion(issueId)) ?? 0;
  const applied = qc.getQueryData<number>(
    issueKeys.timelineSyncApplied(issueId, issueSessionId),
  ) ?? 0;
  return applied < version;
}

export async function refreshIssueTimelineLatestPage(
  qc: QueryClient,
  issueId: string,
  issueSessionId?: string,
): Promise<void> {
  const syncVersion = qc.getQueryData<number>(issueKeys.timelineSyncVersion(issueId)) ?? 0;
  const latest = await api.listTimelinePage(issueId, {
    issueSessionId,
    limit: ISSUE_TIMELINE_PAGE_SIZE,
  });
  if (issueSessionId && latest.issue_session_id !== issueSessionId) return;
  qc.setQueryData<IssueTimelineData>(
    issueKeys.timeline(issueId, issueSessionId),
    (old) => mergeTimelineLatestPage(old, latest),
  );
  qc.setQueryData(issueKeys.timelineSyncApplied(issueId, issueSessionId), syncVersion);
}

export async function refreshActiveIssueTimelineLatestPages(
  qc: QueryClient,
  issueId: string,
): Promise<void> {
  const active = qc.getQueriesData<IssueTimelineData>({
    queryKey: issueKeys.timelineAll(issueId),
    type: "active",
  });
  await Promise.all(active.map(([queryKey]) => {
    const keySession = queryKey[3];
    const issueSessionId = typeof keySession === "string" && keySession !== "all"
      ? keySession
      : undefined;
    return refreshIssueTimelineLatestPage(qc, issueId, issueSessionId);
  }));
}
