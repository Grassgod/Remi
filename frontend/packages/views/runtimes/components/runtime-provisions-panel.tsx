"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  PackageCheck,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWSEvent } from "@multiremi/core/realtime";
import {
  runtimeProvisionStatesOptions,
  runtimeProvisionsOptions,
  useCreateRuntimeProvision,
  useDeleteRuntimeProvision,
  useUpdateRuntimeProvision,
} from "@multiremi/core/runtimes";
import { runtimeKeys, runtimeListOptions } from "@multiremi/core/runtimes/queries";
import type {
  RuntimeProvision,
  RuntimeProvisionInput,
  RuntimeProvisionKind,
  RuntimeProvisionState,
  RuntimeProvisionTriggerKind,
} from "@multiremi/core/runtimes";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import {
  getDefaultTriggerConfig,
  parseCronExpression,
  toCronExpression,
  TriggerConfigSection,
  useSummarizeTrigger,
  type TriggerConfig,
} from "../../common/trigger-config";
import { useT } from "../../i18n";
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
import { Checkbox } from "@multiremi/ui/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { cn } from "@multiremi/ui/lib/utils";
import { statusConfig } from "./update-section";

type KindFilter = "all" | RuntimeProvisionKind;

const STATE_PRIORITY: Record<string, number> = {
  failed: 0,
  pending: 1,
  drifted: 2,
  converged: 3,
};

export function sortRuntimeProvisionStates(states: RuntimeProvisionState[]): RuntimeProvisionState[] {
  return states.toSorted((left, right) => {
    const priority = (STATE_PRIORITY[left.status] ?? 4) - (STATE_PRIORITY[right.status] ?? 4);
    return priority || left.runtime_id.localeCompare(right.runtime_id);
  });
}

export function RuntimeProvisionsPanel() {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const user = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const membersQuery = useQuery(memberListOptions(wsId));
  const member = membersQuery.data?.find((candidate) => candidate.user_id === user?.id);
  const canManage = member?.role === "owner" || member?.role === "admin";
  const provisionsQuery = useQuery(runtimeProvisionsOptions(wsId));
  const [filter, setFilter] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<RuntimeProvision | "create" | null>(null);
  const [deleting, setDeleting] = useState<RuntimeProvision | null>(null);
  const deleteMutation = useDeleteRuntimeProvision(wsId);
  const lastRefreshRef = useRef(0);

  const provisions = provisionsQuery.data ?? [];
  const filtered = filter === "all"
    ? provisions
    : provisions.filter((provision) => provision.kind === filter);
  const selected = filtered.find((provision) => provision.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (!selected && selectedId) setSelectedId(null);
  }, [selected, selectedId]);

  const refreshFromDaemon = useCallback(() => {
    const now = Date.now();
    if (now - lastRefreshRef.current < 5_000) return;
    lastRefreshRef.current = now;
    queryClient.invalidateQueries({ queryKey: runtimeKeys.provisions(wsId) });
  }, [queryClient, wsId]);
  useWSEvent("daemon:heartbeat", refreshFromDaemon);
  useWSEvent("daemon:register", refreshFromDaemon);
  useWSEvent("daemon:retired", refreshFromDaemon);

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteMutation.mutateAsync(deleting.id);
      toast.success(t(($) => $.provisions.toast.deleted));
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.provisions.toast.delete_failed));
    }
  };

  if (provisionsQuery.isPending) return <ProvisionPanelSkeleton />;

  if (provisionsQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
        <PackageCheck className="size-8 text-muted-foreground/40" />
        <p className="mt-3 text-sm font-medium">{t(($) => $.provisions.load_failed)}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => void provisionsQuery.refetch()}
          disabled={provisionsQuery.isFetching}
        >
          <RefreshCw className={cn("size-3.5", provisionsQuery.isFetching && "animate-spin")} />
          {t(($) => $.provisions.retry)}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <PackageCheck className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t(($) => $.provisions.title)}</h3>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t(($) => $.provisions.subtitle)}</p>
        </div>
        {canManage && (
          <Button type="button" size="sm" onClick={() => setEditing("create")}>
            <Plus className="size-3.5" />
            {t(($) => $.provisions.add)}
          </Button>
        )}
      </header>

      <div className="flex items-center gap-1 border-b px-5 py-2" role="group" aria-label={t(($) => $.provisions.filter_label)}>
        {(["all", "npm-global", "command"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            variant={filter === value ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => setFilter(value)}
          >
            {filterLabel(value, t)}
          </Button>
        ))}
      </div>

      {provisions.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
          <PackageCheck className="size-8 text-muted-foreground/40" />
          <p className="mt-3 text-sm font-medium">{t(($) => $.provisions.empty)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t(($) => $.provisions.empty_hint)}</p>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(300px,0.86fr)_minmax(0,1.4fr)]">
          <div className="min-h-0 overflow-y-auto border-b lg:border-b-0 lg:border-r">
            {filtered.length === 0 ? (
              <p className="px-5 py-10 text-center text-xs text-muted-foreground">
                {t(($) => $.provisions.filter_empty)}
              </p>
            ) : filtered.map((provision) => (
              <ProvisionRow
                key={provision.id}
                provision={provision}
                selected={provision.id === selected?.id}
                canManage={canManage}
                onSelect={() => setSelectedId(provision.id)}
                onEdit={() => setEditing(provision)}
                onDelete={() => setDeleting(provision)}
              />
            ))}
          </div>
          <ProvisionMatrix provision={selected} />
        </div>
      )}

      {editing && (
        <RuntimeProvisionDialog
          key={editing === "create" ? "create" : editing.id}
          current={editing === "create" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.provisions.delete.title)}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(($) => $.provisions.delete.description, { target: deleting ? provisionTarget(deleting) : "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t(($) => $.provisions.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleteMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {t(($) => $.provisions.delete.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ProvisionRow({
  provision,
  selected,
  canManage,
  onSelect,
  onEdit,
  onDelete,
}: {
  provision: RuntimeProvision;
  selected: boolean;
  canManage: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const updateMutation = useUpdateRuntimeProvision(wsId);
  const summarizeTrigger = useSummarizeTrigger();
  const isSupportedKind = provision.kind === "npm-global" || provision.kind === "command";
  const Icon = provision.kind === "npm-global" ? PackageCheck : Terminal;
  const cronConfig = provision.cron_expression
    ? parseCronExpression(provision.cron_expression, provision.timezone ?? "UTC")
    : null;
  const triggers = [
    provision.trigger_kinds.includes("on_register") ? t(($) => $.provisions.triggers.on_register) : null,
    provision.trigger_kinds.includes("on_change") ? t(($) => $.provisions.triggers.on_change) : null,
    provision.trigger_kinds.includes("cron") && cronConfig ? summarizeTrigger(cronConfig) : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <div className={cn("border-b px-4 py-3", selected && "bg-muted/45")}>
      <div className="flex items-start gap-3">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
          <div className="flex items-center gap-2">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-xs font-medium" title={provisionTarget(provision)}>
              {provisionTarget(provision)}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="h-5 rounded px-1.5 text-[10px]">
              {kindLabel(provision.kind, t)}
            </Badge>
            {triggers.map((trigger) => (
              <span key={trigger} className="text-[11px] text-muted-foreground">{trigger}</span>
            ))}
          </div>
          <ProvisionSummary provisionId={provision.id} />
        </button>
        <div className="flex shrink-0 items-center gap-1">
          {canManage && isSupportedKind ? (
            <>
              <Switch
                checked={provision.enabled === true}
                disabled={updateMutation.isPending}
                aria-label={t(($) => $.provisions.enabled_label)}
                onCheckedChange={(enabled) => updateMutation.mutate({ provisionId: provision.id, input: { enabled } })}
              />
              <Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.provisions.edit)} onClick={onEdit}>
                <Pencil className="size-3.5" />
              </Button>
            </>
          ) : (
            <Badge variant="outline" className="rounded text-[10px]">
              {provision.enabled ? t(($) => $.provisions.enabled) : t(($) => $.provisions.disabled)}
            </Badge>
          )}
          {canManage && (
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t(($) => $.provisions.delete.action)} onClick={onDelete}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ProvisionSummary({ provisionId }: { provisionId: string }) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const statesQuery = useQuery(runtimeProvisionStatesOptions(wsId, provisionId));
  if (statesQuery.isPending) return <div className="mt-2 h-3 w-24 animate-pulse rounded bg-muted" />;
  const states = statesQuery.data ?? [];
  const converged = states.filter((state) => state.status === "converged").length;
  const attention = states.length - converged;
  return (
    <p className="mt-2 text-[11px] text-muted-foreground">
      {t(($) => $.provisions.summary, { converged, attention, total: states.length })}
    </p>
  );
}

function ProvisionMatrix({ provision }: { provision: RuntimeProvision | null }) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const statesQuery = useQuery(runtimeProvisionStatesOptions(wsId, provision?.id ?? null));
  const runtimesQuery = useQuery(runtimeListOptions(wsId));
  const runtimeNames = useMemo(
    () => new Map((runtimesQuery.data ?? []).map((runtime) => [runtime.id, runtime.name])),
    [runtimesQuery.data],
  );
  const states = useMemo(() => sortRuntimeProvisionStates(statesQuery.data ?? []), [statesQuery.data]);

  if (!provision) {
    return <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">{t(($) => $.provisions.matrix.select)}</div>;
  }

  return (
    <section className="min-h-0 overflow-y-auto">
      <div className="sticky top-0 z-10 border-b bg-background px-5 py-3">
        <h4 className="text-xs font-semibold">{t(($) => $.provisions.matrix.title)}</h4>
        <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={provisionTarget(provision)}>
          {provisionTarget(provision)}
        </p>
      </div>
      {statesQuery.isPending ? (
        <div className="flex h-36 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
      ) : statesQuery.isError ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">{t(($) => $.provisions.matrix.load_failed)}</div>
      ) : states.length === 0 ? (
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">{t(($) => $.provisions.matrix.empty)}</div>
      ) : (
        <div>
          {states.map((state) => (
            <ProvisionStateRow key={state.runtime_id} state={state} runtimeName={runtimeNames.get(state.runtime_id) ?? state.runtime_id} />
          ))}
        </div>
      )}
    </section>
  );
}

function ProvisionStateRow({ state, runtimeName }: { state: RuntimeProvisionState; runtimeName: string }) {
  const { t } = useT("runtimes");
  const [expanded, setExpanded] = useState(false);
  const config = state.status === "converged"
    ? statusConfig.completed
    : state.status === "failed"
      ? statusConfig.failed
      : state.status === "drifted"
        ? statusConfig.timeout
        : statusConfig.pending;
  const Icon = config.icon;
  const hasError = Boolean(state.last_error);
  return (
    <div className="border-b px-5 py-3">
      <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_110px_150px_auto]">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium" title={runtimeName}>{runtimeName}</p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">{state.runtime_id}</p>
        </div>
        <span className={cn("inline-flex items-center gap-1 text-[11px]", config.color)}>
          <Icon className={cn("size-3.5", state.status === "pending" && "animate-spin")} />
          {statusLabel(state.status, t)}
        </span>
        <div className="hidden min-w-0 sm:block">
          <p className="truncate font-mono text-[11px]">{state.observed_version ?? t(($) => $.provisions.not_available)}</p>
          <p className="text-[10px] text-muted-foreground">{formatTimestamp(state.last_checked_at)}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(!hasError && "invisible")}
          aria-label={t(($) => $.provisions.matrix.error_details)}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </Button>
      </div>
      {expanded && state.last_error && (
        <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap border-l-2 border-destructive/40 pl-3 text-[11px] text-destructive">
          {state.last_error}
        </pre>
      )}
    </div>
  );
}

function RuntimeProvisionDialog({ current, onClose }: { current: RuntimeProvision | null; onClose: () => void }) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const createMutation = useCreateRuntimeProvision(wsId);
  const updateMutation = useUpdateRuntimeProvision(wsId);
  const editing = Boolean(current);
  const [kind, setKind] = useState<RuntimeProvisionKind>(current?.kind === "command" ? "command" : "npm-global");
  const [enabled, setEnabled] = useState(current?.enabled ?? true);
  const [packageName, setPackageName] = useState(current?.package ?? "");
  const [version, setVersion] = useState(current?.version ?? "latest");
  const [versionCheck, setVersionCheck] = useState(current?.version_check ?? true);
  const [bin, setBin] = useState(current?.bin ?? "");
  const [registry, setRegistry] = useState(current?.registry ?? "https://registry.npmjs.org");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [triggers, setTriggers] = useState<RuntimeProvisionTriggerKind[]>(
    (current?.trigger_kinds.filter(isTriggerKind) as RuntimeProvisionTriggerKind[] | undefined) ?? ["on_register", "on_change"],
  );
  const [triggerConfig, setTriggerConfig] = useState<TriggerConfig>(() =>
    current?.cron_expression
      ? parseCronExpression(current.cron_expression, current.timezone ?? "UTC")
      : getDefaultTriggerConfig(),
  );
  const [timeoutMs, setTimeoutMs] = useState(String(current?.timeout_ms ?? (kind === "npm-global" ? 900_000 : 300_000)));
  const pending = createMutation.isPending || updateMutation.isPending;

  const toggleTrigger = (trigger: RuntimeProvisionTriggerKind, checked: boolean) => {
    setTriggers((currentTriggers) => checked
      ? [...new Set([...currentTriggers, trigger])]
      : currentTriggers.filter((candidate) => candidate !== trigger));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsedTimeout = Number(timeoutMs);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
      toast.error(t(($) => $.provisions.form.timeout_invalid));
      return;
    }
    if (kind === "npm-global" && (!packageName.trim() || !version.trim() || !bin.trim())) {
      toast.error(t(($) => $.provisions.form.npm_required));
      return;
    }
    if (kind === "command" && !editing && !command.trim()) {
      toast.error(t(($) => $.provisions.form.command_required));
      return;
    }
    const input: RuntimeProvisionInput = {
      kind,
      enabled,
      trigger_kinds: triggers,
      cron_expression: triggers.includes("cron") ? toCronExpression(triggerConfig) : null,
      timezone: triggers.includes("cron") ? triggerConfig.timezone : null,
      timeout_ms: parsedTimeout,
      ...(kind === "npm-global" ? {
        package: packageName.trim(),
        version: version.trim(),
        version_check: versionCheck,
        bin: bin.trim(),
        registry: registry.trim(),
      } : {
        ...(command.trim() ? { command: command.trim() } : {}),
        ...(!editing || command.trim() || argsText.trim()
          ? { args: argsText.split("\n").map((arg) => arg.trim()).filter(Boolean) }
          : {}),
      }),
    };

    try {
      if (current) await updateMutation.mutateAsync({ provisionId: current.id, input });
      else await createMutation.mutateAsync(input);
      toast.success(t(($) => current ? $.provisions.toast.updated : $.provisions.toast.created));
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.provisions.toast.save_failed));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-5">
          <DialogTitle className="text-base">{t(($) => editing ? $.provisions.form.edit_title : $.provisions.form.create_title)}</DialogTitle>
          <DialogDescription className="text-xs">{t(($) => $.provisions.form.description)}</DialogDescription>
        </DialogHeader>
        <form id="runtime-provision-form" onSubmit={handleSubmit} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label>{t(($) => $.provisions.form.kind)}</Label>
                <div className="mt-1.5 flex gap-1">
                  {(["npm-global", "command"] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={kind === value ? "secondary" : "outline"}
                      disabled={editing}
                      onClick={() => {
                        setKind(value);
                        setTimeoutMs(String(value === "npm-global" ? 900_000 : 300_000));
                      }}
                    >
                      {kindLabel(value, t)}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="runtime-provision-enabled">{t(($) => $.provisions.enabled_label)}</Label>
                <Switch id="runtime-provision-enabled" checked={enabled} onCheckedChange={setEnabled} />
              </div>
            </div>

            {kind === "npm-global" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <ProvisionField label={t(($) => $.provisions.form.package)} value={packageName} onChange={setPackageName} placeholder="@scope/package" />
                <ProvisionField label={t(($) => $.provisions.form.version)} value={version} onChange={setVersion} placeholder="latest" />
                <ProvisionField label={t(($) => $.provisions.form.bin)} value={bin} onChange={setBin} placeholder="tool" />
                <ProvisionField label={t(($) => $.provisions.form.registry)} value={registry} onChange={setRegistry} placeholder="https://registry.npmjs.org" />
                <label className="flex items-center gap-2 text-xs sm:col-span-2">
                  <Checkbox checked={versionCheck} onCheckedChange={(checked) => setVersionCheck(checked === true)} />
                  {t(($) => $.provisions.form.version_check)}
                </label>
              </div>
            ) : (
              <div className="space-y-4">
                {current?.command && (
                  <div>
                    <Label>{t(($) => $.provisions.form.current_command)}</Label>
                    <pre className="mt-1.5 max-h-24 overflow-auto whitespace-pre-wrap rounded border bg-muted/30 p-2 font-mono text-xs">{provisionTarget(current)}</pre>
                  </div>
                )}
                <div>
                  <Label htmlFor="runtime-provision-command">{editing ? t(($) => $.provisions.form.replacement_command) : t(($) => $.provisions.form.command)}</Label>
                  <Textarea
                    id="runtime-provision-command"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder={editing ? t(($) => $.provisions.form.leave_unchanged) : "1passport sync"}
                    className="mt-1.5 min-h-20 resize-y font-mono text-xs"
                  />
                </div>
                <div>
                  <Label htmlFor="runtime-provision-args">{t(($) => $.provisions.form.args)}</Label>
                  <Textarea
                    id="runtime-provision-args"
                    value={argsText}
                    onChange={(event) => setArgsText(event.target.value)}
                    placeholder={t(($) => $.provisions.form.args_placeholder)}
                    className="mt-1.5 min-h-16 resize-y font-mono text-xs"
                  />
                </div>
              </div>
            )}

            <div>
              <Label>{t(($) => $.provisions.form.triggers)}</Label>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                {(["on_register", "on_change", "cron"] as const).map((trigger) => (
                  <label key={trigger} className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={triggers.includes(trigger)}
                      onCheckedChange={(checked) => toggleTrigger(trigger, checked === true)}
                    />
                    {t(($) => $.provisions.triggers[trigger])}
                  </label>
                ))}
              </div>
            </div>

            {triggers.includes("cron") && (
              <div className="border-t pt-4">
                <TriggerConfigSection config={triggerConfig} onChange={setTriggerConfig} />
              </div>
            )}

            <div className="max-w-48">
              <ProvisionField
                label={t(($) => $.provisions.form.timeout)}
                value={timeoutMs}
                onChange={setTimeoutMs}
                type="number"
              />
            </div>
          </div>
        </form>
        <DialogFooter className="m-0 border-t bg-muted/30 px-6 py-3">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>{t(($) => $.provisions.cancel)}</Button>
          <Button type="submit" size="sm" form="runtime-provision-form" disabled={pending}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {t(($) => $.provisions.save)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProvisionField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number";
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="mt-1.5 font-mono text-xs"
      />
    </div>
  );
}

function ProvisionPanelSkeleton() {
  return (
    <div className="space-y-3 px-5 py-5">
      <div className="h-5 w-40 animate-pulse rounded bg-muted" />
      {[0, 1, 2].map((index) => <div key={index} className="h-16 animate-pulse rounded bg-muted/70" />)}
    </div>
  );
}

function provisionTarget(provision: RuntimeProvision): string {
  if (provision.kind === "npm-global") {
    return `${provision.package ?? "unknown"}@${provision.version ?? "unknown"}`;
  }
  return [provision.command, ...provision.args].filter(Boolean).join(" ") || "unknown";
}

function isTriggerKind(value: string): value is RuntimeProvisionTriggerKind {
  return value === "cron" || value === "on_register" || value === "on_change";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

type RuntimesT = ReturnType<typeof useT<"runtimes">>["t"];

function kindLabel(kind: string, t: RuntimesT): string {
  if (kind === "npm-global") return t(($) => $.provisions.kinds.npm_global);
  if (kind === "command") return t(($) => $.provisions.kinds.command);
  return t(($) => $.provisions.kinds.unknown);
}

function filterLabel(filter: KindFilter, t: RuntimesT): string {
  if (filter === "all") return t(($) => $.provisions.filters.all);
  return kindLabel(filter, t);
}

function statusLabel(status: string, t: RuntimesT): string {
  if (status === "pending") return t(($) => $.provisions.status.pending);
  if (status === "converged") return t(($) => $.provisions.status.converged);
  if (status === "drifted") return t(($) => $.provisions.status.drifted);
  if (status === "failed") return t(($) => $.provisions.status.failed);
  return t(($) => $.provisions.status.unknown);
}
