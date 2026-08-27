"use client";

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import type { SessionArchive } from "@multiremi/core/api";
import {
  issueSessionArchivesOptions,
  useRetryIssueSessionArchive,
  useVerifyIssueSessionArchive,
} from "@multiremi/core/session-archives";
import type { IssueStatus } from "@multiremi/core/types";
import { Badge } from "@multiremi/ui/components/ui/badge";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import { useT } from "../../i18n";

export function IssueSessionArchivesSection({
  issueId,
  issueStatus,
  canManage,
}: {
  issueId: string;
  issueStatus: IssueStatus;
  canManage: boolean;
}) {
  const { t } = useT("issues");
  const [open, setOpen] = useState(false);
  const terminal = issueStatus === "done" || issueStatus === "cancelled";
  const archivesQuery = useQuery({
    ...issueSessionArchivesOptions(issueId),
    enabled: canManage && Boolean(issueId),
    refetchInterval: (query) => sessionArchiveRefetchInterval(
      terminal,
      query.state.data?.latest?.status,
    ),
  });
  const verifyArchive = useVerifyIssueSessionArchive(issueId);
  const retryArchive = useRetryIssueSessionArchive(issueId);

  if (!canManage) return null;

  const archives = archivesQuery.data?.archives ?? [];
  if (!archivesQuery.isPending && !archivesQuery.isError && archives.length === 0 && !terminal) {
    return null;
  }

  const latest = archivesQuery.data?.latest ?? archives[0] ?? null;
  const status = archivesQuery.isError
    ? "unknown"
    : latest?.status ?? (archivesQuery.isPending ? "loading" : "none");

  async function verify(archiveId: string) {
    try {
      const result = await verifyArchive.mutateAsync(archiveId);
      if (result.valid) toast.success(t(($) => $.detail.session_archive_verified));
      else toast.error(result.error || t(($) => $.detail.session_archive_invalid));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(($) => $.detail.session_archive_verify_failed),
      );
    }
  }

  async function retry(archiveId: string) {
    try {
      await retryArchive.mutateAsync(archiveId);
      toast.success(t(($) => $.detail.session_archive_retry_queued));
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t(($) => $.detail.session_archive_retry_failed),
      );
    }
  }

  return (
    <div>
      <button
        type="button"
        className={`mb-2 flex w-full items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-accent/70 ${open ? "" : "text-muted-foreground hover:text-foreground"}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {t(($) => $.detail.section_session_archives)}
        <ArchiveStatusBadge status={status} retryState={latest?.retry_state} />
        {archives.length > 0 && (
          <span className="tabular-nums text-muted-foreground">· {archives.length}</span>
        )}
        <ChevronRight
          className={`!size-3 shrink-0 stroke-[2.5] text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-1 pl-2">
          {archivesQuery.isError ? (
            <div className="flex items-center justify-between gap-2 py-1 text-xs text-destructive">
              <span>{t(($) => $.detail.session_archive_load_failed)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void archivesQuery.refetch()}
                aria-label={t(($) => $.detail.session_archive_retry_load)}
                title={t(($) => $.detail.session_archive_retry_load)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          ) : archivesQuery.isPending ? (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t(($) => $.detail.session_archive_loading)}
            </div>
          ) : archives.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">
              {t(($) => $.detail.session_archive_empty)}
            </p>
          ) : (
            archives.map((archive) => (
              <ArchiveRow
                key={archive.id}
                archive={archive}
                verifying={verifyArchive.isPending && verifyArchive.variables === archive.id}
                retrying={retryArchive.isPending && retryArchive.variables === archive.id}
                onVerify={verify}
                onRetry={retry}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function sessionArchiveRefetchInterval(
  terminal: boolean,
  latestStatus: SessionArchive["status"] | null | undefined,
): 5000 | false {
  if (
    latestStatus === "pending"
    || latestStatus === "uploading"
  ) return 5000;
  return terminal && !latestStatus ? 5000 : false;
}

function ArchiveRow({
  archive,
  verifying,
  retrying,
  onVerify,
  onRetry,
}: {
  archive: SessionArchive;
  verifying: boolean;
  retrying: boolean;
  onVerify: (archiveId: string) => Promise<void>;
  onRetry: (archiveId: string) => Promise<void>;
}) {
  const { t } = useT("issues");
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md px-1 py-1.5 hover:bg-accent/40">
      <ArchiveStatusIcon status={archive.status} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[11px]" title={archive.id}>
            {shortArchiveId(archive.id)}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {archive.file_count === null
              ? formatBytes(archive.size_bytes)
              : t(($) => $.detail.session_archive_files, {
                  count: archive.file_count,
                  size: formatBytes(archive.size_bytes),
                })}
          </span>
          {archive.retry_state === "exhausted" && (
            <Badge variant="destructive" className="h-4 px-1 text-[10px] font-normal">
              {t(($) => $.detail.session_archive_stopped)}
            </Badge>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">
          {formatTimestamp(archive.completed_at ?? archive.updated_at)} · {t(($) => $.detail.session_archive_attempts, {
            count: archive.attempt_count,
          })}
        </p>
        {archive.last_error && (
          <p className="break-words text-[10px] text-destructive">{archive.last_error}</p>
        )}
        {archive.retry_state === "backoff" && archive.next_retry_at && (
          <p className="text-[10px] text-muted-foreground">
            {t(($) => $.detail.session_archive_next_retry, {
              time: formatTimestamp(archive.next_retry_at),
            })}
          </p>
        )}
      </div>
      {archive.status === "ready" && (
        <ArchiveAction
          label={t(($) => $.detail.session_archive_verify)}
          loading={verifying}
          onClick={() => void onVerify(archive.id)}
        >
          <ShieldCheck className="size-3.5" />
        </ArchiveAction>
      )}
      {(archive.status === "failed" || archive.retry_state === "exhausted") && (
        <ArchiveAction
          label={t(($) => $.detail.session_archive_retry)}
          loading={retrying}
          onClick={() => void onRetry(archive.id)}
        >
          <RefreshCw className="size-3.5" />
        </ArchiveAction>
      )}
    </div>
  );
}

function ArchiveAction({
  label,
  loading,
  onClick,
  children,
}: {
  label: string;
  loading: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={loading}
            aria-label={label}
          >
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : children}
          </Button>
        }
      />
      <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
  );
}

function ArchiveStatusBadge({
  status,
  retryState,
}: {
  status: string;
  retryState?: SessionArchive["retry_state"];
}) {
  const { t } = useT("issues");
  if (retryState === "exhausted") {
    return (
      <Badge variant="destructive" className="h-4 px-1 text-[10px] font-normal">
        {t(($) => $.detail.session_archive_stopped)}
      </Badge>
    );
  }
  let label: string;
  switch (status) {
    case "ready": label = t(($) => $.detail.session_archive_status.ready); break;
    case "failed": label = t(($) => $.detail.session_archive_status.failed); break;
    case "pending": label = t(($) => $.detail.session_archive_status.pending); break;
    case "uploading": label = t(($) => $.detail.session_archive_status.uploading); break;
    case "superseded": label = t(($) => $.detail.session_archive_status.superseded); break;
    case "loading": label = t(($) => $.detail.session_archive_status.loading); break;
    case "none": label = t(($) => $.detail.session_archive_status.none); break;
    case "unknown": label = t(($) => $.detail.session_archive_status.unknown); break;
    default: label = status || t(($) => $.detail.session_archive_status.unknown);
  }
  return (
    <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
      {label}
    </Badge>
  );
}

function ArchiveStatusIcon({ status }: { status: string }) {
  if (status === "ready") return <CheckCircle2 className="size-3.5 shrink-0 text-success" />;
  if (status === "failed") return <CircleAlert className="size-3.5 shrink-0 text-destructive" />;
  if (status === "pending" || status === "uploading") {
    return <Clock3 className="size-3.5 shrink-0 text-warning" />;
  }
  return <Archive className="size-3.5 shrink-0 text-muted-foreground" />;
}

function shortArchiveId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
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
