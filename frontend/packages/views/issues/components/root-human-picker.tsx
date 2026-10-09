"use client";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import { useT } from "../../i18n";

export function RootHumanPicker({ value, onChange, disabled = false, defaultSelf = false, automation = false, onClear, emptyLabel }: { value: string | null; onChange: (id: string) => void; disabled?: boolean; defaultSelf?: boolean; automation?: boolean; onClear?: () => void; emptyLabel?: string }) {
  const wsId = useWorkspaceId();
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  const userId = useAuthStore(s => s.user?.id);
  const available = members;
  const ownMemberId = available.find(member => member.user_id === userId)?.id;
  useEffect(() => { if (defaultSelf && !value && ownMemberId) onChange(ownMemberId); }, [defaultSelf, value, ownMemberId, onChange]);
  const { t } = useT("issues");
  return <label className="flex min-w-0 flex-col gap-1 text-xs"><span>{t($ => $.responsibility.human)}</span>
    <select className="h-8 min-w-0 rounded border bg-background px-2" aria-label={t($ => $.responsibility.human)} value={value ?? ""} disabled={disabled} onChange={e => e.target.value ? onChange(e.target.value) : onClear?.()}>
      <option value="">{emptyLabel ?? t($ => $.responsibility.select)}</option>
      {available.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
    </select>
    {automation && !value && <span className="text-muted-foreground">{t($ => $.responsibility.automation_hint)}</span>}
  </label>;
}
