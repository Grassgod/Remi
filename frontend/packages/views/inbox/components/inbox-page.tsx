"use client";
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { inboxPageOptions, messageDetailKeys } from "@multiremi/core/inbox/queries";
import { useMarkAllInboxRead, useMarkInboxRead } from "@multiremi/core/inbox/mutations";
import { Button } from "@multiremi/ui/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@multiremi/ui/components/ui/resizable";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { ArrowLeft, CheckCheck, ChevronDown, Inbox } from "lucide-react";
import { PageHeader } from "../../layout/page-header";
import { Markdown } from "../../common/markdown";
import { MessageDecisionCard } from "../../issues/components/issue-decision-panel";
import { AttachmentList } from "../../issues/components/comment-card";
import { MessageHeader } from "../../common/message-header";
import { useListPerfMarker } from "../../common/use-list-perf-marker";
import { useNavigation } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";

export function InboxPage() {
  const wsId = useWorkspaceId();
  const { getActorName } = useActorName();
  const isMobile = useIsMobile();
  const { searchParams, pathname, replace } = useNavigation();
  const { t } = useT("inbox");
  const { t: tm } = useT("messages");
  const timeAgo = useTimeAgo();
  const [selected, setSelected] = useState<{ wsId: string; id: string; sourceItem: string | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const query = useInfiniteQuery(inboxPageOptions(wsId));
  const read = useMarkInboxRead();
  const allRead = useMarkAllInboxRead();
  const items = useMemo(() => [...new Map((query.data?.pages.flatMap(page => page.items) ?? []).map(item => [item.id, item])).values()], [query.data]);
  const selectedId = selected?.wsId === wsId && selected.sourceItem === searchParams.get("item") ? selected.id : searchParams.get("item") !== dismissed ? searchParams.get("item") : null;
  const selectedItem = items.find(item => item.id === selectedId);
  const message = useQuery({ queryKey: messageDetailKeys.detail(wsId, selectedId), enabled: !!selectedId,
    queryFn: () => api.getMessage(selectedId!), initialData: selectedItem, staleTime: 15_000 });
  const active = selectedItem && (!message.data || selectedItem.revision >= message.data.revision) ? selectedItem : message.data ?? null;
  const perfMarker = useListPerfMarker(query);
  const error = read.error ?? allRead.error;
  const header = <PageHeader className="justify-between">
    <h1 className="text-sm font-semibold">{t($ => $.page.title)} <span className="text-muted-foreground">{query.data?.pages[0]?.unread_count ?? 0}</span></h1>
    <Button size="sm" variant="ghost" disabled={allRead.isPending || read.isPending || query.isError || !(query.data?.pages[0]?.unread_count)}
      onClick={() => allRead.mutate()}><CheckCheck className="size-4" />{t($ => $.menu.mark_all_read)}</Button>
  </PageHeader>;
  const list = <div className="flex min-h-0 flex-1 flex-col" {...perfMarker}>
    {header}
    {error && <p role="alert" className="p-3 text-xs text-destructive">{error.message}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {query.isPending ? <div className="space-y-3 p-4">{[0,1,2].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
        : query.isError ? <div className="p-4"><p role="alert">{tm($ => $.load_failed)}</p><Button variant="outline" onClick={() => void query.refetch()}>{t($ => $.list.load_more)}</Button></div>
        : !items.length ? <div className="flex flex-col items-center gap-3 py-16 text-sm text-muted-foreground"><Inbox />{t($ => $.list.empty)}</div>
        : items.map(item => <button key={item.id} type="button" aria-pressed={active?.id === item.id} data-perf-item="inbox" data-perf-key={item.id}
          onClick={() => { setSelected({ wsId, id: item.id, sourceItem: searchParams.get("item") }); setDismissed(null); const params = new URLSearchParams(searchParams); params.set("item", item.id); replace(`${pathname}?${params}`); }} className={`block w-full min-w-0 border-b px-4 py-3 text-left hover:bg-muted/50 ${active?.id === item.id ? "bg-muted" : ""}`}>
          <MessageHeader message={item} getActorName={getActorName} />
          <p className="line-clamp-2 break-words text-sm">{item.body_md}</p>
          <time className="mt-1 block text-xs text-muted-foreground" dateTime={item.created_at}>{timeAgo(item.created_at)}</time>
        </button>)}
      {query.hasNextPage && <Button className="m-3" variant="ghost" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}><ChevronDown />{t($ => $.list.load_more)}</Button>}
    </div>
  </div>;
  const detail = active ? <div data-inbox-detail data-perf-scroll="inbox-detail" className="min-h-0 flex-1 overflow-y-auto p-4">
    {error && isMobile && <p role="alert" className="mb-3 text-xs text-destructive">{error.message}</p>}
    <div data-inbox-message={active.id} data-perf-item="message" data-perf-key={active.id}>
    {active.message_kind === "decision" ? <MessageDecisionCard message={active} canAnswer getActorName={getActorName} /> : <>
      <MessageHeader message={active} getActorName={getActorName} />
      <Markdown attachments={active.attachments}>{active.body_md}</Markdown>
      <AttachmentList attachments={active.attachments} content={active.body_md} />
    </>}
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-3">
      <Button size="sm" variant="outline" disabled={read.isPending || allRead.isPending}
        onClick={() => read.mutate({ session_id: active.session_id, to_seq: active.seq })}>
        <CheckCheck className="size-4" />{tm($ => $.read_to_here, { seq: active.seq })}
      </Button>
      {read.data?.session_id === active.session_id && <span className="text-xs text-muted-foreground">{tm($ => $.read_cursor, { seq: read.data.cursor_seq })}</span>}
    </div>
  </div> : <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
    {message.isError ? <><p role="alert">{tm($ => $.load_failed)}</p><Button variant="outline" onClick={() => void message.refetch()}>{tm($ => $.retry_load)}</Button></>
      : selectedId && message.isPending ? <Skeleton className="h-20 w-3/4" /> : t($ => $.detail.select_prompt)}
  </div>;
  if (isMobile) return selectedId ? <div className="flex min-h-0 flex-1 flex-col"><PageHeader><Button variant="ghost" onClick={() => { setSelected(null); setDismissed(searchParams.get("item")); const params = new URLSearchParams(searchParams); params.delete("item"); replace(`${pathname}${params.size ? `?${params}` : ""}`); }}><ArrowLeft />{t($ => $.page.back)}</Button></PageHeader>{detail}</div> : list;
  return <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
    <ResizablePanel id="list" defaultSize={320} minSize={240} maxSize={480}><div className="flex h-full flex-col border-r">{list}</div></ResizablePanel>
    <ResizableHandle /><ResizablePanel id="detail" minSize="40%">{detail}</ResizablePanel>
  </ResizablePanelGroup>;
}
