"use client";

import { toast } from "sonner";
import { useGrantParentDone, useRevokeParentDone } from "@multiremi/core/issues/mutations";
import type { Issue, MultiremiIssueParentDoneGrant } from "@multiremi/core/types";
import { Switch } from "@multiremi/ui/components/ui/switch";
import { useT } from "../../i18n";

interface ParentDoneGrantControlProps {
  issue: Issue;
  isMember: boolean;
  hasChildren: boolean;
}

export function ParentDoneGrantControl({ issue, isMember, hasChildren }: ParentDoneGrantControlProps) {
  const grant = useGrantParentDone();
  const revoke = useRevokeParentDone();
  if (!isMember || (!hasChildren && !issue.parent_done_grant)) return null;
  const canAuthorize = issue.assignee_type === "agent"
    && issue.parent_done_grant?.ineffective_reason !== "owner_not_agent";
  const updateGrant = (checked: boolean) => {
    const options = { onError: (error: Error) => toast.error(error.message) };
    if (checked) grant.mutate(issue.id, options);
    else revoke.mutate(issue.id, options);
  };
  return (
    <ParentDoneGrantControlView
      grant={issue.parent_done_grant ?? null}
      canAuthorize={canAuthorize}
      pending={grant.isPending || revoke.isPending}
      onCheckedChange={updateGrant}
    />
  );
}

export function ParentDoneGrantControlView({
  grant,
  canAuthorize,
  pending,
  onCheckedChange,
}: {
  grant: MultiremiIssueParentDoneGrant | null;
  canAuthorize: boolean;
  pending: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useT("issues");
  const effective = grant?.effective === true;
  const state = effective ? "effective" : grant ? "ineffective" : "ungranted";
  const label = effective
    ? t(($) => $.detail.parent_done_grant_effective)
    : grant
      ? t(($) => $.detail.parent_done_grant_reauthorize)
      : t(($) => $.detail.parent_done_grant_available);
  const status = !effective && !canAuthorize
    ? t(($) => $.detail.parent_done_grant_owner_not_agent)
    : !effective && grant
      ? t(($) => $.detail.parent_done_grant_ineffective)
      : "";
  return (
    <div
      className="h-[92px] min-w-0 rounded-md border bg-muted/20 px-2.5 py-2"
      data-parent-done-grant
      data-grant-state={state}
    >
      <label className="flex h-6 min-w-0 items-center gap-2">
        <Switch
          size="sm"
          checked={effective}
          disabled={pending || (!effective && !canAuthorize)}
          aria-label={label}
          onCheckedChange={onCheckedChange}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={label}>{label}</span>
      </label>
      <div
        className="h-4 truncate text-[11px] leading-4 text-amber-700 dark:text-amber-300"
        title={status || undefined}
      >
        {status}
      </div>
      <p className="h-4 truncate text-[11px] leading-4 text-muted-foreground" title={t(($) => $.detail.parent_done_grant_summary_hint)}>
        {t(($) => $.detail.parent_done_grant_summary_hint)}
      </p>
      <p className="h-4 truncate text-[11px] leading-4 text-muted-foreground" title={t(($) => $.detail.parent_done_grant_pr_hint)}>
        {t(($) => $.detail.parent_done_grant_pr_hint)}
      </p>
    </div>
  );
}
