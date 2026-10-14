"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, Eye, HardDrive, Loader2, Recycle } from "lucide-react";
import { toast } from "sonner";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { runtimeListOptions } from "@multiremi/core/runtimes/queries";
import {
  useRuntimeGcRun,
  workspaceStorageDaemonsOptions,
  type GcRunMode,
  type StoragePlanItem,
  type StorageReport,
  type WorkspaceStorageDaemon,
} from "@multiremi/core/storage";
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
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multiremi/ui/components/ui/table";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import { formatBytes } from "../utils";

const BYTE_CATEGORIES = ["work", "env", "traces", "shared", "legacy"] as const;
const SUBJECT_COUNTS = ["total", "active", "ended", "reclaimed"] as const;
const RETAIN_REASONS = [
  "running",
  "pinned",
  "not_ended",
  "within_ttl",
  "external_dir",
  "snapshot_failed",
  "git_check_failed",
  "server_unreachable",
  "legacy_retained",
  "error",
] as const;
const PLAN_REASONS = [...RETAIN_REASONS, "ended_ttl", "over_cap", "orphan"] as const;
const PLAN_ACTIONS = ["reclaim", "forget", "keep"] as const;
const SUBJECT_KINDS = ["issue", "chat", "task"] as const;
const REPORT_MODES = ["periodic", "dry_run", "run"] as const;
// A report on a busy machine can list thousands of subjects; the table shows
// the items that matter most and says how many it left out.
const PLAN_ROW_LIMIT = 100;

function isOneOf<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function newestReport(...reports: Array<StorageReport | null | undefined>): StorageReport | null {
  let newest: StorageReport | null = null;
  for (const report of reports) {
    if (report && (!newest || report.generated_at > newest.generated_at)) newest = report;
  }
  return newest;
}

function orderedPlan(plan: StoragePlanItem[]): StoragePlanItem[] {
  return [...plan].sort(
    (a, b) =>
      Number(a.action === "keep") - Number(b.action === "keep") ||
      (b.bytes ?? -1) - (a.bytes ?? -1),
  );
}

/** Storage card for one machine's daemon: disk usage, retention state and the dry-run / reclaim actions. */
export function DaemonStorageCard({
  daemon,
  canManage,
  preferredRuntimeId,
}: {
  daemon: WorkspaceStorageDaemon;
  canManage: boolean;
  /** The runtime the person is looking at, used for the run when it is online. */
  preferredRuntimeId?: string;
}) {
  const { t } = useT("runtimes");
  const timeAgo = useTimeAgo();
  const wsId = useWorkspaceId();
  const run = useRuntimeGcRun(wsId);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // A run is addressed to one runtime and the server refuses offline ones,
  // while the machine counts as online when any of its runtimes is.
  const runtimes = useQuery(runtimeListOptions(wsId));
  const onlineRuntimeIds = new Set(
    (runtimes.data ?? []).filter((runtime) => runtime.status === "online").map((runtime) => runtime.id),
  );
  const runtimeId =
    [preferredRuntimeId, ...daemon.runtime_ids].find(
      (id): id is string => id !== undefined && onlineRuntimeIds.has(id),
    ) ?? null;
  const report = newestReport(run.data?.report, daemon.report);
  const runningMode: GcRunMode | null = run.isPending ? run.variables.mode : null;
  const canRun = canManage && daemon.online && runtimeId !== null && !run.isPending;
  const name = daemon.name || daemon.daemon_id;

  function start(mode: GcRunMode) {
    if (!runtimeId) return;
    run.mutate(
      { runtimeId, mode },
      {
        onError: (error) =>
          toast.error(error instanceof Error ? error.message : t(($) => $.storage.run_failed)),
      },
    );
  }

  return (
    <section
      aria-label={t(($) => $.storage.card_aria, { name })}
      className="min-w-0 rounded-lg border"
    >
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <HardDrive className="size-4 shrink-0 text-muted-foreground" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{name}</h3>
        <Badge variant={daemon.online ? "secondary" : "outline"}>
          {daemon.online ? t(($) => $.storage.online) : t(($) => $.storage.offline)}
        </Badge>
        {daemon.reported_at && (
          <span className="text-xs text-muted-foreground">
            {t(($) => $.storage.reported_at, { time: timeAgo(daemon.reported_at) })}
          </span>
        )}
      </div>

      <div className="space-y-5 p-4">
        {report ? <ReportSummary report={report} /> : (
          <p className="text-sm text-muted-foreground">{t(($) => $.storage.no_report)}</p>
        )}

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canRun}
              onClick={() => start("dry_run")}
            >
              {runningMode === "dry_run" ? <Loader2 className="animate-spin" /> : <Eye />}
              {runningMode === "dry_run"
                ? t(($) => $.storage.running_dry_run)
                : t(($) => $.storage.dry_run)}
            </Button>
            <Button size="sm" disabled={!canRun} onClick={() => setConfirmOpen(true)}>
              {runningMode === "run" ? <Loader2 className="animate-spin" /> : <Recycle />}
              {runningMode === "run"
                ? t(($) => $.storage.running_reclaim)
                : t(($) => $.storage.reclaim_now)}
            </Button>
            {!daemon.online && (
              <span className="text-xs text-muted-foreground">{t(($) => $.storage.offline_hint)}</span>
            )}
          </div>
        )}

        {report && report.plan.length > 0 && <PlanTable report={report} />}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.storage.reclaim_confirm_title, { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.storage.reclaim_confirm_description)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t(($) => $.storage.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                start("run");
              }}
            >
              {t(($) => $.storage.reclaim_now)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function ReportSummary({ report }: { report: StorageReport }) {
  const { t } = useT("runtimes");
  const timeAgo = useTimeAgo();
  const retained = Object.entries(report.retained).filter(([, count]) => count > 0);

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          {t(($) => $.storage.bytes_title)}
          {report.bytes && report.bytes_measured_at
            ? ` · ${t(($) => $.storage.bytes_measured, { time: timeAgo(report.bytes_measured_at) })}`
            : ""}
        </div>
        {report.bytes ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
            {BYTE_CATEGORIES.map((category) => (
              <Metric
                key={category}
                label={t(($) => $.storage.bytes[category])}
                value={formatBytes(report.bytes![category])}
              />
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{t(($) => $.storage.not_measured)}</p>
        )}
      </div>

      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
          {t(($) => $.storage.subjects_title)}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          {SUBJECT_COUNTS.map((count) => (
            <Metric
              key={count}
              label={t(($) => $.storage.subjects[count])}
              value={String(report.subjects[count])}
            />
          ))}
        </dl>
      </div>

      {retained.length > 0 && (
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            {t(($) => $.storage.retained_title)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {retained.map(([reason, count]) => (
              <Badge key={reason} variant="outline" className="gap-1">
                {isOneOf(RETAIN_REASONS, reason) ? t(($) => $.storage.reasons[reason]) : reason}
                <span className="tabular-nums">{count}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground">
          {t(($) => $.storage.last_round)}
          {" · "}
          {isOneOf(REPORT_MODES, report.mode) ? t(($) => $.storage.modes[report.mode]) : report.mode}
        </div>
        <p className="text-sm">
          {t(($) => $.storage.last_round_summary, {
            size: formatBytes(report.freed_bytes),
            reclaimed: report.reclaimed_this_round,
            forgotten: report.forgotten_this_round,
          })}
        </p>
      </div>

      {report.errors.length > 0 && (
        <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
            <AlertCircle className="size-3.5" />
            {t(($) => $.storage.errors_title, { count: report.errors.length })}
          </div>
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {report.errors.slice(0, 5).map((error, index) => (
              <li key={index} className="break-words">
                {error.subject_id ? `${error.subject_id}: ` : ""}
                {error.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function PlanTable({ report }: { report: StorageReport }) {
  const { t } = useT("runtimes");
  const paths = useWorkspacePaths();
  const items = orderedPlan(report.plan);
  const shown = items.slice(0, PLAN_ROW_LIMIT);

  // A dry run snapshots nothing and a kept subject keeps its work in place;
  // only a real round that reclaims or forgets has written the snapshot.
  function unsavedLabel(item: StoragePlanItem): string {
    if (item.action === "keep") return t(($) => $.storage.plan.unsaved_kept);
    return report.mode === "dry_run"
      ? t(($) => $.storage.plan.unsaved_will_save)
      : t(($) => $.storage.plan.unsaved_saved);
  }

  function subjectHref(item: StoragePlanItem): string | null {
    if (item.subject.kind === "issue") return paths.issueDetail(item.subject.id);
    if (item.subject.kind === "chat") return paths.chat(item.subject.id);
    return null;
  }

  return (
    <div>
      <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
        {isOneOf(REPORT_MODES, report.mode)
          ? t(($) => $.storage.plan_title[report.mode])
          : t(($) => $.storage.plan_title.periodic)}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t(($) => $.storage.plan.subject)}</TableHead>
            <TableHead>{t(($) => $.storage.plan.action)}</TableHead>
            <TableHead>{t(($) => $.storage.plan.reason)}</TableHead>
            <TableHead className="text-right">{t(($) => $.storage.plan.size)}</TableHead>
            <TableHead>{t(($) => $.storage.plan.unsaved)}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((item) => {
            const href = subjectHref(item);
            const { action, reason } = item;
            const subjectKind = item.subject.kind;
            const kind = isOneOf(SUBJECT_KINDS, subjectKind)
              ? t(($) => $.storage.subject_kinds[subjectKind])
              : subjectKind;
            return (
              <TableRow key={`${item.subject.kind}:${item.subject.id}`}>
                <TableCell className="max-w-56">
                  <span className="mr-1.5 text-xs text-muted-foreground">{kind}</span>
                  {href ? (
                    <AppLink href={href} className="font-mono text-xs underline-offset-4 hover:underline">
                      {item.subject.id}
                    </AppLink>
                  ) : (
                    <span className="font-mono text-xs">{item.subject.id}</span>
                  )}
                </TableCell>
                <TableCell>
                  {isOneOf(PLAN_ACTIONS, action) ? t(($) => $.storage.actions[action]) : action}
                </TableCell>
                <TableCell>
                  {isOneOf(PLAN_REASONS, reason) ? t(($) => $.storage.reasons[reason]) : reason}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {item.bytes === null ? "—" : formatBytes(item.bytes)}
                </TableCell>
                <TableCell>{item.unsaved_work ? unsavedLabel(item) : "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {items.length > shown.length && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t(($) => $.storage.plan.truncated, { count: shown.length, total: items.length })}
        </p>
      )}
    </div>
  );
}

/** Runtime detail variant: finds this runtime's machine among the workspace's daemon reports. */
export function RuntimeStorageCard({
  daemonId,
  runtimeId,
  canManage,
}: {
  daemonId: string;
  runtimeId: string;
  canManage: boolean;
}) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const query = useQuery(workspaceStorageDaemonsOptions(wsId));

  if (query.isPending) return <Skeleton className="h-40 w-full" aria-busy="true" />;
  if (query.isError) {
    return (
      <div role="alert" className="flex items-center gap-2 rounded-lg border p-4 text-sm">
        <AlertCircle className="size-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">{t(($) => $.storage.load_failed)}</span>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          {t(($) => $.storage.retry)}
        </Button>
      </div>
    );
  }
  const daemon = query.data.daemons.find((item) => item.daemon_id === daemonId);
  if (!daemon) return null;
  return <DaemonStorageCard daemon={daemon} canManage={canManage} preferredRuntimeId={runtimeId} />;
}
