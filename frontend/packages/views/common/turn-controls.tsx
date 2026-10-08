"use client";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { turnToTask } from "@multiremi/core/api/turn-task";
import type { AgentTask } from "@multiremi/core/types";
import { TaskTraceDialog } from "./task-transcript/task-trace-dialog";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { Button } from "@multiremi/ui/components/ui/button";
import { ChevronDown, RotateCcw } from "lucide-react";
import { useT } from "../i18n";

export function TurnControls({ turnId }: { turnId: string }) {
  const [open, setOpen] = useState(false);
  const [selectedAttempt, setSelectedAttempt] = useState<AgentTask | null>(null);
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const { t } = useT("messages");
  const queryKey = ["turns", wsId, turnId, "attempts"] as const;
  const detail = useQuery({ queryKey, queryFn: () => api.getTurn(turnId, true), enabled: open });
  const retry = useMutation({ mutationFn: (cold: boolean) => api.retryTurn(turnId, cold),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["turns", wsId, turnId] });
      void qc.invalidateQueries({ queryKey: ["issues", wsId] });
      void qc.invalidateQueries({ queryKey: ["issues", "tasks"] });
      void qc.invalidateQueries({ queryKey: ["chat", wsId] });
      void qc.invalidateQueries({ queryKey: ["chat", "pending-task"] });
    } });
  const statuses = t($ => $.statuses, { returnObjects: true }) as Record<string, string>;
  const canRetry = detail.data?.turn.status === "failed" || detail.data?.turn.status === "cancelled";
  return <div className="text-xs">
    <Button variant="ghost" size="xs" aria-expanded={open} onClick={() => setOpen(v => !v)}><ChevronDown className="size-3" />{t($ => $.attempts)}</Button>
    {open && <div className="space-y-2 rounded border bg-muted/20 p-2">
      {detail.isPending ? <span>…</span> : detail.isError ? <p role="alert">{t($ => $.load_failed)}<Button size="xs" variant="ghost" onClick={() => void detail.refetch()}>{t($ => $.retry_load)}</Button></p>
        : <ol className="space-y-1">{detail.data?.attempts?.map(attempt => <li key={attempt.id} className="break-words">
          <button type="button" aria-label={`${t($ => $.attempt_logs)} #${attempt.attempt_no}`} className="text-left hover:underline" onClick={() => { if (detail.data) setSelectedAttempt(turnToTask(detail.data.turn, attempt)); }}>
            #{attempt.attempt_no} · {statuses[attempt.status] ?? attempt.status} · {attempt.execution_model ?? attempt.provider ?? "—"}
          </button>
          {attempt.id === detail.data?.turn.current_attempt_id && <span className="ml-1 text-muted-foreground">{t($ => $.current_attempt)}</span>}
          {attempt.error && <p className="text-destructive">{attempt.error}</p>}
        </li>)}</ol>}
      {canRetry && <div className="flex flex-wrap gap-1"><Button size="xs" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate(false)}><RotateCcw className="size-3" />{t($ => $.retry)}</Button>
        <Button size="xs" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate(true)}>{t($ => $.retry_cold)}</Button></div>}
      {retry.error && <p role="alert" className="text-destructive">{retry.error.message}</p>}
    </div>}
    {selectedAttempt && <TaskTraceDialog task={selectedAttempt} agentName={detail.data?.turn.agent_id ?? ""} onOpenChange={value => { if (!value) setSelectedAttempt(null); }} />}
  </div>;
}
