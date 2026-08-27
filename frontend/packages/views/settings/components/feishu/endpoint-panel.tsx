"use client";

import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  deriveEndpointState,
  feishuEndpointStateTone,
  useCheckFeishuEndpoint,
  type FeishuEndpointHealth,
  type FeishuEndpointState,
} from "@multiremi/core/feishu";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@multiremi/ui/components/ui/card";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { cn } from "@multiremi/ui/lib/utils";
import { useT, useTimeAgo } from "../../../i18n";
import { StateBadge, absoluteTime } from "./shared";

interface EndpointPanelProps {
  /** Owner/Admin. A Member never reaches the endpoint query at all — see
   *  `permitted` in the parent, which gates `enabled` on the query itself. */
  permitted: boolean;
  configured: boolean;
  endpoint: FeishuEndpointHealth | null;
  loading: boolean;
  refreshFailed: boolean;
  workspaceId: string;
}

export function EndpointPanel(props: EndpointPanelProps) {
  const { t } = useT("settings");
  const timeAgo = useTimeAgo();
  const check = useCheckFeishuEndpoint(props.workspaceId);
  const state = deriveEndpointState({
    permitted: props.permitted,
    configured: props.configured,
    endpoint: props.endpoint,
    loading: props.loading,
    refreshFailed: props.refreshFailed,
  });
  const endpoint = props.endpoint;
  const checkedAt = endpoint?.checkedAt ?? null;
  const relative = checkedAt ? timeAgo(checkedAt) : t(($) => $.feishu.endpoint.never);

  const summary: Record<FeishuEndpointState, string> = {
    not_configured: t(($) => $.feishu.endpoint.message_not_configured),
    checking: t(($) => $.feishu.endpoint.message_checking),
    ready: t(($) => $.feishu.endpoint.message_ready, { time: relative }),
    unreachable: t(($) => $.feishu.endpoint.message_unreachable, {
      errorCode: endpoint?.errorCode ?? t(($) => $.feishu.endpoint.unknown),
    }),
    stale: t(($) => $.feishu.endpoint.message_stale, { time: relative }),
    forbidden: t(($) => $.feishu.endpoint.message_forbidden),
  };
  const badgeLabel: Record<FeishuEndpointState, string> = {
    not_configured: t(($) => $.feishu.endpoint.status_not_configured),
    checking: t(($) => $.feishu.endpoint.status_checking),
    ready: t(($) => $.feishu.endpoint.status_ready),
    unreachable: t(($) => $.feishu.endpoint.status_unreachable),
    stale: t(($) => $.feishu.endpoint.status_stale),
    forbidden: t(($) => $.feishu.endpoint.status_forbidden),
  };

  const canCheck = state !== "forbidden" && state !== "not_configured" && endpoint !== null;
  const handleCheck = () => {
    if (!endpoint) return;
    check.mutate(endpoint.name, {
      onSuccess: () => toast.success(t(($) => $.feishu.endpoint.checked)),
      onError: () => toast.error(t(($) => $.feishu.endpoint.check_failed)),
    });
  };

  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t(($) => $.feishu.endpoint.title)}</h3>
      <Card>
        <CardHeader className="gap-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
            <StateBadge tone={feishuEndpointStateTone(state)} label={badgeLabel[state]} />
            <span className="text-muted-foreground font-normal" aria-live="polite">
              {summary[state]}
            </span>
          </CardTitle>
          {canCheck && (
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-9"
                onClick={handleCheck}
                disabled={check.isPending || props.loading}
              >
                <RefreshCw className={cn("size-4", check.isPending && "animate-spin")} aria-hidden />
                {check.isPending
                  ? t(($) => $.feishu.endpoint.checking)
                  : t(($) => $.feishu.endpoint.recheck)}
              </Button>
            </CardAction>
          )}
        </CardHeader>
        {state !== "forbidden" && (
          <CardContent>
            {props.loading && !endpoint
              ? <Skeleton className="h-16 w-full" />
              : (
                <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                  <Detail label={t(($) => $.feishu.endpoint.field_name)} value={endpoint?.name ?? "—"} mono />
                  <Detail
                    label={t(($) => $.feishu.endpoint.field_checked_at)}
                    value={relative}
                    title={absoluteTime(checkedAt)}
                  />
                  <Detail
                    label={t(($) => $.feishu.endpoint.field_version)}
                    value={endpoint?.version ?? "—"}
                  />
                  <Detail
                    label={t(($) => $.feishu.endpoint.field_latency)}
                    value={endpoint?.latencyMs === null || endpoint === null
                      ? "—"
                      : t(($) => $.feishu.endpoint.latency_value, { ms: endpoint.latencyMs })}
                  />
                  <Detail
                    label={t(($) => $.feishu.endpoint.field_error)}
                    value={endpoint?.errorCode ?? "—"}
                    mono
                  />
                  <Detail
                    label={t(($) => $.feishu.endpoint.field_sources)}
                    value={String(endpoint?.sourceCount ?? 0)}
                  />
                </dl>
              )}
          </CardContent>
        )}
      </Card>
    </section>
  );
}

function Detail({ label, value, title, mono }: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono === true && "font-mono")} title={title ?? value}>{value}</dd>
    </div>
  );
}
