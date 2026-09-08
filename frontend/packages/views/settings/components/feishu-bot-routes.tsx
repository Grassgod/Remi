"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  feishuBotRoutesOptions,
  issueTopicConfigOptions,
} from "@multiremi/core/feishu-bot/queries";
import { useSaveFeishuBotRoutes } from "@multiremi/core/feishu-bot/mutations";
import type {
  FeishuBotAgentCandidate,
  FeishuBotAgentRoute,
  FeishuBotAgentRouteScope,
  FeishuBotCandidates,
} from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";
import {
  AgentRouteDialog,
  type PendingFeishuBotChatRoute,
} from "./feishu/agent-route-dialog";

const FOLLOW_DEFAULT = "__follow_default__";

interface FeishuBotRoutesProps {
  workspaceId: string;
  candidates: FeishuBotCandidates | null;
  candidatesPending: boolean;
}

export function FeishuBotRoutes({
  workspaceId,
  candidates,
  candidatesPending,
}: FeishuBotRoutesProps) {
  const { t } = useT("settings");
  const routesQuery = useQuery(feishuBotRoutesOptions(workspaceId));
  const issueTopicsQuery = useQuery(issueTopicConfigOptions(workspaceId));
  const save = useSaveFeishuBotRoutes(workspaceId);
  const [routes, setRoutes] = useState<FeishuBotAgentRoute[]>([]);
  const [dirty, setDirty] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [initialChatId, setInitialChatId] = useState<string | null>(null);

  useEffect(() => {
    if (dirty || !routesQuery.data) return;
    setRoutes(routesQuery.data.routes);
  }, [dirty, routesQuery.data]);

  const agents = candidates?.agents ?? [];
  const p2pRoute = routes.find((route) => route.scope === "p2p_default") ?? null;
  const groupRoute = routes.find((route) => route.scope === "group_default") ?? null;
  const chatRoutes = routes.filter((route) => route.scope === "chat");
  const issueTopicChatId = issueTopicsQuery.data?.config.chat_id?.trim() || null;
  const issueTopicRoute = issueTopicChatId
    ? chatRoutes.find((route) => route.chat_id === issueTopicChatId) ?? null
    : null;
  const hasArchivedRoute = routes.some((route) => route.agent_archived);

  function replaceDefault(scope: Exclude<FeishuBotAgentRouteScope, "chat">, agentId: string) {
    setRoutes((current) => {
      const withoutScope = current.filter((route) => route.scope !== scope);
      if (agentId === FOLLOW_DEFAULT) return withoutScope;
      const existing = current.find((route) => route.scope === scope);
      const agent = agents.find((candidate) => candidate.id === agentId);
      return [...withoutScope, routeRecord({
        existing,
        scope,
        agentId,
        agentName: agent?.name ?? null,
      })];
    });
    setDirty(true);
  }

  function replaceChatAgent(route: FeishuBotAgentRoute, agentId: string) {
    const agent = agents.find((candidate) => candidate.id === agentId);
    setRoutes((current) => current.map((candidate) => candidate === route
      ? { ...candidate, agent_id: agentId, agent_name: agent?.name ?? null, agent_archived: false }
      : candidate));
    setDirty(true);
  }

  function addChatRoute(route: PendingFeishuBotChatRoute) {
    setRoutes((current) => {
      const existing = current.find((candidate) =>
        candidate.scope === "chat" && candidate.chat_id === route.chatId
      );
      const next = routeRecord({
        existing,
        scope: "chat",
        chatId: route.chatId,
        chatName: route.chatName,
        memberCount: route.memberCount,
        agentId: route.agentId,
        agentName: route.agentName,
      });
      return [...current.filter((candidate) =>
        candidate.scope !== "chat" || candidate.chat_id !== route.chatId
      ), next];
    });
    setDirty(true);
  }

  function reset() {
    setRoutes(routesQuery.data?.routes ?? []);
    setDirty(false);
  }

  async function handleSave() {
    if (!dirty || hasArchivedRoute) return;
    try {
      const result = await save.mutateAsync({
        routes: routes.map((route) => ({
          scope: route.scope,
          agent_id: route.agent_id,
          ...(route.scope === "chat"
            ? { chat_id: route.chat_id, chat_name: route.chat_name }
            : {}),
        })),
      });
      const memberCounts = new Map(chatRoutes.map((route) => [route.chat_id, route.member_count]));
      setRoutes(result.routes.map((route) => ({
        ...route,
        member_count: route.scope === "chat"
          ? memberCounts.get(route.chat_id) ?? route.member_count
          : route.member_count,
      })));
      setDirty(false);
      toast.success(t(($) => $.feishu.concierge.routes.toast_saved));
    } catch (error) {
      toast.error(error instanceof Error && error.message
        ? error.message
        : t(($) => $.feishu.concierge.routes.toast_save_failed));
    }
  }

  function openDialog(chatId: string | null = null) {
    setInitialChatId(chatId);
    setDialogOpen(true);
  }

  return (
    <div className="space-y-5 border-t pt-5">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t(($) => $.feishu.concierge.routes.title)}</h3>
          <Badge variant="secondary" className="text-[10px] uppercase">
            {t(($) => $.feishu.concierge.routes.new_badge)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(($) => $.feishu.concierge.routes.description)}
        </p>
      </div>

      {routesQuery.isError && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {t(($) => $.feishu.concierge.routes.load_error)}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <RouteAgentSelect
          label={t(($) => $.feishu.concierge.routes.p2p_label)}
          hint={t(($) => $.feishu.concierge.routes.p2p_hint)}
          route={p2pRoute}
          agents={agents}
          disabled={candidatesPending || routesQuery.isPending || save.isPending}
          onChange={(agentId) => replaceDefault("p2p_default", agentId)}
        />
        <RouteAgentSelect
          label={t(($) => $.feishu.concierge.routes.group_label)}
          hint={t(($) => $.feishu.concierge.routes.group_hint)}
          route={groupRoute}
          agents={agents}
          disabled={candidatesPending || routesQuery.isPending || save.isPending}
          onChange={(agentId) => replaceDefault("group_default", agentId)}
        />
      </div>

      <div className="space-y-2">
        <Label>{t(($) => $.feishu.concierge.routes.chat_routes_label)}</Label>
        {chatRoutes.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            {t(($) => $.feishu.concierge.routes.chat_routes_empty)}
          </p>
        ) : (
          <div className="divide-y overflow-hidden rounded-md border">
            {chatRoutes.map((route) => (
              <div
                key={route.chat_id ?? route.id}
                data-testid={`feishu-route-${route.chat_id ?? route.id}`}
                className={cn(
                  "grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(180px,280px)_auto] sm:items-center",
                  route.agent_archived
                    && "bg-destructive/5 text-destructive ring-1 ring-inset ring-destructive/40",
                )}
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className={cn(
                      "truncate text-sm font-medium",
                      route.agent_archived ? "text-destructive" : "text-foreground",
                    )}>
                      {route.chat_name || route.chat_id}
                    </p>
                    {route.chat_id === issueTopicChatId && (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {t(($) => $.feishu.concierge.routes.issue_topic_badge)}
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {memberCountText(route.member_count, t)} · {route.chat_id}
                  </p>
                  {route.agent_archived && (
                    <p className="mt-1 text-xs text-destructive">
                      {t(($) => $.feishu.concierge.routes.archived_fallback)}
                    </p>
                  )}
                </div>
                <RouteAgentSelect
                  compact
                  label={t(($) => $.feishu.concierge.routes.chat_agent_label, {
                    chat: route.chat_name || route.chat_id || "",
                  })}
                  route={route}
                  agents={agents}
                  disabled={candidatesPending || save.isPending}
                  onChange={(agentId) => replaceChatAgent(route, agentId)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-self-start text-muted-foreground sm:justify-self-end"
                  onClick={() => {
                    setRoutes((current) => current.filter((candidate) => candidate !== route));
                    setDirty(true);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t(($) => $.feishu.concierge.routes.delete_chat)}
                </Button>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button type="button" size="sm" onClick={() => openDialog()}>
            <Plus className="size-4" aria-hidden />
            {t(($) => $.feishu.concierge.routes.add_chat)}
          </Button>
          {issueTopicChatId && (issueTopicRoute ? (
            <p className="text-xs text-muted-foreground">
              {t(($) => $.feishu.concierge.routes.issue_topic_present, {
                chat: issueTopicRoute.chat_name || issueTopicRoute.chat_id || issueTopicChatId,
              })}
            </p>
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto justify-start p-0 text-xs"
              onClick={() => openDialog(issueTopicChatId)}
            >
              {t(($) => $.feishu.concierge.routes.issue_topic_add)}
            </Button>
          ))}
        </div>
      </div>

      {hasArchivedRoute && (
        <p role="alert" className="text-xs text-destructive">
          {t(($) => $.feishu.concierge.routes.archived_save_blocked)}
        </p>
      )}

      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground">
          {t(($) => $.feishu.concierge.routes.priority_hint)}
        </p>
        <div className="flex shrink-0 justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={!dirty || save.isPending} onClick={reset}>
            <RotateCcw className="size-4" aria-hidden />
            {t(($) => $.feishu.concierge.routes.reset)}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || hasArchivedRoute || save.isPending}
            onClick={() => void handleSave()}
          >
            {save.isPending
              ? t(($) => $.feishu.concierge.routes.saving)
              : t(($) => $.feishu.concierge.routes.save)}
          </Button>
        </div>
      </div>

      <AgentRouteDialog
        workspaceId={workspaceId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        agents={agents}
        routes={chatRoutes}
        suggestedAgentId={groupRoute?.agent_archived ? null : groupRoute?.agent_id ?? null}
        issueTopicChatId={issueTopicChatId}
        initialChatId={initialChatId}
        onAdd={addChatRoute}
      />
    </div>
  );
}

function RouteAgentSelect({
  label,
  hint,
  route,
  agents,
  disabled,
  compact = false,
  onChange,
}: {
  label: string;
  hint?: string;
  route: FeishuBotAgentRoute | null;
  agents: FeishuBotAgentCandidate[];
  disabled: boolean;
  compact?: boolean;
  onChange: (agentId: string) => void;
}) {
  const { t } = useT("settings");
  const selectedAgent = agents.find((agent) => agent.id === route?.agent_id);
  const selectedName = selectedAgent?.name ?? route?.agent_name ?? route?.agent_id;
  const value = route?.agent_id ?? FOLLOW_DEFAULT;
  return (
    <div className={compact ? "min-w-0" : "space-y-1.5"}>
      {!compact && <Label>{label}</Label>}
      <Select value={value} disabled={disabled} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger
          className={cn("w-full min-w-0", route?.agent_archived && "border-destructive text-destructive")}
          aria-label={label}
        >
          <SelectValue>
            {() => selectedName ?? t(($) => $.feishu.concierge.routes.follow_default)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {!compact && (
            <SelectItem value={FOLLOW_DEFAULT}>
              {t(($) => $.feishu.concierge.routes.follow_default)}
            </SelectItem>
          )}
          {route?.agent_archived && !selectedAgent && (
            <SelectItem value={route.agent_id} disabled>
              {selectedName} · {t(($) => $.feishu.concierge.routes.archived_agent)}
            </SelectItem>
          )}
          {agents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!compact && hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function routeRecord({
  existing,
  scope,
  chatId = null,
  chatName = null,
  memberCount = null,
  agentId,
  agentName,
}: {
  existing?: FeishuBotAgentRoute;
  scope: FeishuBotAgentRouteScope;
  chatId?: string | null;
  chatName?: string | null;
  memberCount?: number | null;
  agentId: string;
  agentName: string | null;
}): FeishuBotAgentRoute {
  return {
    id: existing?.id ?? `draft:${scope}:${chatId ?? "default"}`,
    scope,
    chat_id: chatId ?? existing?.chat_id ?? null,
    chat_name: chatName ?? existing?.chat_name ?? null,
    member_count: memberCount ?? existing?.member_count ?? null,
    agent_id: agentId,
    agent_name: agentName,
    agent_archived: false,
    created_at: existing?.created_at ?? "",
    updated_at: existing?.updated_at ?? "",
    updated_by: existing?.updated_by ?? null,
  };
}

function memberCountText(
  count: number | null,
  t: ReturnType<typeof useT<"settings">>["t"],
): string {
  return count === null
    ? t(($) => $.feishu.concierge.routes.member_count_unknown)
    : t(($) => $.feishu.concierge.routes.member_count, { count });
}
