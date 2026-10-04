"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { api } from "@multiremi/core/api";
import { issueKeys } from "@multiremi/core/issues/queries";
import { Dialog, DialogContent, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Button } from "@multiremi/ui/components/ui/button";
import type { SessionLogRow } from "@multiremi/core/api/schemas/session-log";
import { TaskTraceDialog } from "../../common/task-transcript/task-trace-dialog";
import { eventSummary } from "../../common/session-log/event-summary";
import { useT } from "../../i18n";
import { assignmentAuthor } from "./issue-log-presentation";

export function IssueTaskPromptDialog({ issueId, row, getActorName, onClose }: {
  issueId: string; row: SessionLogRow; getActorName: (type: string, id: string) => string; onClose: () => void;
}) {
  const { t } = useT("issues");
  // Mounted only after a click; rows share the existing issue task cache.
  const query = useQuery({ queryKey: issueKeys.tasks(issueId), queryFn: () => api.listTasksByIssue(issueId), staleTime: 30_000 });
  const task = query.data?.find(task => task.id === row.task_id);
  const author = assignmentAuthor(row);
  const authorName = author ? eventSummary(getActorName(author.type, author.id)) || t($ => $.log_event.unknown_author) : "";
  if (task) return <TaskTraceDialog task={task} agentName={eventSummary(getActorName("agent", task.agent_id))} initialView="prompt"
    headerSlot={authorName ? <span className="inline-flex rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">{t($ => $.log_event.task_author, { name: authorName })}</span> : undefined}
    onOpenChange={open => { if (!open) onClose(); }} />;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-md">
      <DialogTitle>{t($ => $.log_event.task_prompt)}</DialogTitle>
      {query.isPending ? <LoaderCircle className="size-5 animate-spin" aria-label={t($ => $.log_event.task_loading)} />
        : <div className="space-y-3 text-sm"><p>{t($ => $.log_event.task_unavailable)}</p>
          <Button variant="outline" onClick={() => void query.refetch()}>{t($ => $.log_event.task_retry)}</Button></div>}
    </DialogContent>
  </Dialog>;
}
