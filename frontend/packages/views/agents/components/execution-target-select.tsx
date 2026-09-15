"use client";

import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { executionGroupListOptions, runtimeListOptions } from "@multiremi/core/runtimes";
import { useAuthStore } from "@multiremi/core/auth";
import { Label } from "@multiremi/ui/components/ui/label";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { PickerItem, PropertyPicker } from "../../issues/components/pickers";
import { useT } from "../../i18n";
import { CHIP_CLASS } from "./inspector/chip";

export interface ExecutionTarget {
  executionGroupId: string;
  provider: string;
}

/** Agents select a stable group; its Runtime membership can change independently. */
export function ExecutionTargetSelect({ wsId, value, onChange, compact = false, canEdit = true, ownerId, agentId, legacyRuntimeId }: {
  wsId: string;
  value: ExecutionTarget;
  onChange: (target: ExecutionTarget) => void | Promise<void>;
  compact?: boolean;
  canEdit?: boolean;
  ownerId?: string | null;
  agentId?: string;
  legacyRuntimeId?: string | null;
}) {
  const { t } = useT("agents");
  const currentUserId = useAuthStore((state) => state.user?.id);
  const agentOwnerId = (ownerId === undefined ? currentUserId : ownerId) ?? "local";
  const labelId = useId();
  const [open, setOpen] = useState(false);
  const query = useQuery({ ...executionGroupListOptions(wsId, agentId), enabled: !!wsId });
  const runtimesQuery = useQuery({ ...runtimeListOptions(wsId), enabled: !!wsId });
  const eligibleRuntimeIds = new Set((runtimesQuery.data ?? []).filter((runtime) =>
    runtime.visibility === "public" || (runtime.owner_id ?? "local") === agentOwnerId,
  ).map((runtime) => runtime.id));
  const targets = (query.data?.groups ?? []).map((group) => ({
    executionGroupId: group.id,
    provider: group.provider,
    label: group.name,
    members: group.runtime_ids.filter((id) => eligibleRuntimeIds.has(id)),
    online: group.online_runtime_count,
    legacySelected: !value.executionGroupId && !!legacyRuntimeId && group.runtime_ids.includes(legacyRuntimeId) && group.provider === value.provider,
  }));
  const selected = targets.find((target) =>
    (target.executionGroupId === value.executionGroupId && target.provider === value.provider) || target.legacySelected,
  );
  const visibleTargets = targets.filter((target) => target.members.length > 0 || target === selected);
  const label = selected?.label ?? (value.executionGroupId || legacyRuntimeId
    ? t(($) => $.execution_target.unavailable)
    : t(($) => $.execution_target.placeholder));
  const isLoading = query.isLoading || runtimesQuery.isLoading;
  const isError = query.isError || runtimesQuery.isError;
  const status = isLoading ? t(($) => $.execution_target.loading)
    : isError ? t(($) => $.execution_target.error)
    : selected && selected.members.length === 0 ? t(($) => $.execution_target.unavailable)
    : selected && legacyRuntimeId ? t(($) => $.execution_target.pinned, { runtime: legacyRuntimeId })
    : selected ? selected.online > 0 ? t(($) => $.execution_target.hint, { target: selected.label })
      : t(($) => $.execution_target.offline)
    : value.executionGroupId || legacyRuntimeId ? label
    : visibleTargets.length === 0 ? t(($) => $.execution_target.empty) : label;
  const choose = (target: ExecutionTarget) => {
    setOpen(false);
    if (legacyRuntimeId || target.executionGroupId !== value.executionGroupId || target.provider !== value.provider) {
      void onChange({ executionGroupId: target.executionGroupId, provider: target.provider });
    }
  };
  const selectedTooltip = selected && selected.label !== selected.executionGroupId
    ? `${status}\n${selected.executionGroupId}` : status;
  const options = visibleTargets.map((target) => (
    <PickerItem key={`${target.executionGroupId}:${target.provider}`} selected={target === selected} disabled={target.members.length === 0} onClick={() => choose(target)}>
      <ProviderLogo provider={target.provider} className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{target.label}</span>
        {target.label !== target.executionGroupId && (
          <span className="block truncate font-mono text-[10px] text-muted-foreground" title={target.executionGroupId}>
            {target.executionGroupId}
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{t(($) => $.execution_target.members, { online: target.online, count: target.members.length })}</span>
    </PickerItem>
  ));
  if (!canEdit) return <span className="min-w-0 truncate px-1.5 text-xs" title={selectedTooltip}>{label}</span>;
  if (compact) return (
    <PropertyPicker open={open} onOpenChange={setOpen} width="w-auto min-w-[16rem] max-w-md" align="start"
      tooltip={selectedTooltip} triggerRender={<button type="button" className={CHIP_CLASS} aria-label={t(($) => $.execution_target.label)} />}
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
