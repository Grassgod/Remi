"use client";

import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Download,
  Loader2,
  RefreshCw,
  Settings2,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import type {
  AgentPluginRuntimeState,
  AgentPluginRuntimeStatus,
} from "@multiremi/core/plugins";
import { useRetryAgentPluginRuntime } from "@multiremi/core/plugins";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button, buttonVariants } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { cn } from "@multiremi/ui/lib/utils";
import { AppLink } from "../../navigation";
import { useT } from "../../i18n";

export type DisplayPluginRuntimeStatus =
  AgentPluginRuntimeStatus | "daemon_upgrade_required" | "offline" | "unknown";

const STATUS_CONFIG: Record<
  DisplayPluginRuntimeStatus,
  { icon: typeof CheckCircle2; className: string; busy?: boolean }
> = {
  pending: {
    icon: Loader2,
    className: "text-muted-foreground bg-muted",
    busy: true,
  },
  preflight: {
    icon: Loader2,
    className: "text-brand bg-brand/10",
    busy: true,
  },
  downloading: { icon: Download, className: "text-brand bg-brand/10" },
  verifying: {
    icon: Loader2,
    className: "text-brand bg-brand/10",
    busy: true,
  },
  installing: {
    icon: Loader2,
    className: "text-brand bg-brand/10",
    busy: true,
  },
  ready: { icon: CheckCircle2, className: "text-success bg-success/10" },
  retry_scheduled: {
    icon: Clock3,
    className: "text-warning bg-warning/10",
  },
  setup_required: { icon: Settings2, className: "text-warning bg-warning/10" },
  daemon_upgrade_required: {
    icon: ArrowUpRight,
    className: "text-warning bg-warning/10",
  },
  blocked: {
    icon: AlertCircle,
    className: "text-destructive bg-destructive/10",
  },
  offline: { icon: WifiOff, className: "text-muted-foreground bg-muted" },
  unknown: { icon: CircleHelp, className: "text-muted-foreground bg-muted" },
};

function effectiveStatus(
  state: AgentPluginRuntimeState,
): DisplayPluginRuntimeStatus {
  if (state.runtime?.status === "offline") return "offline";
  if (
    state.status === "setup_required" &&
    state.lastErrorCode === "daemon_upgrade_required"
  ) {
    return "daemon_upgrade_required";
  }
  return state.status in STATUS_CONFIG ? state.status : "unknown";
}

function canRetry(state: AgentPluginRuntimeState): boolean {
  const status = effectiveStatus(state);
  return (
    status === "blocked" ||
    status === "setup_required" ||
    status === "retry_scheduled"
  );
}

function runtimeCliVersion(state: AgentPluginRuntimeState): string | null {
  const version = state.runtime?.metadata?.cli_version;
  return typeof version === "string" && version.trim() ? version.trim() : null;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function PluginStatusBadge({
  status,
}: {
  status: DisplayPluginRuntimeStatus;
}) {
  const { t } = useT("plugins");
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.unknown;
  const Icon = config.icon;
  return (
    <Badge
      variant="outline"
      className={cn("border-transparent font-normal", config.className)}
    >
      <Icon className={cn(config.busy && "animate-spin")} />
      {t(($) => $.readiness.statuses[status])}
    </Badge>
  );
}

export function PluginReadinessList({
  pluginId,
  states,
  isLoading = false,
  error = null,
  compact = false,
  allowRetry = true,
  linkRuntime = true,
}: {
  pluginId: string;
  states: AgentPluginRuntimeState[];
  isLoading?: boolean;
  error?: Error | null;
  compact?: boolean;
  allowRetry?: boolean;
  linkRuntime?: boolean;
}) {
  const { t } = useT("plugins");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const retry = useRetryAgentPluginRuntime(wsId, pluginId);

  const handleRetry = async (runtimeId: string, versionId: string) => {
    try {
      await retry.mutateAsync({ runtimeId, versionId });
      toast.success(t(($) => $.readiness.retry_success));
    } catch (cause) {
      toast.error(
        cause instanceof Error && cause.message
          ? cause.message
          : t(($) => $.readiness.retry_failed),
      );
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-2" aria-label={t(($) => $.readiness.loading)}>
        <Skeleton className={cn("h-9 w-full", compact && "h-7")} />
        {!compact && <Skeleton className="h-9 w-full" />}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span>{t(($) => $.readiness.load_error)}</span>
      </div>
    );
  }

  if (states.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(($) => $.readiness.empty)}
      </p>
    );
  }

  return (
    <ul className={cn("divide-y", !compact && "rounded-md border")}>
      {states.map((state) => {
        const status = effectiveStatus(state);
        const requiresDaemonUpgrade = status === "daemon_upgrade_required";
        const runtimeName = state.runtime?.name || state.runtimeId;
        const runtimeVersion = state.version?.version || state.pluginVersionId;
        let detail = state.lastError || state.lastErrorCode;
        if (requiresDaemonUpgrade) {
          detail = t(($) => $.readiness.daemon_upgrade_description);
        } else if (state.lastErrorCode === "daemon_plugin_reconcile_timeout") {
          detail = t(($) => $.readiness.daemon_reconcile_timeout_description);
        }
        const cliVersion = runtimeCliVersion(state);
        const isCurrentRetry =
          retry.isPending &&
          retry.variables?.runtimeId === state.runtimeId &&
          retry.variables?.versionId === state.pluginVersionId;
        return (
          <li
            key={state.id || `${state.runtimeId}-${state.pluginVersionId}`}
            className={cn(
              "flex min-w-0 items-start gap-3",
              compact ? "py-2" : "px-3 py-3",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {linkRuntime ? (
                  <AppLink
                    href={paths.runtimeDetail(state.runtimeId)}
                    className="truncate text-xs font-medium hover:underline"
                  >
                    {runtimeName}
                  </AppLink>
                ) : (
                  <span className="truncate text-xs font-medium">
                    {runtimeName}
                  </span>
                )}
                <PluginStatusBadge status={status} />
                <span className="font-mono text-[11px] text-muted-foreground">
                  {t(($) => $.readiness.version, {
                    version: runtimeVersion,
                  })}
                </span>
                {state.retryCount > 0 && (
                  <span className="font-mono text-[11px] text-muted-foreground">
                    #{state.retryCount}
                  </span>
                )}
              </div>
              {detail && (
                <p
                  className={cn(
                    "mt-1 break-words text-xs",
                    requiresDaemonUpgrade ? "text-warning" : "text-destructive",
                  )}
                >
                  {!requiresDaemonUpgrade && (
                    <>{t(($) => $.readiness.last_error)}: </>
                  )}
                  {detail}
                </p>
              )}
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                {requiresDaemonUpgrade && cliVersion && (
                  <span>
                    {t(($) => $.readiness.daemon_cli_version, {
                      version: cliVersion,
                    })}
                  </span>
                )}
                {state.nextRetryAt && (
                  <span>
                    {t(($) => $.readiness.next_retry, {
                      when: formatDateTime(state.nextRetryAt),
                    })}
                  </span>
                )}
                {state.lastAttemptAt && (
                  <span>
                    {t(($) => $.readiness.last_attempt, {
                      when: formatDateTime(state.lastAttemptAt),
                    })}
                  </span>
                )}
              </div>
            </div>
            {requiresDaemonUpgrade && allowRetry && (
              <AppLink
                href={paths.runtimeDetail(state.runtimeId)}
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                <ArrowUpRight />
                {t(($) => $.readiness.upgrade_daemon_action)}
              </AppLink>
            )}
            {allowRetry && canRetry(state) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0"
                disabled={retry.isPending}
                onClick={() =>
                  void handleRetry(state.runtimeId, state.pluginVersionId)
                }
              >
                {isCurrentRetry ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                {isCurrentRetry
                  ? t(($) => $.readiness.retrying_action)
                  : t(($) => $.readiness.retry_action)}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
