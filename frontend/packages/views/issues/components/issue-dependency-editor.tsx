"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Plus, X } from "lucide-react";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { issueDependenciesOptions, issueKeys } from "@multiremi/core/issues/queries";
import type { Issue } from "@multiremi/core/types";
import { useT } from "../../i18n";
import { IssuePickerModal } from "../../modals/issue-picker-modal";

export function IssueDependencyEditor({ issue }: { issue: Issue }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const { data: dependencies = [] } = useQuery(issueDependenciesOptions(wsId, issue.id));
  const blockedBy = dependencies.filter((dependency) => dependency.direction === "blocked_by");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [ancestorIds, setAncestorIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: issueKeys.dependencies(wsId, issue.id) }),
      queryClient.invalidateQueries({ queryKey: issueKeys.detail(wsId, issue.id) }),
      ...(issue.parent_issue_id ? [queryClient.invalidateQueries({ queryKey: issueKeys.children(wsId, issue.parent_issue_id) })] : []),
    ]);
  };

  const openPicker = async () => {
    setError("");
    const ids: string[] = [];
    let parentId = issue.parent_issue_id;
    while (parentId && !ids.includes(parentId)) {
      ids.push(parentId);
      try {
        const parent = await queryClient.fetchQuery({ queryKey: issueKeys.detail(wsId, parentId), queryFn: () => api.getIssue(parentId!) });
        parentId = parent.parent_issue_id;
      } catch {
        break;
      }
    }
    setAncestorIds(ids);
    setPickerOpen(true);
  };

  const add = async (dependsOnIssueId: string) => {
    setPending(true);
    setError("");
    try {
      await api.addIssueDependency(issue.id, dependsOnIssueId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(($) => $.detail.dependency_update_failed));
    } finally {
      setPending(false);
    }
  };

  const remove = async (dependencyId: string) => {
    setPending(true);
    setError("");
    try {
      await api.removeIssueDependency(issue.id, dependencyId);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t(($) => $.detail.dependency_update_failed));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="min-w-0">
      <div className="flex min-h-[29px] flex-wrap items-center gap-1">
        {blockedBy.map((dependency) => {
          const prerequisite = dependency.depends_on_issue;
          return (
            <span key={dependency.id} className="inline-flex h-[22px] max-w-full items-center gap-1 rounded bg-amber-100 px-1.5 text-[11px] text-amber-900 dark:bg-amber-950 dark:text-amber-300">
              <Link2 className="size-3 shrink-0" />
              <span className="truncate">{prerequisite?.identifier ?? dependency.depends_on_issue_id}</span>
              <button type="button" disabled={pending} onClick={() => void remove(dependency.id)} aria-label={t(($) => $.detail.remove_dependency, { key: prerequisite?.identifier ?? dependency.depends_on_issue_id })}>
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <button type="button" disabled={pending} onClick={() => void openPicker()} className="inline-flex h-[22px] items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" aria-label={t(($) => $.detail.add_dependency)}>
          <Plus className="size-3.5" />
          {blockedBy.length === 0 && t(($) => $.detail.add_dependency)}
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
      <IssuePickerModal
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        title={t(($) => $.detail.add_dependency)}
        description={t(($) => $.detail.dependency_picker_description)}
        excludeIds={[issue.id, ...ancestorIds, ...blockedBy.map((dependency) => dependency.depends_on_issue_id)]}
        onSelect={(selected) => void add(selected.id)}
      />
    </div>
  );
}
