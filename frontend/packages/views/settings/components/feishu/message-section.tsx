"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Filter, MoreHorizontal, Search } from "lucide-react";
import {
  feishuChatsOptions,
  feishuMessagesOptions,
  isFeishuMessageProcessed,
  pendingProposalCount,
  useApproveFeishuProposal,
  useRejectFeishuProposal,
  type FeishuMessage,
  type FeishuMessageOutcome,
  type FeishuSource,
} from "@multiremi/core/feishu";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@multiremi/ui/components/ui/sheet";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { cn } from "@multiremi/ui/lib/utils";
import { useNavigation } from "../../../navigation";
import { useT, useTimeAgo } from "../../../i18n";
import { absoluteTime, senderName, truncateId } from "./shared";
import { MessageActionDialog, type MessageActionKind } from "./message-action-dialog";

const PAGE_SIZE = 25;
const ANY = "__any__";

type ProcessedFilter = "all" | "unprocessed" | "processed";

interface Filters {
  processed: ProcessedFilter;
  source: string;
  chat: string;
  since: string;
  until: string;
  q: string;
}

const EMPTY_FILTERS: Filters = { processed: "all", source: "", chat: "", since: "", until: "", q: "" };

/**
 * Filters live in the URL so a stuck source or a suspicious sender can be sent
 * to a teammate as a link. `replace` rather than `push`: tweaking a filter is
 * not a navigation step a Back press should have to unwind.
 */
function useMessageFilters() {
  const navigation = useNavigation();
  const params = navigation.searchParams;
  const processed = params.get("processed");
  const filters: Filters = {
    processed: processed === "unprocessed" || processed === "processed" ? processed : "all",
    source: params.get("source") ?? "",
    chat: params.get("chat") ?? "",
    since: params.get("since") ?? "",
    until: params.get("until") ?? "",
    q: params.get("q") ?? "",
  };

  const apply = (next: Partial<Filters>) => {
    const merged = { ...filters, ...next };
    const search = new URLSearchParams(params);
    for (const [key, value] of Object.entries(merged)) {
      if (value === "" || (key === "processed" && value === "all")) search.delete(key);
      else search.set(key, value);
    }
    const encoded = search.toString();
    navigation.replace(encoded ? `${navigation.pathname}?${encoded}` : navigation.pathname);
  };

  return { filters, apply };
}

interface MessageSectionProps {
  workspaceId: string;
  sources: FeishuSource[];
}

export function MessageSection({ workspaceId, sources }: MessageSectionProps) {
  const { t } = useT("settings");
  const { filters, apply } = useMessageFilters();
  const [pageCount, setPageCount] = useState(1);
  const [action, setAction] = useState<{ kind: MessageActionKind; message: FeishuMessage } | null>(null);
  const [searchInput, setSearchInput] = useState(filters.q);

  const filterKey = `${filters.processed}|${filters.source}|${filters.chat}|${filters.since}|${filters.until}|${filters.q}`;
  // Any filter change invalidates the accumulated window — otherwise "load
  // more" would keep asking for page 4 of a list that now has one page.
  useEffect(() => setPageCount(1), [filterKey]);

  useEffect(() => {
    if (searchInput === filters.q) return;
    const handle = setTimeout(() => apply({ q: searchInput }), 300);
    return () => clearTimeout(handle);
    // `apply` closes over the current filters and is recreated every render;
    // depending on it would restart the timer on every keystroke's re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, filters.q]);

  const messagesQuery = useQuery(feishuMessagesOptions(workspaceId, {
    limit: PAGE_SIZE * pageCount,
    offset: 0,
    source: filters.source || undefined,
    chat: filters.chat || undefined,
    q: filters.q || undefined,
    since: filters.since ? new Date(filters.since).toISOString() : undefined,
    until: filters.until ? new Date(filters.until).toISOString() : undefined,
    processed: filters.processed === "all" ? undefined : filters.processed === "processed",
  }));
  const chatsQuery = useQuery(feishuChatsOptions(workspaceId));

  const messages = messagesQuery.data?.messages ?? [];
  const total = messagesQuery.data?.total ?? 0;
  const hasMore = messagesQuery.data?.hasMore === true || messages.length < total;

  const chatOptions = useMemo(() => {
    const chats = chatsQuery.data?.chats ?? [];
    return filters.source ? chats.filter((chat) => chat.sourceId === filters.source) : chats;
  }, [chatsQuery.data, filters.source]);

  const hasFilters = filterKey !== "all|||||";

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t(($) => $.feishu.messages.title)}</h3>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={() => apply(EMPTY_FILTERS)}>
            {t(($) => $.feishu.messages.clear_filters)}
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border" role="group" aria-label={t(($) => $.feishu.messages.state_filter)}>
          {(["all", "unprocessed", "processed"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filters.processed === value}
              onClick={() => apply({ processed: value })}
              className={cn(
                "min-h-11 px-3 text-sm first:rounded-l-md last:rounded-r-md md:min-h-9",
                filters.processed === value ? "bg-secondary font-medium" : "text-muted-foreground",
              )}
            >
              {value === "all"
                ? t(($) => $.feishu.messages.filter_all)
                : value === "unprocessed"
                ? t(($) => $.feishu.messages.filter_unprocessed)
                : t(($) => $.feishu.messages.filter_processed)}
            </button>
          ))}
        </div>

        <div className="relative min-w-48 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="pl-8"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t(($) => $.feishu.messages.search_placeholder)}
            aria-label={t(($) => $.feishu.messages.search_placeholder)}
          />
        </div>

        {/* Wide screens get the filters inline; narrow ones get a Sheet whose
            draft is only committed on Apply, so a half-built filter never
            triggers a request over a phone connection. */}
        <div className="hidden items-center gap-2 md:flex">
          <FilterControls
            filters={filters}
            sources={sources}
            chatOptions={chatOptions}
            onChange={apply}
          />
        </div>
        <MobileFilterSheet
          filters={filters}
          sources={sources}
          chatOptions={chatOptions}
          onApply={apply}
        />
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {messagesQuery.isPending
          ? t(($) => $.feishu.messages.loading)
          : t(($) => $.feishu.messages.count, { shown: messages.length, total })}
      </p>

      {messagesQuery.isPending && messages.length === 0
        ? <Skeleton className="h-40 w-full" />
        : messagesQuery.isError
        ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-destructive">
              {t(($) => $.feishu.messages.load_failed)}
            </CardContent>
          </Card>
        )
        : messages.length === 0
        ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {hasFilters
                ? t(($) => $.feishu.messages.empty_filtered)
                : t(($) => $.feishu.messages.empty)}
            </CardContent>
          </Card>
        )
        : (
          <ul className="space-y-2">
            {messages.map((message) => (
              <li key={message.messageId}>
                <MessageCard
                  message={message}
                  workspaceId={workspaceId}
                  onAction={(kind) => setAction({ kind, message })}
                />
              </li>
            ))}
          </ul>
        )}

      {hasMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            className="min-h-11 md:min-h-9"
            disabled={messagesQuery.isFetching}
            onClick={() => setPageCount((count) => count + 1)}
          >
            {messagesQuery.isFetching
              ? t(($) => $.feishu.messages.loading)
              : t(($) => $.feishu.messages.load_more)}
          </Button>
        </div>
      )}

      <MessageActionDialog
        action={action?.kind ?? null}
        message={action?.message ?? null}
        workspaceId={workspaceId}
        onClose={() => setAction(null)}
      />
    </section>
  );
}

interface FilterControlProps {
  filters: Filters;
  sources: FeishuSource[];
  chatOptions: { chatId: string; chatName: string | null }[];
  onChange: (next: Partial<Filters>) => void;
}

function FilterControls({ filters, sources, chatOptions, onChange }: FilterControlProps) {
  const { t } = useT("settings");
  return (
    <>
      <Select
        value={filters.source || ANY}
        onValueChange={(value) => onChange({ source: String(value) === ANY ? "" : String(value), chat: "" })}
      >
        <SelectTrigger className="w-40" aria-label={t(($) => $.feishu.messages.filter_source)}>
          <SelectValue placeholder={t(($) => $.feishu.messages.filter_source)} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t(($) => $.feishu.messages.any_source)}</SelectItem>
          {sources.map((source) => (
            <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.chat || ANY}
        onValueChange={(value) => onChange({ chat: String(value) === ANY ? "" : String(value) })}
      >
        <SelectTrigger className="w-40" aria-label={t(($) => $.feishu.messages.filter_chat)}>
          <SelectValue placeholder={t(($) => $.feishu.messages.filter_chat)} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>{t(($) => $.feishu.messages.any_chat)}</SelectItem>
          {chatOptions.map((chat) => (
            <SelectItem key={chat.chatId} value={chat.chatId}>
              {chat.chatName ?? truncateId(chat.chatId)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        type="date"
        className="w-36"
        value={filters.since}
        aria-label={t(($) => $.feishu.messages.filter_since)}
        onChange={(event) => onChange({ since: event.target.value })}
      />
      <Input
        type="date"
        className="w-36"
        value={filters.until}
        aria-label={t(($) => $.feishu.messages.filter_until)}
        onChange={(event) => onChange({ until: event.target.value })}
      />
    </>
  );
}

function MobileFilterSheet({ filters, sources, chatOptions, onApply }: {
  filters: Filters;
  sources: FeishuSource[];
  chatOptions: { chatId: string; chatName: string | null }[];
  onApply: (next: Partial<Filters>) => void;
}) {
  const { t } = useT("settings");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Filters>(filters);

  useEffect(() => {
    if (open) setDraft(filters);
    // Re-seeding only on open keeps a background refetch from wiping a
    // half-entered date range under the user's fingers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="outline" className="min-h-11 md:hidden">
            <Filter className="size-4" aria-hidden />
            {t(($) => $.feishu.messages.filters)}
          </Button>
        }
      />
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t(($) => $.feishu.messages.filters)}</SheetTitle>
          <SheetDescription>{t(($) => $.feishu.messages.filters_description)}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <div className="space-y-1.5">
            <Label>{t(($) => $.feishu.messages.filter_source)}</Label>
            <FilterControls
              filters={draft}
              sources={sources}
              chatOptions={chatOptions}
              onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
            />
          </div>
        </div>
        <SheetFooter>
          <Button
            variant="outline"
            onClick={() => setDraft({ ...EMPTY_FILTERS, processed: draft.processed, q: draft.q })}
          >
            {t(($) => $.feishu.messages.clear_filters)}
          </Button>
          <Button
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            {t(($) => $.feishu.messages.apply_filters)}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function MessageCard({ message, workspaceId, onAction }: {
  message: FeishuMessage;
  workspaceId: string;
  onAction: (kind: MessageActionKind) => void;
}) {
  const { t } = useT("settings");
  const timeAgo = useTimeAgo();
  const processed = isFeishuMessageProcessed(message);
  const pendingProposals = pendingProposalCount(message);

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
              <span className="truncate">{message.chatName ?? truncateId(message.chatId)}</span>
              <span className="text-muted-foreground">·</span>
              <span className="truncate text-muted-foreground">
                {senderName(message.sender, t(($) => $.feishu.messages.unknown_sender))}
              </span>
            </p>
            <p className="text-xs text-muted-foreground" title={absoluteTime(message.createdAt)}>
              {message.createdAt ? timeAgo(message.createdAt) : "—"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {message.messageAppLink !== null && message.messageAppLink !== "" && (
              <Button
                variant="ghost"
                size="icon"
                className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                aria-label={t(($) => $.feishu.messages.open_in_feishu)}
                render={<a href={message.messageAppLink} target="_blank" rel="noreferrer noopener" />}
              >
                <ExternalLink className="size-4" aria-hidden />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
                    aria-label={t(($) => $.feishu.messages.actions_for, {
                      sender: senderName(message.sender, t(($) => $.feishu.messages.unknown_sender)),
                    })}
                  />
                }
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onAction("notify")}>
                  {t(($) => $.feishu.messages.action_notify)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAction("draft")}>
                  {t(($) => $.feishu.messages.action_draft)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAction("propose")}>
                  {t(($) => $.feishu.messages.action_propose)}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onAction("process")} disabled={processed}>
                  {t(($) => $.feishu.messages.action_process)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAction("ignore")} disabled={processed}>
                  {t(($) => $.feishu.messages.action_ignore)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <p className="line-clamp-4 whitespace-pre-wrap text-sm">
          {message.searchableText || t(($) => $.feishu.messages.no_text)}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={processed ? "secondary" : "outline"}>
            {processed
              ? t(($) => $.feishu.messages.badge_processed)
              : t(($) => $.feishu.messages.badge_unprocessed)}
          </Badge>
          {message.retryCount > 0 && (
            <Badge variant="outline">
              {t(($) => $.feishu.messages.badge_retries, { times: message.retryCount })}
            </Badge>
          )}
          {message.recalled && (
            <Badge variant="outline">{t(($) => $.feishu.messages.badge_recalled)}</Badge>
          )}
          {pendingProposals > 0 && (
            <Badge variant="outline">
              {t(($) => $.feishu.messages.badge_pending_proposals, { pending: pendingProposals })}
            </Badge>
          )}
        </div>

        {message.outcomes.length > 0 && (
          <OutcomeList
            outcomes={message.outcomes}
            workspaceId={workspaceId}
            pendingProposals={pendingProposals}
          />
        )}
      </CardContent>
    </Card>
  );
}

function OutcomeList({ outcomes, workspaceId, pendingProposals }: {
  outcomes: FeishuMessageOutcome[];
  workspaceId: string;
  pendingProposals: number;
}) {
  const { t } = useT("settings");
  const timeAgo = useTimeAgo();
  const approve = useApproveFeishuProposal(workspaceId);
  const reject = useRejectFeishuProposal(workspaceId);
  const pending = approve.isPending || reject.isPending;

  const label = (kind: string): string => {
    switch (kind) {
      case "issue_proposed": return t(($) => $.feishu.messages.outcome_issue_proposed);
      case "issue_created": return t(($) => $.feishu.messages.outcome_issue_created);
      case "notified": return t(($) => $.feishu.messages.outcome_notified);
      case "reply_drafted": return t(($) => $.feishu.messages.outcome_reply_drafted);
      case "ignored": return t(($) => $.feishu.messages.outcome_ignored);
      case "dismissed": return t(($) => $.feishu.messages.outcome_dismissed);
      // A server that grows a new outcome kind still renders a readable row.
      default: return kind;
    }
  };

  return (
    <ul className="space-y-1 border-t pt-2 text-xs">
      {outcomes.map((outcome) => {
        // Only the newest unsettled proposal is actionable; older ones already
        // have an approval or rejection recorded after them.
        const actionable = outcome.outcomeKind === "issue_proposed"
          && pendingProposals > 0
          && outcome.ref !== null
          && outcome.ref !== "";
        return (
          <li key={outcome.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{label(outcome.outcomeKind)}</span>
            {outcome.reason !== null && outcome.reason !== "" && (
              <span className="min-w-0 truncate text-muted-foreground">{outcome.reason}</span>
            )}
            <span className="text-muted-foreground" title={absoluteTime(outcome.createdAt)}>
              {outcome.createdAt ? timeAgo(outcome.createdAt) : "—"}
            </span>
            {actionable && (
              <span className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => approve.mutate(outcome.ref ?? "")}
                >
                  {t(($) => $.feishu.messages.approve)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => reject.mutate(outcome.ref ?? "")}
                >
                  {t(($) => $.feishu.messages.reject)}
                </Button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
