"use client";

import { useId, useState } from "react";
import type { AgentRuntime } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useUpdateRuntime } from "@multiremi/core/runtimes/mutations";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { Button } from "@multiremi/ui/components/ui/button";
import { toast } from "sonner";
import { useT } from "../../i18n";

export function RuntimeExecutionGroupEditor({ runtime, canEdit }: {
  runtime: AgentRuntime;
  canEdit: boolean;
}) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const fieldId = useId();
  const update = useUpdateRuntime(wsId);
  const [draft, setDraft] = useState(runtime.execution_group_id ?? "");
  const next = draft.trim() || null;
  const dirty = next !== (runtime.execution_group_id ?? null);
  const save = async () => {
    if (!dirty || update.isPending) return;
    try {
      await update.mutateAsync({ runtimeId: runtime.id, patch: { execution_group_id: next } });
      toast.success(t(($) => $.execution_group.saved));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t(($) => $.execution_group.failed));
    }
  };
  return (
    <div className="border-t pt-3">
      <Label htmlFor={fieldId} className="mb-1.5 text-[11px] text-muted-foreground">
        {t(($) => $.execution_group.label)}
      </Label>
      {canEdit ? (
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Input id={fieldId} value={draft} disabled={update.isPending}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={t(($) => $.execution_group.default)} className="min-w-0 font-mono text-xs" />
          <Button type="submit" size="sm" disabled={!dirty || update.isPending}>
            {t(($) => $.execution_group.save)}
          </Button>
        </form>
      ) : (
        <p className="truncate font-mono text-xs" title={runtime.execution_group_id ?? undefined}>
          {runtime.execution_group_id || t(($) => $.execution_group.default)}
        </p>
      )}
      {!runtime.execution_group_id && (runtime.execution_group_ids ?? []).map((groupId) => (
        <code key={groupId} className="mt-1.5 block select-text break-all font-mono text-[11px] text-muted-foreground">
          {groupId}
        </code>
      ))}
      <p className="mt-1.5 text-xs text-muted-foreground">{t(($) => $.execution_group.hint)}</p>
    </div>
  );
}
