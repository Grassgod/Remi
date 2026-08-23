"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Server,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@multiremi/ui/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { Switch } from "@multiremi/ui/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import {
  platformStatusOptions,
  useCancelPlatformOperation,
  useCreatePlatformOperation,
  useUpdatePlatformSettings,
  type PlatformOperation,
  type PlatformRelease,
} from "@multiremi/core/platform-lifecycle";
import { useT } from "../../i18n";

type ConfirmAction =
  | { kind: "restart" }
  | { kind: "update"; release: PlatformRelease }
  | { kind: "rollback"; release: PlatformRelease };

const CANCELLABLE_STATUSES = new Set(["queued", "preparing", "pulling", "draining"]);
const RECENT_OPERATION_WINDOW_MS = 30 * 60_000;

export function PlatformTab() {
  const { t } = useT("settings");
  const statusQuery = useQuery(platformStatusOptions());
  const operationMutation = useCreatePlatformOperation();
  const cancelMutation = useCancelPlatformOperation();
  const settingsMutation = useUpdatePlatformSettings();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const status = statusQuery.data;
  const active = status?.activeOperation;
  const busy = Boolean(active) || operationMutation.isPending || cancelMutation.isPending;

  async function runAction(action: ConfirmAction | { kind: "check_updates" }) {
    try {
      await operationMutation.mutateAsync({
        kind: action.kind,
        targetVersion: "release" in action ? action.release.version : null,
        targetRef: "release" in action
          ? action.kind === "update"
            ? action.release.manifestUrl ?? action.release.ref
            : action.release.ref
          : null,
      });
      toast.success(t(($) => $.platform.operation_queued));
      setConfirmAction(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.platform.operation_failed));
    }
  }

  async function cancelOperation(operationId: string) {
    try {
      await cancelMutation.mutateAsync(operationId);
      toast.success(t(($) => $.platform.cancel_requested));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.platform.operation_failed));
    }
  }

  if (statusQuery.isPending) {
    return <div className="h-64 animate-pulse rounded-lg bg-muted" />;
  }
  if (!status) {
    return (
      <div role="alert" className="py-16 text-center text-sm text-muted-foreground">
        <CircleAlert className="mx-auto mb-3 h-6 w-6" />
        {t(($) => $.platform.load_failed)}
      </div>
    );
  }

  const currentVersion = status.currentRelease?.version || t(($) => $.platform.unknown_version);
  const progressLines = active ? operationProgressLines(active, t) : [];
  const recentResult = !active ? recentOperationResult(status.lastOperation, t) : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">{t(($) => $.platform.title)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t(($) => $.platform.subtitle)}</p>
      </div>

      {statusQuery.isRefetchError && (
        <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100">
          <RefreshCw className="h-4 w-4 animate-spin" />
          {t(($) => $.platform.reconnecting)}
        </div>
      )}

      {active && (
        <div data-testid="platform-operation-status" data-state="active" className="flex flex-col items-stretch gap-3 rounded-md border bg-muted/40 px-3 py-3 sm:flex-row sm:items-start">
          <RefreshCw className="mt-0.5 h-4 w-4 animate-spin" />
          <div className="min-w-0 flex-1 space-y-1">
            {progressLines.map((line, index) => (
              <p key={line} className={index === 0 ? "text-sm font-medium" : "text-xs text-muted-foreground"}>
                {line}
              </p>
            ))}
          </div>
          {CANCELLABLE_STATUSES.has(active.status) && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 self-start"
              disabled={cancelMutation.isPending}
              onClick={() => void cancelOperation(active.id)}
            >
              <X />
              {t(($) => $.platform.cancel_upgrade)}
            </Button>
          )}
        </div>
      )}

      {recentResult && (
        <div
          data-testid="platform-operation-status"
          data-state={recentResult.kind}
          className={recentResult.kind === "timeout"
            ? "flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-destructive"
            : "flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-3"}
        >
          {recentResult.kind === "timeout"
            ? <CircleAlert className="h-4 w-4" />
            : <Check className="h-4 w-4" />}
          <p className="text-sm font-medium">{recentResult.message}</p>
        </div>
      )}

      <Card className="rounded-lg">
        <CardHeader className="border-b">
          <CardTitle>{t(($) => $.platform.current_version)}</CardTitle>
          <CardDescription>{driverLabel(status.driver, t)}</CardDescription>
          <CardAction>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label={t(($) => $.platform.check_updates)}
              title={t(($) => $.platform.check_updates)}
              onClick={() => void runAction({ kind: "check_updates" })}
            >
              <RefreshCw className={operationMutation.isPending ? "animate-spin" : ""} />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="py-3 text-center">
            <div className="flex items-center justify-center gap-3">
              <span className="text-4xl font-semibold tracking-normal">{currentVersion}</span>
              {status.updateAvailable ? (
                <Badge variant="secondary">{t(($) => $.platform.update_available)}</Badge>
              ) : (
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                  <Check className="h-4 w-4" />
                </span>
              )}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {status.updateAvailable
                ? t(($) => $.platform.latest_version, { version: status.latestRelease?.version ?? "" })
                : t(($) => $.platform.up_to_date)}
            </p>
            {status.currentRelease?.releaseUrl && (
              <a className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" href={status.currentRelease.releaseUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" />
                {t(($) => $.platform.view_release)}
              </a>
            )}
          </div>

          <div className="flex flex-wrap justify-center gap-2 border-t pt-4">
            {status.updateAvailable && status.latestRelease && (
              <Button disabled={busy || status.updaterStatus === "offline"} onClick={() => setConfirmAction({ kind: "update", release: status.latestRelease! })}>
                {t(($) => $.platform.update_now)}
              </Button>
            )}
            <Button variant="outline" disabled={busy || status.updaterStatus === "offline"} onClick={() => setConfirmAction({ kind: "restart" })}>
              <RefreshCw />
              {t(($) => $.platform.restart)}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <div>
              <p className="text-sm font-medium">{t(($) => $.platform.auto_update)}</p>
              <p className="text-xs text-muted-foreground">{t(($) => $.platform.auto_update_hint)}</p>
            </div>
            <Switch
              checked={status.autoUpdateStable}
              disabled={settingsMutation.isPending}
              onCheckedChange={(checked) => settingsMutation.mutate(checked, {
                onError: () => toast.error(t(($) => $.platform.operation_failed)),
              })}
              aria-label={t(($) => $.platform.auto_update)}
            />
          </div>

          <Collapsible>
            <CollapsibleTrigger className="flex w-full items-center justify-between border-t pt-4 text-sm font-medium">
              <span className="inline-flex items-center gap-2"><RotateCcw className="h-4 w-4" />{t(($) => $.platform.rollback)}</span>
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <div className="divide-y rounded-md border">
                {status.recentReleases.filter((release) => release.ref !== status.currentRelease?.ref).slice(0, 3).map((release) => (
                  <div key={`${release.version}-${release.ref}`} className="flex items-center justify-between gap-3 px-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{release.version}</p>
                      <p className="truncate text-xs text-muted-foreground">{release.ref}</p>
                    </div>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmAction({ kind: "rollback", release })}>
                      {t(($) => $.platform.rollback_action)}
                    </Button>
                  </div>
                ))}
                {status.recentReleases.length <= 1 && <p className="px-3 py-5 text-center text-sm text-muted-foreground">{t(($) => $.platform.no_rollback)}</p>}
              </div>
            </CollapsibleContent>
          </Collapsible>
        </CardContent>
      </Card>

      <Card className="rounded-lg">
        <CardHeader className="border-b">
          <CardTitle>{t(($) => $.platform.services)}</CardTitle>
          <CardDescription>{t(($) => $.platform.updater_status, { status: updaterLabel(status.updaterStatus, t) })}</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {status.services.map((service) => (
            <div key={service.id} className="flex min-h-14 items-center gap-3 py-3">
              <Server className="h-4 w-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{service.name}</p>
                {service.detail && <p className="truncate text-xs text-muted-foreground">{service.detail}</p>}
              </div>
              <ServiceBadge status={service.status} t={t} />
            </div>
          ))}
        </CardContent>
      </Card>

      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmTitle(confirmAction, t)}</AlertDialogTitle>
            <AlertDialogDescription>{confirmDescription(confirmAction, t)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.platform.cancel)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmAction && void runAction(confirmAction)}>
              {t(($) => $.platform.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ServiceBadge({ status, t }: { status: string; t: Translate }) {
  const variant = status === "ready" ? "secondary" : status === "degraded" ? "outline" : "destructive";
  const label = status === "ready"
    ? t(($) => $.platform.service_ready)
    : status === "degraded"
      ? t(($) => $.platform.service_degraded)
      : status === "stopped"
        ? t(($) => $.platform.service_stopped)
        : t(($) => $.platform.service_unknown);
  return <Badge variant={variant}>{label}</Badge>;
}

type Translate = ReturnType<typeof useT<"settings">>["t"];
function operationLabel(kind: string, t: Translate) { return kind === "restart" ? t(($) => $.platform.restart) : kind === "rollback" ? t(($) => $.platform.rollback) : kind === "update" ? t(($) => $.platform.update_now) : t(($) => $.platform.check_updates); }
function operationProgressLines(operation: PlatformOperation, t: Translate): string[] {
  switch (operation.status) {
    case "queued":
    case "preparing":
      return [t(($) => $.platform.status_preparing)];
    case "pulling":
      return [t(($) => $.platform.status_pulling)];
    case "draining": {
      const drain = operation.progress.drain;
      const activeTasks = drain?.active_tasks ?? 0;
      const lines = [t(($) => $.platform.status_pausing_tasks, {
        acked: drain?.acked_daemons ?? 0,
        online: drain?.online_daemons ?? 0,
      })];
      if (activeTasks > 0) {
        lines.push(t(($) => $.platform.status_waiting_tasks, {
          count: activeTasks,
          minutes: Math.ceil(Math.max(0, drain?.waited_ms ?? 0) / 60_000),
        }));
      }
      return lines;
    }
    case "switching":
      return [t(($) => $.platform.status_switching)];
    case "verifying":
      return [t(($) => $.platform.status_verifying)];
    case "restarting":
      return [t(($) => $.platform.status_restarting)];
    case "rolling_back":
      return [t(($) => $.platform.status_rolling_back)];
    default:
      return [operation.progress.message || operationLabel(operation.kind, t)];
  }
}

function recentOperationResult(
  operation: PlatformOperation | null,
  t: Translate,
): { kind: "restored" | "timeout" | "cancelled"; message: string } | null {
  if (!operation?.finishedAt) return null;
  const finishedAt = Date.parse(operation.finishedAt);
  if (!Number.isFinite(finishedAt) || finishedAt < Date.now() - RECENT_OPERATION_WINDOW_MS) return null;

  if (operation.status === "succeeded") {
    return { kind: "restored", message: t(($) => $.platform.status_scheduling_restored) };
  }
  if (operation.status === "cancelled") {
    return { kind: "cancelled", message: t(($) => $.platform.status_upgrade_cancelled) };
  }
  const drainTimedOut = operation.progress.drain?.state === "timeout"
    || /drain(?:ing)?[\s_-]+time(?:d[\s_-]+)?out/i.test(operation.error ?? "");
  if (operation.status === "failed" && drainTimedOut) {
    return { kind: "timeout", message: t(($) => $.platform.status_drain_timeout) };
  }
  return null;
}
function driverLabel(driver: string, t: Translate) { return driver === "docker_compose" ? t(($) => $.platform.driver_compose) : t(($) => $.platform.driver_systemd); }
function updaterLabel(status: string, t: Translate) { return status === "ready" ? t(($) => $.platform.updater_ready) : status === "stale" ? t(($) => $.platform.updater_stale) : t(($) => $.platform.updater_offline); }
function confirmTitle(action: ConfirmAction | null, t: Translate) { return action?.kind === "restart" ? t(($) => $.platform.confirm_restart_title) : action?.kind === "rollback" ? t(($) => $.platform.confirm_rollback_title) : t(($) => $.platform.confirm_update_title); }
function confirmDescription(action: ConfirmAction | null, t: Translate) { return action?.kind === "restart" ? t(($) => $.platform.confirm_restart_desc) : action?.kind === "rollback" ? t(($) => $.platform.confirm_rollback_desc, { version: action.release.version }) : t(($) => $.platform.confirm_update_desc, { version: action && "release" in action ? action.release.version : "" }); }
