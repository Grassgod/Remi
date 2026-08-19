"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Archive, Check, HardDrive, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import {
  sessionArchiveKeys,
  workspaceSessionArchiveStatusOptions,
} from "@multiremi/core/session-archives";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { Alert, AlertDescription, AlertTitle } from "@multiremi/ui/components/ui/alert";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { useT } from "../../i18n";

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MAX_WORKSPACE_TTL_HOURS = 365 * 24;

export interface SessionArchiveTiming {
  workspaceTtlHours: number;
  gcIntervalMinutes: number;
}

export type SessionArchiveTimingError =
  | "ttl_required"
  | "ttl_min"
  | "ttl_max"
  | "interval_required"
  | "interval_min"
  | "interval_gt_ttl"
  | null;

export function validateSessionArchiveTiming(
  value: SessionArchiveTiming,
): SessionArchiveTimingError {
  if (!Number.isInteger(value.workspaceTtlHours)) return "ttl_required";
  if (value.workspaceTtlHours < 1) return "ttl_min";
  if (value.workspaceTtlHours > MAX_WORKSPACE_TTL_HOURS) return "ttl_max";
  if (!Number.isInteger(value.gcIntervalMinutes)) return "interval_required";
  if (value.gcIntervalMinutes < 1) return "interval_min";
  if (value.gcIntervalMinutes > value.workspaceTtlHours * 60) {
    return "interval_gt_ttl";
  }
  return null;
}

export function StorageCleanupTab() {
  const { t } = useT("settings");
  const wsId = useWorkspaceId();
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const [ttlHours, setTtlHours] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("");
  const [saving, setSaving] = useState(false);

  const {
    data: members = [],
    isPending: membersPending,
    isError: membersError,
    refetch: refetchMembers,
  } = useQuery(memberListOptions(wsId));
  const currentMember = members.find((member) => member.user_id === user?.id) ?? null;
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";

  const statusQuery = useQuery({
    ...workspaceSessionArchiveStatusOptions(wsId),
    enabled: Boolean(wsId) && canManage,
  });
  const status = statusQuery.data;

  useEffect(() => {
    const ttl = status?.config.workspace_ttl_ms;
    const interval = status?.config.gc_interval_ms;
    setTtlHours(ttl === null || ttl === undefined ? "" : String(ttl / HOUR_MS));
    setIntervalMinutes(
      interval === null || interval === undefined ? "" : String(interval / MINUTE_MS),
    );
  }, [status?.config.gc_interval_ms, status?.config.workspace_ttl_ms]);

  const timing = useMemo(
    () => ({
      workspaceTtlHours: Number(ttlHours),
      gcIntervalMinutes: Number(intervalMinutes),
    }),
    [intervalMinutes, ttlHours],
  );
  const timingError =
    ttlHours.trim() === ""
      ? "ttl_required"
      : intervalMinutes.trim() === ""
        ? "interval_required"
        : validateSessionArchiveTiming(timing);

  const initialTtl = status?.config.workspace_ttl_ms;
  const initialInterval = status?.config.gc_interval_ms;
  const changed =
    initialTtl !== null &&
    initialTtl !== undefined &&
    initialInterval !== null &&
    initialInterval !== undefined &&
    (timing.workspaceTtlHours * HOUR_MS !== initialTtl ||
      timing.gcIntervalMinutes * MINUTE_MS !== initialInterval);

  async function save() {
    if (!canManage || timingError || !changed) return;
    setSaving(true);
    try {
      const updated = await api.updateWorkspaceSessionArchiveConfig(wsId, {
        workspace_ttl_ms: timing.workspaceTtlHours * HOUR_MS,
        gc_interval_ms: timing.gcIntervalMinutes * MINUTE_MS,
      });
      queryClient.setQueryData(sessionArchiveKeys.workspaceStatus(wsId), updated);
      toast.success(t(($) => $.storageCleanup.saved));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(($) => $.storageCleanup.save_failed),
      );
    } finally {
      setSaving(false);
    }
  }

  if (membersPending) return <StorageCleanupSkeleton />;
  if (membersError) {
    return (
      <div role="alert" className="space-y-3 py-8 text-center">
        <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
        <p className="text-sm font-medium">{t(($) => $.storageCleanup.load_failed)}</p>
        <Button variant="outline" size="sm" onClick={() => void refetchMembers()}>
          {t(($) => $.storageCleanup.retry_load)}
        </Button>
      </div>
    );
  }
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        {t(($) => $.storageCleanup.insufficient)}
      </p>
    );
  }
  if (statusQuery.isPending) return <StorageCleanupSkeleton />;
  if (statusQuery.isError || !status) {
    return (
      <div role="alert" className="space-y-3 py-8 text-center">
        <AlertCircle className="mx-auto h-6 w-6 text-destructive" />
        <p className="text-sm font-medium">{t(($) => $.storageCleanup.load_failed)}</p>
        <Button variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
          {t(($) => $.storageCleanup.retry_load)}
        </Button>
      </div>
    );
  }

  const errorMessage = timingError
    ? t(($) => $.storageCleanup.validation[timingError])
    : null;

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Archive className="h-4 w-4 text-muted-foreground" />
          {t(($) => $.page.tabs.storage_cleanup)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(($) => $.storageCleanup.description)}
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t(($) => $.storageCleanup.storage_title)}</h3>
        <Card>
          <CardContent className="divide-y p-0">
            <ReadOnlyRow
              label={t(($) => $.storageCleanup.backend)}
              value={formatBackend(status.config.backend, t(($) => $.storageCleanup.local_disk), t(($) => $.storageCleanup.unknown))}
              icon={<HardDrive className="h-4 w-4" />}
            />
            <ReadOnlyRow
              label={t(($) => $.storageCleanup.root_hint)}
              value={status.config.root_hint || t(($) => $.storageCleanup.unknown)}
              monospace
            />
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="text-sm text-muted-foreground">
                {t(($) => $.storageCleanup.archive_gate)}
              </span>
              {status.config.require_archive === true ? (
                <Badge variant="secondary" className="gap-1">
                  <Check className="h-3 w-3" />
                  {t(($) => $.storageCleanup.required)}
                </Badge>
              ) : (
                <Badge variant="outline">{t(($) => $.storageCleanup.unknown)}</Badge>
              )}
            </div>
            <ReadOnlyRow
              label={t(($) => $.storageCleanup.max_archive_size)}
              value={formatBytes(status.config.max_bytes, t(($) => $.storageCleanup.unknown))}
            />
            <ReadOnlyRow
              label={t(($) => $.storageCleanup.min_free_space)}
              value={formatBytes(status.config.min_free_bytes, t(($) => $.storageCleanup.unknown))}
            />
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t(($) => $.storageCleanup.usage_title)}</h3>
        <Card>
          <CardContent className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3">
            <Metric label={t(($) => $.storageCleanup.total)} value={status.usage.total_archives} />
            <Metric label={t(($) => $.storageCleanup.ready)} value={status.usage.ready_archives} />
            <Metric label={t(($) => $.storageCleanup.pending)} value={status.usage.pending_archives} />
            <Metric label={t(($) => $.storageCleanup.failed)} value={status.usage.failed_archives} />
            <Metric
              label={t(($) => $.storageCleanup.space_used)}
              value={formatBytes(status.usage.total_bytes, "0 B")}
            />
          </CardContent>
        </Card>
        {status.last_failure && (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>{t(($) => $.storageCleanup.last_failure)}</AlertTitle>
            <AlertDescription>
              <span className="block break-words">{status.last_failure.error}</span>
              <span className="mt-1 block text-xs">
                {status.last_failure.issue_key || status.last_failure.issue_id} · {formatTimestamp(status.last_failure.updated_at)}
              </span>
            </AlertDescription>
          </Alert>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t(($) => $.storageCleanup.cleanup_title)}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(($) => $.storageCleanup.cleanup_description)}
          </p>
        </div>
        <Card>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="workspace-ttl-hours">
                  {t(($) => $.storageCleanup.workspace_ttl)}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="workspace-ttl-hours"
                    type="number"
                    min={1}
                    max={MAX_WORKSPACE_TTL_HOURS}
                    step={1}
                    inputMode="numeric"
                    value={ttlHours}
                    onChange={(event) => setTtlHours(event.target.value)}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {t(($) => $.storageCleanup.hours)}
                  </span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gc-interval-minutes">
                  {t(($) => $.storageCleanup.gc_interval)}
                </Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="gc-interval-minutes"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={intervalMinutes}
                    onChange={(event) => setIntervalMinutes(event.target.value)}
                  />
                  <span className="shrink-0 text-sm text-muted-foreground">
                    {t(($) => $.storageCleanup.minutes)}
                  </span>
                </div>
              </div>
            </div>
            {errorMessage && (
              <p role="alert" className="text-xs text-destructive">{errorMessage}</p>
            )}
            <div className="flex justify-end">
              <Button onClick={() => void save()} disabled={saving || Boolean(timingError) || !changed}>
                <Save className="h-4 w-4" />
                {saving
                  ? t(($) => $.storageCleanup.saving)
                  : t(($) => $.storageCleanup.save)}
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function ReadOnlyRow({
  label,
  value,
  icon,
  monospace = false,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  monospace?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`flex min-w-0 items-center gap-2 text-right text-sm ${monospace ? "font-mono" : ""}`}>
        {icon}
        <span className="truncate">{value}</span>
      </span>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function StorageCleanupSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" data-testid="storage-cleanup-skeleton">
      <Skeleton className="h-5 w-44" />
      <Skeleton className="h-48 w-full" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-44 w-full" />
    </div>
  );
}

function formatBackend(backend: string, localLabel: string, unknownLabel: string): string {
  if (backend === "local") return localLabel;
  return backend || unknownLabel;
}

function formatBytes(value: number | null, unknown: string): string {
  if (value === null || !Number.isFinite(value) || value < 0) return unknown;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = value;
  let unit = "B";
  for (const nextUnit of units) {
    scaled /= 1024;
    unit = nextUnit;
    if (scaled < 1024) break;
  }
  return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${unit}`;
}

function formatTimestamp(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
