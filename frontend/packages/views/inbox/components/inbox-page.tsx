"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useModalStore } from "@multiremi/core/modals";
import { useIssueDraftStore } from "@multiremi/core/issues/stores/draft-store";
import {
  inboxPageOptions,
  deduplicateInboxItems,
  useInboxUnreadCount,
} from "@multiremi/core/inbox/queries";
import {
  filterInboxItemsBySource,
  groupInboxItemsByDate,
  inboxDisplayEntryIds,
  inboxItemSelectionKey,
  inboxItemSelectionKind,
  type InboxDateGroup,
  type InboxItemSelectionKind,
  type InboxSourceFilter,
} from "@multiremi/core/inbox";
import {
  useArchiveInboxItems,
  useMarkAllInboxRead,
  useArchiveAllInbox,
  useArchiveAllReadInbox,
  useArchiveCompletedInbox,
  useMarkInboxItemsRead,
} from "@multiremi/core/inbox/mutations";

import { FeishuInboxActions } from "./feishu-inbox-actions";
import { IssueDetail } from "../../issues/components";
import { ErrorBoundary } from "@multiremi/ui/components/common/error-boundary";
import { EmptyState } from "../../common/empty-state";
import { useNavigation } from "../../navigation";
import { toast } from "sonner";
import {
  AlertCircle,
  MoreHorizontal,
  Inbox,
  CheckCheck,
  Archive,
  BookCheck,
  ListChecks,
  ArrowLeft,
  ChevronDown,
  LoaderCircle,
} from "lucide-react";
import type { InboxItem } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@multiremi/ui/components/ui/resizable";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { PageHeader } from "../../layout/page-header";
import { InboxListItem, useTimeAgo } from "./inbox-list-item";
import { useInboxTitle, useTypeLabels } from "./inbox-detail-label";
import { getAutopilotRunOutcome } from "./inbox-display";
import { AutopilotRunReport } from "./autopilot-run-report";
import { useT } from "../../i18n";

// A failed inbox fetch resolves to an empty list, and an empty list renders
// the cheerful "you're all caught up" zero-state — telling the user their
// inbox is empty when it is only unreachable. Errors get their own state.
function InboxLoadError({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("common");
  return (
    <EmptyState
      // The inbox list column is a scroll container, not a flex parent, so
      // this state sizes to its content instead of stretching.
      className="flex-initial"
      variant="status"
      tone="destructive"
      icon={AlertCircle}
      title={t(($) => $.load_error.title)}
      description={t(($) => $.load_error.description)}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(($) => $.load_error.retry)}
        </Button>
      }
    />
  );
}

export function InboxPage() {
  const { t } = useT("inbox");
  const { t: tCommon } = useT("common");
  const { searchParams, replace } = useNavigation();
  const urlIssue = searchParams.get("issue") ?? "";
  const urlItem = searchParams.get("item") ?? "";
  const urlSession = searchParams.get("session") ?? "";
  const urlSelectionKey = urlItem || urlIssue;
  const urlSelectionKind: InboxItemSelectionKind = urlItem ? "item" : "issue";
  const wsPaths = useWorkspacePaths();

  const [selectedKey, setSelectedKeyState] = useState(() => urlSelectionKey);
  const [selectedKind, setSelectedKind] = useState<InboxItemSelectionKind>(
    () => urlSelectionKind,
  );
  const [unavailableItem, setUnavailableItem] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<InboxSourceFilter>("all");
  const unavailableRedirectRef = useRef(false);

  // Sync from URL when searchParams change (e.g. navigation)
  useEffect(() => {
    setSelectedKeyState(urlSelectionKey);
    setSelectedKind(urlSelectionKind);
    if (unavailableRedirectRef.current && !urlSelectionKey) {
      unavailableRedirectRef.current = false;
    } else {
      setUnavailableItem(false);
    }
  }, [urlSelectionKey, urlSelectionKind]);

  const wsId = useWorkspaceId();
  const {
    data: inboxPages,
    isLoading: loading,
    isError: loadFailed,
    refetch: refetchInbox,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
  } = useInfiniteQuery(inboxPageOptions(wsId));
  const rawItems = useMemo(
    () => inboxPages?.pages.flatMap((page) => page.items) ?? [],
    [inboxPages],
  );
  const items = useMemo(() => deduplicateInboxItems(rawItems), [rawItems]);
  const filteredItems = useMemo(
    () => filterInboxItemsBySource(items, sourceFilter),
    [items, sourceFilter],
  );
  const itemGroups = useMemo(() => groupInboxItemsByDate(filteredItems), [filteredItems]);

  const selected = items.find((item) => inboxItemSelectionKey(item) === selectedKey) ?? null;
  const selectedEntry = itemGroups
    .flatMap((group) => group.entries)
    .find((entry) => entry.items.some((item) => inboxItemSelectionKey(item) === selectedKey))
    ?? null;
  const selectedOutcome = selected ? getAutopilotRunOutcome(selected) : null;
  const selectedIsGroupHead = Boolean(selected && selectedEntry?.item.id === selected.id);

  // Track the last key we actually resolved against the inbox list. Lets the
  // fallback effect distinguish "shared-link to a notification not in our
  // inbox" (never resolved → redirect to the issue page) from "item was in
  // our inbox and just got removed" (was resolved → stay on /inbox).
  const lastResolvedKeyRef = useRef<string>("");
  useEffect(() => {
    if (selected) lastResolvedKeyRef.current = selectedKey;
  }, [selected, selectedKey]);

  const setSelectedKey = useCallback(
    (key: string, sessionId?: string, kind: InboxItemSelectionKind = "issue") => {
      setSelectedKeyState(key);
      setSelectedKind(kind);
      setUnavailableItem(false);
      replace(
        key
          ? kind === "item"
            ? wsPaths.inboxItem(key, sessionId)
            : wsPaths.inboxIssue(key, sessionId)
          : wsPaths.inbox(),
      );
    },
    [replace, wsPaths],
  );

  const handleIssueSessionChange = useCallback(
    (sessionId: string) => {
      if (!selectedKey) return;
      replace(
        selectedKind === "item"
          ? wsPaths.inboxItem(selectedKey, sessionId)
          : wsPaths.inboxIssue(selectedKey, sessionId),
      );
    },
    [replace, selectedKey, selectedKind, wsPaths],
  );

  // Existing ?issue= links fall back to the issue page when their notification
  // is unavailable. A ledger ?item= link cannot safely do that because its key
  // is an inbox-row id, so keep the user in the inbox and show an explicit state.
  useEffect(() => {
    if (loading) return;
    // A failed list request says nothing about whether the key is in this
    // user's inbox — redirecting on it would bounce the user off /inbox for
    // a transient network error.
    if (loadFailed) return;
    if (!selectedKey) return;
    if (selected) return;
    if (hasNextPage && !isFetchNextPageError) {
      if (!isFetchingNextPage) void fetchNextPage();
      return;
    }
    if (isFetchingNextPage || isFetchNextPageError) return;
    if (lastResolvedKeyRef.current === selectedKey) {
      setSelectedKey("");
      return;
    }
    if (selectedKind === "item") {
      setSelectedKeyState("");
      setUnavailableItem(true);
      unavailableRedirectRef.current = true;
      replace(wsPaths.inbox());
      return;
    }
    replace(
      urlIssue === selectedKey && urlSession
        ? wsPaths.issueSession(selectedKey, urlSession)
        : wsPaths.issueDetail(selectedKey),
    );
  }, [
    loading,
    loadFailed,
    selectedKey,
    selected,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    selectedKind,
    replace,
    wsPaths,
    setSelectedKey,
    urlIssue,
    urlSession,
  ]);

  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: "multimira_inbox_layout",
  });

  const isMobile = useIsMobile();
  const unreadCount = useInboxUnreadCount(wsId);

  const archiveMutation = useArchiveInboxItems();
  const markAllReadMutation = useMarkAllInboxRead();
  const archiveAllMutation = useArchiveAllInbox();
  const archiveAllReadMutation = useArchiveAllReadInbox();
  const archiveCompletedMutation = useArchiveCompletedInbox();
  const markGroupReadMutation = useMarkInboxItemsRead();
  const timeAgo = useTimeAgo();
  const typeLabels = useTypeLabels();
  const inboxTitle = useInboxTitle();

  // Auto-mark the selected display entry as read. A collapsed entry covers
  // every successful run represented by the row, including URL selection.
  // The mutation flips `read: true` optimistically, so this effect settles
  // in one pass and can't loop. Kept in a `useEffect` rather than inlined
  // in handleSelect so URL-driven selection triggers it too.
  const markReadMutate = markGroupReadMutation.mutate;
  const selectedUnreadIds = selectedEntry
    ? selectedEntry.items.filter((item) => !item.read).map((item) => item.id)
    : selected && !selected.read
      ? [selected.id]
      : [];
  const selectedUnreadKey = selectedUnreadIds.join(",");
  useEffect(() => {
    if (!selectedUnreadKey) return;
    markReadMutate(selectedUnreadKey.split(","), {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.mark_read_failed),
        ),
    });
  }, [selectedUnreadKey, markReadMutate, t]);

  const handleSelect = (item: InboxItem) => {
    setSelectedKey(
      inboxItemSelectionKey(item),
      item.details?.issue_session_id ?? undefined,
      inboxItemSelectionKind(item),
    );
  };

  const handleArchive = (ids: string[]) => {
    const archivedIds = new Set(ids);
    const idx = items.findIndex((item) => archivedIds.has(item.id));
    const wasSelected = selected ? archivedIds.has(selected.id) : false;
    if (wasSelected) {
      // List is sorted newest-first; prefer the next (older) item, fall back
      // to the previous (newer) one when archiving at the bottom, and only
      // clear the selection when nothing else is left.
      const next = items.slice(Math.max(0, idx + 1)).find((item) => !archivedIds.has(item.id))
        ?? items.slice(0, Math.max(0, idx)).reverse().find((item) => !archivedIds.has(item.id))
        ?? null;
      setSelectedKey(
        next ? inboxItemSelectionKey(next) : "",
        next?.details?.issue_session_id ?? undefined,
        next ? inboxItemSelectionKind(next) : "issue",
      );
    }
    archiveMutation.mutate(ids, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.archive_failed),
        ),
    });
  };

  // Batch operations
  const handleMarkAllRead = () => {
    markAllReadMutation.mutate(undefined, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.mark_all_read_failed),
        ),
    });
  };

  const handleMarkGroupRead = (groupItems: InboxItem[]) => {
    const unreadIds = groupItems.filter((item) => !item.read).map((item) => item.id);
    if (!unreadIds.length) return;
    markGroupReadMutation.mutate(unreadIds, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.mark_group_read_failed),
        ),
    });
  };

  const handleArchiveAll = () => {
    setSelectedKey("");
    archiveAllMutation.mutate(undefined, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.archive_all_failed),
        ),
    });
  };

  const handleArchiveAllRead = () => {
    const readKeys = items.filter((item) => item.read).map(inboxItemSelectionKey);
    if (readKeys.includes(selectedKey)) setSelectedKey("");
    archiveAllReadMutation.mutate(undefined, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.archive_all_read_failed),
        ),
    });
  };

  const handleArchiveCompleted = () => {
    setSelectedKey("");
    archiveCompletedMutation.mutate(undefined, {
      onError: (err) =>
        toast.error(
          err instanceof Error && err.message
            ? err.message
            : t(($) => $.errors.archive_completed_failed),
        ),
    });
  };

  // -- Shared sub-components --------------------------------------------------

  const sourceFilters: Array<{ key: InboxSourceFilter; label: string }> = [
    { key: "all", label: t(($) => $.filters.all) },
    { key: "message_stream", label: t(($) => $.filters.message_stream) },
    { key: "automation", label: t(($) => $.filters.automation) },
    { key: "mentions", label: t(($) => $.filters.mentions) },
    { key: "assignments", label: t(($) => $.filters.assignments) },
  ];
  const groupLabels: Record<InboxDateGroup, string> = {
    today: t(($) => $.groups.today),
    yesterday: t(($) => $.groups.yesterday),
    this_week: t(($) => $.groups.this_week),
    earlier: t(($) => $.groups.earlier),
  };

  const listHeader = (
    <PageHeader className="justify-between">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold">{t(($) => $.page.title)}</h1>
        {unreadCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {unreadCount}
          </span>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
            />
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-auto">
          <DropdownMenuItem onClick={handleMarkAllRead}>
            <CheckCheck className="h-4 w-4" />
            {t(($) => $.menu.mark_all_read)}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleArchiveAll}>
            <Archive className="h-4 w-4" />
            {t(($) => $.menu.archive_all)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleArchiveAllRead}>
            <BookCheck className="h-4 w-4" />
            {t(($) => $.menu.archive_all_read)}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleArchiveCompleted}>
            <ListChecks className="h-4 w-4" />
            {t(($) => $.menu.archive_completed)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </PageHeader>
  );

  const listBody = loadFailed ? (
    <InboxLoadError onRetry={() => void refetchInbox()} />
  ) : items.length === 0 ? (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
      <Inbox className="mb-3 h-8 w-8 text-muted-foreground/50" />
      <p className="text-sm">{t(($) => $.list.empty)}</p>
    </div>
  ) : (
    <div>
      <div className="overflow-x-auto border-b px-3 py-2">
        <div
          role="group"
          aria-label={t(($) => $.filters.label)}
          className="flex min-w-max items-center gap-1"
        >
          {sourceFilters.map((filter) => (
            <Button
              key={filter.key}
              type="button"
              size="xs"
              variant={sourceFilter === filter.key ? "secondary" : "ghost"}
              aria-pressed={sourceFilter === filter.key}
              className="rounded-md"
              onClick={() => setSourceFilter(filter.key)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </div>
      {filteredItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
          <Inbox className="mb-3 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm">{t(($) => $.list.filtered_empty)}</p>
        </div>
      ) : itemGroups.map((group) => {
        const hasUnread = group.items.some((item) => !item.read);
        return (
          <section key={group.key} aria-labelledby={`inbox-group-${group.key}`}>
            <div className="flex h-8 items-center justify-between border-b bg-muted/30 px-4">
              <h2
                id={`inbox-group-${group.key}`}
                className="text-xs font-medium text-muted-foreground"
              >
                {groupLabels[group.key]}
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!hasUnread || markGroupReadMutation.isPending}
                onClick={() => handleMarkGroupRead(group.items)}
                className="text-muted-foreground"
              >
                <CheckCheck />
                {t(($) => $.list.mark_group_read)}
              </Button>
            </div>
            {group.entries.map((entry) => (
              <InboxListItem
                key={entry.item.id}
                item={entry.item}
                groupedItems={entry.items}
                isSelected={entry.items.some((item) => inboxItemSelectionKey(item) === selectedKey)}
                onClick={() => handleSelect(entry.item)}
                onItemClick={handleSelect}
                onArchive={() => handleArchive(inboxDisplayEntryIds(entry))}
              />
            ))}
          </section>
        );
      })}
      {hasNextPage && (
        <div className="flex justify-center border-t px-3 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            {isFetchingNextPage
              ? <LoaderCircle className="animate-spin" />
              : <ChevronDown />}
            {t(($) => $.list.load_more)}
          </Button>
        </div>
      )}
    </div>
  );

  const detailContent = unavailableItem ? (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-muted-foreground">
      <AlertCircle className="mb-3 h-10 w-10 text-muted-foreground/30" />
      <p className="text-sm">{t(($) => $.detail.item_unavailable)}</p>
    </div>
  ) : selected && selectedOutcome ? (
    <div className="p-6">
      <h2 className="text-lg font-semibold">
        {inboxTitle(selected, "detail", selectedIsGroupHead ? selectedEntry?.items.length ?? 1 : 1)}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {typeLabels[selected.type]} · {timeAgo(selected.created_at)}
      </p>
      <AutopilotRunReport
        item={selected}
        groupedItems={
          selectedIsGroupHead && selectedEntry
            ? selectedEntry.items
            : [selected]
        }
        onSelectItem={handleSelect}
      />
      <div className="mt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleArchive(
            selectedIsGroupHead && selectedEntry
              ? inboxDisplayEntryIds(selectedEntry)
              : [selected.id],
          )}
        >
          <Archive className="mr-1.5 h-3.5 w-3.5" />
          {t(($) => $.detail.archive)}
        </Button>
      </div>
    </div>
  ) : selected?.issue_id ? (
    // Key by issue_id (not inbox-item id): a new comment/reaction generates a
    // new inbox notification for the same issue. Keying on the notification id
    // would remount IssueDetail on every event, wiping the comment composer
    // draft and resetting scroll position.
    <ErrorBoundary resetKeys={[selected.issue_id]}>
      <IssueDetail
        key={selected.issue_id}
        issueId={selected.issue_id}
        defaultSidebarOpen={false}
        layoutId="multimira_inbox_issue_detail_layout"
        highlightCommentId={selected.details?.comment_id ?? undefined}
        initialIssueSessionId={
          urlSelectionKey === inboxItemSelectionKey(selected) && urlSession
            ? urlSession
            : selected.details?.issue_session_id ?? undefined
        }
        onIssueSessionChange={handleIssueSessionChange}
        onDelete={() => {
          // Ledger rows survive with issue_id cleared and switch to the
          // self-contained detail below. Action rows are deleted server-side.
          if (inboxItemSelectionKind(selected) === "issue") setSelectedKey("");
        }}
        onDone={() => {
          handleArchive(selectedEntry ? inboxDisplayEntryIds(selectedEntry) : [selected.id]);
        }}
      />
    </ErrorBoundary>
  ) : selected ? (
    <div className="p-6">
      <h2 className="text-lg font-semibold">
        {inboxTitle(selected, "detail", selectedEntry?.items.length ?? 1)}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {typeLabels[selected.type]} · {timeAgo(selected.created_at)}
      </p>
      {selected.body && (
        <div className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
          {selected.body}
        </div>
      )}
      {selected.type === "quick_create_failed" && selected.details?.original_prompt && (
        <div className="mt-4 rounded-md border bg-muted/40 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            {t(($) => $.detail.original_input)}
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm">{selected.details.original_prompt}</p>
        </div>
      )}
      {/* Renders nothing for non-Feishu rows. Approve/reject/ignore live here,
          in the stream, so a decision never requires a trip to Settings. */}
      <FeishuInboxActions item={selected} onArchive={() => handleArchive([selected.id])} />
      <div className="mt-4 flex gap-2">
        {selected.type === "quick_create_failed" && (
          <Button
            size="sm"
            onClick={() => {
              // Seed the legacy advanced form with the original prompt so the
              // user can recover their input in the full editor instead of
              // retyping. The agent picker hint becomes the assignee
              // candidate (still editable).
              const prompt = selected.details?.original_prompt ?? "";
              const agentId = selected.details?.agent_id;
              useIssueDraftStore.getState().setDraft({
                description: prompt,
                ...(agentId
                  ? { assigneeType: "agent" as const, assigneeId: agentId }
                  : {}),
              });
              useModalStore.getState().open("create-issue");
            }}
          >
            {t(($) => $.detail.edit_advanced)}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => handleArchive(selectedEntry ? inboxDisplayEntryIds(selectedEntry) : [selected.id])}
        >
          <Archive className="mr-1.5 h-3.5 w-3.5" />
          {t(($) => $.detail.archive)}
        </Button>
      </div>
    </div>
  ) : null;

  // -- Mobile layout: list / detail toggle -----------------------------------

  if (isMobile) {
    if (loading) {
      return (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex h-12 shrink-0 items-center border-b px-4">
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-1 p-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // Mobile: show detail full-screen when an item is selected
    if (selected || unavailableItem) {
      return (
        <div className="flex flex-1 flex-col min-h-0">
          <div className="flex h-12 shrink-0 items-center border-b px-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedKey("")}
              className="gap-1.5 text-muted-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              {t(($) => $.page.back)}
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {detailContent}
          </div>
        </div>
      );
    }

    // Mobile: full-screen list
    return (
      <div className="flex flex-1 flex-col min-h-0">
        {listHeader}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {listBody}
        </div>
      </div>
    );
  }

  // -- Desktop layout: resizable two-panel -----------------------------------

  if (loading) {
    return (
      <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <ResizablePanel id="list" defaultSize={320} minSize={240} maxSize={480} groupResizeBehavior="preserve-pixel-size">
          <div className="flex flex-col border-r h-full">
            <div className="flex h-12 shrink-0 items-center border-b px-4">
              <Skeleton className="h-5 w-16" />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-1 p-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="detail" minSize="40%">
          <div className="p-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="mt-4 h-4 w-32" />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" className="flex-1 min-h-0" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
      <ResizablePanel id="list" defaultSize={320} minSize={240} maxSize={480} groupResizeBehavior="preserve-pixel-size">
      <div className="flex flex-col border-r h-full">
        {listHeader}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {listBody}
        </div>
      </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel id="detail" minSize="40%">
      <div className="flex flex-col min-h-0 h-full">
        {detailContent ?? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <Inbox className="mb-3 h-10 w-10 text-muted-foreground/30" />
            <p className="text-sm">
              {loadFailed
                ? tCommon(($) => $.load_error.title)
                : items.length === 0
                  ? t(($) => $.detail.empty)
                  : t(($) => $.detail.select_prompt)}
            </p>
          </div>
        )}
      </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
