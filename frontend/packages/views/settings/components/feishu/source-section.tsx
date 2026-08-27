"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { MoreHorizontal, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  deriveSourceState,
  feishuSourceStateTone,
  feishuSourceStatusOptions,
  useDeleteFeishuSource,
  useUpdateFeishuSource,
  type FeishuEndpointHealth,
  type FeishuSource,
  type FeishuSourceState,
  type FeishuSourceStatus,
} from "@multiremi/core/feishu";
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
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@multiremi/ui/components/ui/table";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { useT, useTimeAgo } from "../../../i18n";
import { StateBadge, absoluteTime } from "./shared";
import { SourceDialog } from "./source-dialog";

interface SourceSectionProps {
  permitted: boolean;
  workspaceId: string;
  sources: FeishuSource[];
  endpoints: FeishuEndpointHealth[];
  loading: boolean;
}

interface SourceRow {
  source: FeishuSource;
  status: FeishuSourceStatus | null;
  state: FeishuSourceState;
}

/** Which source a confirmation dialog is about, and what it will do. Both
 *  destructive paths go through the same two-step shape so neither can be
 *  triggered by a single mis-click. */
type Confirmation =
  | { kind: "disable"; source: FeishuSource }
  | { kind: "delete"; source: FeishuSource };

export function SourceSection(props: SourceSectionProps) {
  const { t } = useT("settings");
  const isMobile = useIsMobile();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FeishuSource | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const statusQueries = useQueries({
    queries: props.sources.map((source) =>
      feishuSourceStatusOptions(props.workspaceId, source.id, props.permitted)),
  });

  const rows: SourceRow[] = useMemo(
    () =>
      props.sources.map((source, index) => {
        const status = statusQueries[index]?.data ?? null;
        const endpoint = props.endpoints.find((item) => item.name === source.endpointName) ?? null;
        return { source, status, state: deriveSourceState({ source, endpoint, status }) };
      }),
    // `statusQueries` is a new array each render; its data identity is what
    // matters, and re-deriving on every render is cheap for a handful of rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.sources, props.endpoints, statusQueries.map((query) => query.dataUpdatedAt).join(",")],
  );

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (source: FeishuSource) => {
    setEditing(source);
    setDialogOpen(true);
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t(($) => $.feishu.sources.title)}</h3>
        {props.permitted && (
          <Button size="sm" className="min-h-11 md:min-h-9" onClick={openCreate}>
            <Plus className="size-4" aria-hidden />
            {t(($) => $.feishu.sources.create)}
          </Button>
        )}
      </div>

      {!props.permitted
        ? (
          <Card>
            <CardContent className="py-6 text-sm text-muted-foreground">
              {t(($) => $.feishu.sources.forbidden)}
            </CardContent>
          </Card>
        )
        : props.loading && props.sources.length === 0
        ? <Skeleton className="h-24 w-full" />
        : props.sources.length === 0
        ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t(($) => $.feishu.sources.empty)}
            </CardContent>
          </Card>
        )
        : isMobile
        ? (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.source.id}>
                <SourceCard
                  row={row}
                  onEdit={() => openEdit(row.source)}
                  onToggle={() => setConfirmation({ kind: "disable", source: row.source })}
                  onDelete={() => setConfirmation({ kind: "delete", source: row.source })}
                  workspaceId={props.workspaceId}
                />
              </li>
            ))}
          </ul>
        )
        : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t(($) => $.feishu.sources.column_name)}</TableHead>
                  <TableHead>{t(($) => $.feishu.sources.column_state)}</TableHead>
                  <TableHead>{t(($) => $.feishu.sources.column_last_success)}</TableHead>
                  <TableHead>{t(($) => $.feishu.sources.column_lag)}</TableHead>
                  <TableHead>{t(($) => $.feishu.sources.column_failures)}</TableHead>
                  <TableHead>{t(($) => $.feishu.sources.column_backlog)}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <SourceTableRow
                    key={row.source.id}
                    row={row}
                    onEdit={() => openEdit(row.source)}
                    onToggle={() => setConfirmation({ kind: "disable", source: row.source })}
                    onDelete={() => setConfirmation({ kind: "delete", source: row.source })}
                    workspaceId={props.workspaceId}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}

      {props.permitted && (
        <SourceDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          workspaceId={props.workspaceId}
          source={editing}
          endpoints={props.endpoints}
        />
      )}

      <ConfirmationDialog
        confirmation={confirmation}
        rows={rows}
        workspaceId={props.workspaceId}
        onClose={() => setConfirmation(null)}
      />
    </section>
  );
}

function useStateLabels(): Record<FeishuSourceState, string> {
  const { t } = useT("settings");
  return {
    active: t(($) => $.feishu.sources.state_active),
    paused: t(($) => $.feishu.sources.state_paused),
    blocked_empty_allowlist: t(($) => $.feishu.sources.state_blocked_empty_allowlist),
    blocked_endpoint: t(($) => $.feishu.sources.state_blocked_endpoint),
    degraded: t(($) => $.feishu.sources.state_degraded),
  };
}

interface RowActionProps {
  row: SourceRow;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  workspaceId: string;
}

function SourceTableRow({ row, onEdit, onToggle, onDelete, workspaceId }: RowActionProps) {
  const { t } = useT("settings");
  const timeAgo = useTimeAgo();
  const labels = useStateLabels();
  const formatLag = useLagFormatter();
  const status = row.status;
  const lastSuccess = status?.lastSuccessfulIngestAt ?? null;

  return (
    <TableRow>
      <TableCell className="max-w-56">
        <span className="block truncate font-medium">{row.source.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {t(($) => $.feishu.sources.row_meta, {
            endpoint: row.source.endpointName,
            chats: row.source.allowlist.length,
          })}
        </span>
      </TableCell>
      <TableCell>
        <StateBadge tone={feishuSourceStateTone(row.state)} label={labels[row.state]} />
      </TableCell>
      <TableCell className="text-sm" title={absoluteTime(lastSuccess)}>
        {lastSuccess ? timeAgo(lastSuccess) : t(($) => $.feishu.sources.never)}
      </TableCell>
      <TableCell className="text-sm">{formatLag(status?.lagSeconds ?? null)}</TableCell>
      <TableCell className="text-sm">
        {status?.consecutiveFailures ?? 0}
        {status?.lastErrorCode
          ? <span className="ml-1 font-mono text-xs text-destructive">{status.lastErrorCode}</span>
          : null}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <Backlog status={status} />
      </TableCell>
      <TableCell>
        <RowMenu
          row={row}
          onEdit={onEdit}
          onToggle={onToggle}
          onDelete={onDelete}
          workspaceId={workspaceId}
        />
      </TableCell>
    </TableRow>
  );
}

function SourceCard({ row, onEdit, onToggle, onDelete, workspaceId }: RowActionProps) {
  const { t } = useT("settings");
  const timeAgo = useTimeAgo();
  const labels = useStateLabels();
  const formatLag = useLagFormatter();
  const status = row.status;
  const lastSuccess = status?.lastSuccessfulIngestAt ?? null;

  return (
    <Card>
      <CardContent className="space-y-2 py-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-medium">{row.source.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {t(($) => $.feishu.sources.row_meta, {
                endpoint: row.source.endpointName,
                chats: row.source.allowlist.length,
              })}
            </p>
          </div>
          <RowMenu
            row={row}
            onEdit={onEdit}
            onToggle={onToggle}
            onDelete={onDelete}
            workspaceId={workspaceId}
          />
        </div>
        <StateBadge tone={feishuSourceStateTone(row.state)} label={labels[row.state]} />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div>
            <dt className="text-muted-foreground">{t(($) => $.feishu.sources.column_last_success)}</dt>
            <dd title={absoluteTime(lastSuccess)}>
              {lastSuccess ? timeAgo(lastSuccess) : t(($) => $.feishu.sources.never)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t(($) => $.feishu.sources.column_lag)}</dt>
            <dd>{formatLag(status?.lagSeconds ?? null)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t(($) => $.feishu.sources.column_failures)}</dt>
            <dd>{status?.consecutiveFailures ?? 0}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t(($) => $.feishu.sources.column_backlog)}</dt>
            <dd><Backlog status={status} /></dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function RowMenu({ row, onEdit, onToggle, onDelete, workspaceId }: RowActionProps) {
  const { t } = useT("settings");
  const update = useUpdateFeishuSource(workspaceId);
  const enabled = row.source.enabled;

  // Enabling is reversible and safe, so it applies directly. Disabling stops
  // ingestion and is the path that needs the confirmation step.
  const handleToggle = () => {
    if (enabled) {
      onToggle();
      return;
    }
    update.mutate(
      { sourceId: row.source.id, input: { enabled: true } },
      {
        onSuccess: () => toast.success(t(($) => $.feishu.sources.toast_enabled)),
        onError: () => toast.error(t(($) => $.feishu.sources.error_save)),
      },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="min-h-11 min-w-11 md:min-h-8 md:min-w-8"
            aria-label={t(($) => $.feishu.sources.actions_for, { name: row.source.name })}
          />
        }
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onEdit}>
          <Pencil className="size-4" aria-hidden />
          {t(($) => $.feishu.sources.action_edit)}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleToggle} disabled={update.isPending}>
          {enabled
            ? <Pause className="size-4" aria-hidden />
            : <Play className="size-4" aria-hidden />}
          {enabled
            ? t(($) => $.feishu.sources.action_disable)
            : t(($) => $.feishu.sources.action_enable)}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 className="size-4" aria-hidden />
          {t(($) => $.feishu.sources.action_delete)}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Backlog({ status }: { status: FeishuSourceStatus | null }) {
  const { t } = useT("settings");
  if (!status) return <span>—</span>;
  return (
    <span>
      {t(($) => $.feishu.sources.backlog_value, {
        unprocessed: status.unprocessedCount,
        timedOut: status.timedOutCount,
        muted: status.mutedDeliveryCount,
        proposals: status.pendingIssueProposalCount,
      })}
    </span>
  );
}

/** Lag is the operator's "is it keeping up?" number, so it is rendered in the
 *  largest unit that still reads as a duration rather than raw seconds. */
function useLagFormatter(): (lagSeconds: number | null) => string {
  const { t } = useT("settings");
  return (lagSeconds) => {
    if (lagSeconds === null) return "—";
    if (lagSeconds < 60) return t(($) => $.feishu.sources.lag_seconds, { value: Math.round(lagSeconds) });
    if (lagSeconds < 3600) return t(($) => $.feishu.sources.lag_minutes, { value: Math.round(lagSeconds / 60) });
    return t(($) => $.feishu.sources.lag_hours, { value: Math.round(lagSeconds / 3600) });
  };
}

function ConfirmationDialog({ confirmation, rows, workspaceId, onClose }: {
  confirmation: Confirmation | null;
  rows: SourceRow[];
  workspaceId: string;
  onClose: () => void;
}) {
  const { t } = useT("settings");
  const update = useUpdateFeishuSource(workspaceId);
  const remove = useDeleteFeishuSource(workspaceId);
  const source = confirmation?.source ?? null;
  const row = rows.find((item) => item.source.id === source?.id) ?? null;
  const pending = update.isPending || remove.isPending;

  const handleConfirm = () => {
    if (!confirmation) return;
    const id = confirmation.source.id;
    if (confirmation.kind === "disable") {
      update.mutate({ sourceId: id, input: { enabled: false } }, {
        onSuccess: () => {
          toast.success(t(($) => $.feishu.sources.toast_disabled));
          onClose();
        },
        onError: () => toast.error(t(($) => $.feishu.sources.error_save)),
      });
      return;
    }
    remove.mutate(id, {
      onSuccess: () => {
        toast.success(t(($) => $.feishu.sources.toast_deleted));
        onClose();
      },
      onError: () => toast.error(t(($) => $.feishu.sources.error_delete)),
    });
  };

  // The counts are what makes this a real confirmation rather than a speed
  // bump: the operator sees how much unprocessed work the action strands.
  const impact = t(($) => $.feishu.sources.confirm_impact, {
    chats: source?.allowlist.length ?? 0,
    unprocessed: row?.status?.unprocessedCount ?? 0,
    proposals: row?.status?.pendingIssueProposalCount ?? 0,
  });

  return (
    <AlertDialog open={confirmation !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {confirmation?.kind === "delete"
              ? t(($) => $.feishu.sources.confirm_delete_title, { name: source?.name ?? "" })
              : t(($) => $.feishu.sources.confirm_disable_title, { name: source?.name ?? "" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {confirmation?.kind === "delete"
              ? t(($) => $.feishu.sources.confirm_delete_description)
              : t(($) => $.feishu.sources.confirm_disable_description)}
            {" "}
            {impact}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t(($) => $.feishu.sources.dialog.cancel)}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={confirmation?.kind === "delete" ? "destructive" : "default"}
            disabled={pending}
            onClick={handleConfirm}
          >
            {confirmation?.kind === "delete"
              ? t(($) => $.feishu.sources.confirm_delete_action)
              : t(($) => $.feishu.sources.confirm_disable_action)}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
