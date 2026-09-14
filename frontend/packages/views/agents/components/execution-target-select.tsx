"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { deriveRuntimeHealth, runtimeListOptions } from "@multiremi/core/runtimes";
import { useAuthStore } from "@multiremi/core/auth";
import { Label } from "@multiremi/ui/components/ui/label";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { PickerItem, PropertyPicker } from "../../issues/components/pickers";
import { useT } from "../../i18n";
import { CHIP_CLASS } from "./inspector/chip";
import { ENGINES } from "./engine-select";

export interface ExecutionTarget {
  runtimeId: string;
  provider: string;
}

/** Shared execution-target boundary; today a target is a machine and Runtime type. */
export function ExecutionTargetSelect({ wsId, value, onChange, compact = false, canEdit = true, ownerId }: {
  wsId: string;
  value: ExecutionTarget;
  onChange: (target: ExecutionTarget) => void | Promise<void>;
  compact?: boolean;
  canEdit?: boolean;
  ownerId?: string | null;
}) {
  const { t } = useT("agents");
  const currentUserId = useAuthStore((state) => state.user?.id);
  const agentOwnerId = (ownerId === undefined ? currentUserId : ownerId) ?? "local";
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const query = useQuery({ ...runtimeListOptions(wsId), enabled: !!wsId });
  const targets = (query.data ?? []).filter((runtime) =>
    runtime.visibility === "public" || (runtime.owner_id ?? "local") === agentOwnerId,
  ).flatMap((runtime) =>
    (runtime.provider === "any" ? ENGINES : [runtime.provider]).map((provider) => ({
      runtimeId: runtime.id,
      provider,
      label: `${runtime.daemon_display_name || runtime.name} / ${provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : provider}`,
      online: deriveRuntimeHealth(runtime, Date.now()) === "online",
    })),
  );
  const selected = targets.find((target) => target.runtimeId === value.runtimeId && target.provider === value.provider);
  const label = selected?.label ?? (value.runtimeId
    ? t(($) => $.execution_target.unavailable)
    : t(($) => $.execution_target.placeholder));
  const status = query.isLoading ? t(($) => $.execution_target.loading)
    : query.isError ? t(($) => $.execution_target.error)
    : targets.length === 0 ? t(($) => $.execution_target.empty)
    : selected ? selected.online ? t(($) => $.execution_target.hint, { target: selected.label })
      : t(($) => $.execution_target.offline)
    : label;
  const choose = (target: ExecutionTarget) => {
    setOpen(false);
    if (target.runtimeId !== value.runtimeId || target.provider !== value.provider) void onChange({ runtimeId: target.runtimeId, provider: target.provider });
  };
  const options = targets.map((target) => (
    <PickerItem key={`${target.runtimeId}:${target.provider}`} selected={target === selected} onClick={() => choose(target)}>
      <ProviderLogo provider={target.provider} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{target.label}</span>
      {!target.online && <span className="text-xs text-muted-foreground">{t(($) => $.execution_target.offline_badge)}</span>}
    </PickerItem>
  ));
  if (!canEdit) return <span className="min-w-0 truncate px-1.5 text-xs" title={status}>{label}</span>;
  if (compact) return (
    <PropertyPicker open={open} onOpenChange={setOpen} width="w-auto min-w-[16rem] max-w-md" align="start"
      tooltip={status} triggerRender={<button type="button" className={CHIP_CLASS} aria-label={t(($) => $.execution_target.label)} />}
      trigger={<span className="min-w-0 truncate">{label}</span>}>
      <div className="max-h-72 overflow-y-auto">{options}</div>
      <p className="border-t px-3 py-2 text-xs text-muted-foreground" role="status">{status}</p>
    </PropertyPicker>
  );
  return (
    <div>
      <Label id={labelId} className="text-xs text-muted-foreground">{t(($) => $.execution_target.label)}</Label>
      <div role="group" aria-labelledby={labelId} className="mt-1.5 max-h-56 overflow-y-auto rounded-lg border p-1">{options}</div>
      <p className={`mt-1.5 text-xs ${selected && !selected.online ? "text-warning" : "text-muted-foreground"}`} role="status">{status}</p>
    </div>
  );
}
