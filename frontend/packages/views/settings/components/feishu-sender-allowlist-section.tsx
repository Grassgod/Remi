"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { feishuBotOptions, feishuBotSendersOptions } from "@multiremi/core/feishu-bot/queries";
import { useUpdateFeishuBotSender } from "@multiremi/core/feishu-bot/mutations";
import { useWorkspaceId } from "@multiremi/core/hooks";
import type { FeishuBotSender } from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { useT } from "../../i18n";
import { absoluteTime } from "./feishu/shared";

export function FeishuSenderAllowlistSection() {
  const { t } = useT("settings");
  const workspaceId = useWorkspaceId();
  const botQuery = useQuery(feishuBotOptions(workspaceId));
  const bot = botQuery.data?.role === "admin" ? botQuery.data.config : undefined;
  const enabled = bot?.configured === true && bot.app_id.length > 0 && !botQuery.isError;
  const sendersQuery = useQuery(feishuBotSendersOptions(workspaceId, enabled));
  const update = useUpdateFeishuBotSender(workspaceId);

  if (botQuery.data?.role === "member" && !botQuery.isError) return null;

  async function setAllowed(sender: FeishuBotSender) {
    try {
      await update.mutateAsync({ senderId: sender.id, allowed: !sender.allowed });
      toast.success(sender.allowed
        ? t(($) => $.feishu.senderAllowlist.toast_removed)
        : t(($) => $.feishu.senderAllowlist.toast_added));
    } catch (error) {
      toast.error(error instanceof Error
        ? error.message
        : t(($) => $.feishu.senderAllowlist.toast_update_failed));
    }
  }

  const failed = botQuery.isError || (enabled && sendersQuery.isError);
  const loading = botQuery.isPending || (enabled && sendersQuery.isPending);
  const refreshing = botQuery.isFetching || sendersQuery.isFetching;
  const senders = (sendersQuery.data?.senders ?? [])
    .filter((sender) => sender.app_id === bot?.app_id)
    .toSorted((left, right) => Number(left.allowed) - Number(right.allowed));

  return (
    <section className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">{t(($) => $.feishu.senderAllowlist.title)}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t(($) => $.feishu.senderAllowlist.description)}
          </p>
        </div>
        {(enabled || botQuery.isError) && (
          <Button
            variant="outline"
            size="sm"
            disabled={refreshing}
            onClick={() => { void (botQuery.isError ? botQuery.refetch() : sendersQuery.refetch()); }}
          >
            <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} aria-hidden />
            {t(($) => $.feishu.senderAllowlist.refresh)}
          </Button>
        )}
      </div>

      <Card>
        <CardContent>
          {failed ? (
            <p role="alert" className="text-sm text-destructive">
              {t(($) => $.feishu.senderAllowlist.load_failed)}
            </p>
          ) : loading ? (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              {t(($) => $.feishu.senderAllowlist.loading)}
            </p>
          ) : !enabled ? (
            <p className="text-sm text-muted-foreground">{t(($) => $.feishu.senderAllowlist.configure_first)}</p>
          ) : senders.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t(($) => $.feishu.senderAllowlist.empty)}</p>
          ) : (
            <ul className="max-h-96 divide-y overflow-y-auto">
              {senders.map((sender) => {
                const accountId = sender.open_id ?? sender.union_id ?? sender.id;
                const knownName = sender.display_name?.trim();
                const name = knownName && !/^feishu user$/i.test(knownName)
                  ? knownName : t(($) => $.feishu.senderAllowlist.unnamed, { id: accountId.slice(-8) });
                const englishName = sender.name_en?.trim();
                const saving = update.isPending && update.variables?.senderId === sender.id;
                return (
                  <li key={sender.id} aria-label={name} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                    <div aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                      {knownName && !/^feishu user$/i.test(knownName) ? Array.from(name)[0] : "?"}
                    </div>
                    <div className="min-w-0 flex-1 basis-48 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium" title={name}>{name}</span>
                        <Badge variant={sender.allowed ? "secondary" : "outline"}>
                          {sender.allowed
                            ? t(($) => $.feishu.senderAllowlist.allowed)
                            : t(($) => $.feishu.senderAllowlist.pending)}
                        </Badge>
                      </div>
                      {englishName && englishName !== name && (
                        <p className="truncate text-xs text-muted-foreground" title={englishName}>{englishName}</p>
                      )}
                      <p className="truncate font-mono text-xs text-muted-foreground" title={accountId}>
                        <span className="font-sans">{sender.open_id ? "Open ID" : sender.union_id ? "Union ID" : "ID"}: </span>{accountId}
                      </p>
                      {sender.union_id && sender.open_id && (
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer">{t(($) => $.feishu.senderAllowlist.account_identifiers)}</summary>
                          <p className="mt-1 break-all font-mono">Union ID: {sender.union_id}</p>
                        </details>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t(($) => $.feishu.senderAllowlist.last_seen, { when: absoluteTime(sender.last_seen_at) ?? "--" })}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" disabled={update.isPending} onClick={() => { void setAllowed(sender); }}>
                      {saving && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
                      {sender.allowed
                        ? t(($) => $.feishu.senderAllowlist.remove)
                        : t(($) => $.feishu.senderAllowlist.add)}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
