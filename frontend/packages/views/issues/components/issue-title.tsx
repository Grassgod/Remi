"use client";

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { issueKeys } from "@multiremi/core/issues/queries";
import type { Issue, UpdateIssueRequest } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { useT } from "../../i18n";
import { AppLink } from "../../navigation";

export function IssueTitle({ issue, onUpdateField }: { issue: Issue; onUpdateField: (patch: Partial<UpdateIssueRequest>) => void }) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const paths = useWorkspacePaths();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [retitling, setRetitling] = useState(false);
  const updateCachedTitle = useCallback((title: string) => {
    queryClient.setQueryData<Issue>(issueKeys.detail(wsId, issue.id), current => current ? { ...current, title } : current);
    void queryClient.invalidateQueries({ queryKey: issueKeys.all(wsId) });
  }, [queryClient, wsId, issue.id]);
  const undo = async (title: string) => {
    try { await api.patchIssue(issue.id, { title }); updateCachedTitle(title); toast.success(t($ => $.detail.retitle_undo_success)); }
    catch (error) { toast.error(error instanceof Error ? error.message : t($ => $.detail.retitle_undo_failed)); }
  };
  const retitle = async () => {
    setRetitling(true);
    try {
      const result = await api.retitleIssue(issue.id);
      if (result.reason === "kept") { toast.success(t($ => $.detail.retitle_kept)); return; }
      if (!result.applied || !result.title) { toast.error(t($ => $.detail.retitle_failed)); return; }
      updateCachedTitle(result.title);
      toast.success(t($ => $.detail.retitle_success, { from: result.previous_title, to: result.title }), {
        action: { label: t($ => $.detail.retitle_undo), onClick: () => void undo(result.previous_title) },
      });
    } catch (error) { toast.error(error instanceof Error ? error.message : t($ => $.detail.retitle_failed)); }
    finally { setRetitling(false); }
  };
  return <div className="flex min-w-0 flex-1 items-center gap-1" data-issue-title>
    <AppLink href={paths.issueDetail(issue.id)} className="shrink-0 font-medium">{issue.identifier}</AppLink>
    {editing ? <input autoFocus aria-label={t($ => $.detail.title_placeholder)} defaultValue={issue.title}
      className="min-w-0 flex-1 bg-transparent px-1 outline-none" onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = issue.title; event.currentTarget.blur(); } }}
      onBlur={event => { const title = event.currentTarget.value.trim(); if (title && title !== issue.title) onUpdateField({ title }); setEditing(false); }} />
      : <button type="button" title={issue.title} className="min-w-0 truncate text-left font-medium" onClick={() => setEditing(true)}>{issue.title}</button>}
    <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t($ => $.detail.retitle_aria)} disabled={retitling} onClick={() => void retitle()}>
      {retitling ? <Loader2 className="animate-spin" /> : <Sparkles />}
    </Button>} /><TooltipContent>{t($ => $.detail.retitle_aria)}</TooltipContent></Tooltip>
  </div>;
}
