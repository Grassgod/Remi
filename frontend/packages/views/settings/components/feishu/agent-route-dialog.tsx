"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { feishuBotChatsOptions } from "@multiremi/core/feishu-bot/queries";
import type {
  FeishuBotAgentCandidate,
  FeishuBotAgentRoute,
  FeishuBotChat,
} from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@multiremi/ui/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@multiremi/ui/components/ui/select";
import { useT } from "../../../i18n";

export interface PendingFeishuBotChatRoute {
  chatId: string;
  chatName: string;
  memberCount: number | null;
  agentId: string;
  agentName: string;
}

interface AgentRouteDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: FeishuBotAgentCandidate[];
  routes: FeishuBotAgentRoute[];
  suggestedAgentId: string | null;
  issueTopicChatId: string | null;
  initialChatId: string | null;
  onAdd: (route: PendingFeishuBotChatRoute) => void;
}

export function AgentRouteDialog({
  workspaceId,
  open,
  onOpenChange,
  agents,
  routes,
  suggestedAgentId,
  issueTopicChatId,
  initialChatId,
  onAdd,
}: AgentRouteDialogProps) {
  const { t } = useT("settings");
  const chatsQuery = useQuery(feishuBotChatsOptions(workspaceId, open));
  const chats = chatsQuery.data?.chats ?? [];
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelectedChatId(initialChatId);
    setSelectedAgentId(suggestedAgentId ?? agents[0]?.id ?? "");
  }, [agents, initialChatId, open, suggestedAgentId]);

  const selectedChat = chats.find((chat) => chat.chat_id === selectedChatId) ?? null;
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const routesByChat = useMemo(
    () => new Map(routes.filter((route) => route.scope === "chat" && route.chat_id)
      .map((route) => [route.chat_id as string, route])),
    [routes],
  );

  function handleAdd() {
    if (!selectedChat || !selectedAgent) return;
    onAdd({
      chatId: selectedChat.chat_id,
      chatName: selectedChat.name || selectedChat.chat_id,
      memberCount: selectedChat.member_count,
      agentId: selectedAgent.id,
      agentName: selectedAgent.name,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{t(($) => $.feishu.concierge.routes.dialog.title)}</DialogTitle>
          <DialogDescription>
            {t(($) => $.feishu.concierge.routes.dialog.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="feishu-bot-route-chat">
              {t(($) => $.feishu.concierge.routes.dialog.chat_label)}
            </Label>
            {chatsQuery.isError ? (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {chatListError(chatsQuery.error, t(($) => $.feishu.concierge.routes.dialog.chat_error))}
              </p>
            ) : (
              <Combobox
                items={chats}
                value={selectedChat}
                onValueChange={(chat) => setSelectedChatId(chat?.chat_id ?? null)}
                itemToStringLabel={(chat) => chat.name || chat.chat_id}
                itemToStringValue={(chat) => `${chat.name} ${chat.chat_id}`}
                isItemEqualToValue={(chat, value) => chat.chat_id === value.chat_id}
              >
                <ComboboxInput
                  id="feishu-bot-route-chat"
                  className="w-full"
                  disabled={chatsQuery.isPending}
                  placeholder={t(($) => $.feishu.concierge.routes.dialog.chat_placeholder)}
                />
                <ComboboxContent>
                  <ComboboxEmpty>
                    {t(($) => $.feishu.concierge.routes.dialog.chat_empty)}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(chat: FeishuBotChat) => {
                      const route = routesByChat.get(chat.chat_id);
                      return (
                        <ComboboxItem key={chat.chat_id} value={chat} className="min-h-12 py-2">
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{chat.name || chat.chat_id}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {memberCountText(chat.member_count, t)}
                              {chat.chat_id === issueTopicChatId
                                ? ` · ${t(($) => $.feishu.concierge.routes.dialog.topic_group)}`
                                : ""}
                            </span>
                          </span>
                          <span className={route
                            ? "shrink-0 text-xs text-brand"
                            : "shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"}
                          >
                            {route
                              ? t(($) => $.feishu.concierge.routes.dialog.configured, {
                                agent: route.agent_name ?? route.agent_id,
                              })
                              : t(($) => $.feishu.concierge.routes.dialog.group_default)}
                          </span>
                        </ComboboxItem>
                      );
                    }}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            )}
            {chatsQuery.isPending && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                {t(($) => $.feishu.concierge.routes.dialog.chat_loading)}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>{t(($) => $.feishu.concierge.routes.dialog.agent_label)}</Label>
            <Select
              value={selectedAgentId}
              onValueChange={(value) => value && setSelectedAgentId(value)}
            >
              <SelectTrigger className="w-full" aria-label={t(($) => $.feishu.concierge.routes.dialog.agent_label)}>
                <SelectValue>
                  {() => selectedAgent?.name ?? t(($) => $.feishu.concierge.agent_placeholder)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {t(($) => $.feishu.concierge.routes.dialog.effect_hint)}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t(($) => $.feishu.concierge.routes.dialog.cancel)}
          </Button>
          <Button onClick={handleAdd} disabled={!selectedChat || !selectedAgent || chatsQuery.isError}>
            {t(($) => $.feishu.concierge.routes.dialog.add)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function memberCountText(
  count: number | null,
  t: ReturnType<typeof useT<"settings">>["t"],
): string {
  return count === null
    ? t(($) => $.feishu.concierge.routes.member_count_unknown)
    : t(($) => $.feishu.concierge.routes.member_count, { count });
}

function chatListError(error: unknown, fallback: string): string {
  if (!error || typeof error !== "object") return fallback;
  const body = "body" in error ? error.body : null;
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
