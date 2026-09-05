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
  // authoritative for removals. A full page only replaces its covered range;
  // rows below its oldest key cannot be verified and are retained.
  if (!current?.pages.length || !latest.has_more || latest.entries.length === 0) {
    return timelineDataFromPage(latest);
  }

  const head = current.pages[0]!;
  const newestLoaded = head.entries[head.entries.length - 1];
  const oldestLatest = latest.entries[0]!;
  // No overlap: more than a page of history landed while this client was away,
  // so the rows between the loaded head and the fresh window are on neither
  // side. Stitching them together would leave a permanent hole in the middle
  // of the rendered timeline; restart from the latest page instead and let
  // upward scrolling re-fetch history contiguously.
  if (!newestLoaded || compareTimelineEntries(newestLoaded, oldestLatest) < 0) {
    return timelineDataFromPage(latest);
  }

  const latestIds = new Set(latest.entries.map((entry) => entry.id));
  const retained = head.entries.filter(
    (entry) => !latestIds.has(entry.id) && compareTimelineEntries(entry, oldestLatest) < 0,
  );

  // The refreshed window is absorbed into page zero rather than splitting rows
  // off into the older bucket. Virtuoso derives its prepend delta from the size
  // of page zero, so migrating rows downward would read as a prepend and shift
  // the scroll position of a reader sitting in history.
  //
  // The backwards cursor has to describe the merged page's own oldest row.
  // Deletions can let the refreshed window reach further back than the loaded
  // head did, and reusing the stale cursor would then re-fetch rows page zero
  // already holds.
  const cursorSource = retained.length ? head : latest;
  return {
    ...current,
    pages: current.pages.map((page, index) => index === 0
      ? {
          ...page,
          entries: [...retained, ...latest.entries],
          has_more: cursorSource.has_more,
          has_more_before: cursorSource.has_more_before,
          next_cursor: cursorSource.next_cursor,
        }
      : page),
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
