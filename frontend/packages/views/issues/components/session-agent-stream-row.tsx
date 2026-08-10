"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Loader2, XCircle } from "lucide-react";
import { api } from "@multiremi/core/api";
import { issueKeys } from "@multiremi/core/issues/queries";
import { taskMessagesOptions } from "@multiremi/core/chat/queries";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TaskMessagePayload } from "@multiremi/core/types/events";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { cn } from "@multiremi/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { LIVE_TIMER, formatElapsedSince } from "../../common/format";
import { AgentTranscriptDialog, buildTimeline } from "../../common/task-transcript";
import { formatToolInputSummary, toolIcon } from "../../common/task-transcript/tool-summaries";
import { useT } from "../../i18n";

const ACTIVE_STATUS = new Set(["queued", "dispatched", "waiting_local_directory", "running"]);
const FAILED_STATUS = new Set(["failed", "cancelled"]);

/**
 * The "agent is working" row at the foot of a session's comment stream. It
 * exists because the stream itself shows nothing between the trigger comment
 * and the reply — the only progress signal used to be the pinned card above the
 * timeline.
 *
 * Sourced from the issue's task list (the same cache the execution log fills,
 * refreshed by the `["issues","tasks"]` WS invalidation) and narrowed to this
 * session. A task with no session linkage is never guessed at: it shows nothing.
 */
export function SessionAgentStreamRow({ issueId, issueSessionId }: { issueId: string; issueSessionId: string }) {
  const { data: tasks = [] } = useQuery({
    queryKey: issueKeys.tasks(issueId),
    queryFn: () => api.listTasksByIssue(issueId),
    staleTime: 30_000,
  });

  const sessionTasks = useMemo(
    () => tasks.filter((task) => Boolean(issueSessionId) && task.issue_session_id === issueSessionId),
    [tasks, issueSessionId],
  );
  const activeTasks = useMemo(() => sessionTasks.filter((task) => ACTIVE_STATUS.has(task.status)), [sessionTasks]);

  // A run we watched must not vanish without a trace when it ends badly: a
  // completed run is replaced by its reply comment, but a failed or cancelled
  // one produces no comment at all. Remember what we showed as active, and keep
  // those rows in a muted failure state. Runs that already failed before this
  // stream was opened stay out — the execution log is where history lives.
  const watched = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const task of activeTasks) watched.current.add(task.id);
  }, [activeTasks]);

  const rows = useMemo(
    () => [
      ...activeTasks,
      ...sessionTasks.filter((task) => FAILED_STATUS.has(task.status) && watched.current.has(task.id)),
    ],
    [activeTasks, sessionTasks],
  );

  if (rows.length === 0) return null;
  return (
    <div className="space-y-1 pb-2">
      {rows.map((task) => (
        <AgentStreamRow key={task.id} task={task} />
      ))}
    </div>
  );
}

function AgentStreamRow({ task }: { task: AgentTask }) {
  const { t } = useT("issues");
  const { getActorName } = useActorName();
  const [elapsed, setElapsed] = useState("");
  const [open, setOpen] = useState(false);
  const ended = FAILED_STATUS.has(task.status);
  const isQueued = task.status === "queued";
  const isWaitingLocalDirectory = task.status === "waiting_local_directory";
  const isDispatched = task.status === "dispatched";
  const isParked = isQueued || isWaitingLocalDirectory;
  const agentName = task.agent_id ? getActorName("agent", task.agent_id) : t(($) => $.agent_live.fallback_name);

  const { data: messages } = useQuery(taskMessagesOptions(task.id));
  const items = useMemo(
    () => (messages ? buildTimeline(messages as TaskMessagePayload[]) : []),
    [messages],
  );

  // The step the agent is on right now — the last tool call to start.
  const currentStep = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.type === "tool_use") return item;
    }
    return null;
  }, [items]);

  useEffect(() => {
    if (ended) return;
    const startRef = task.started_at ?? task.dispatched_at ?? task.created_at;
    if (!startRef) return;
    const tick = () => setElapsed(formatElapsedSince(startRef, Date.now(), LIVE_TIMER));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [ended, task.started_at, task.dispatched_at, task.created_at]);

  const StepIcon = toolIcon(currentStep?.tool);
  const stepSummary = currentStep ? formatToolInputSummary(currentStep.tool ?? "", currentStep.input) : "";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent/40"
      >
        {task.agent_id ? (
          <ActorAvatar actorType="agent" actorId={task.agent_id} size={20} />
        ) : null}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-xs">
            {ended ? (
              <XCircle className="h-3 w-3 shrink-0 text-destructive" />
            ) : isParked ? (
              <Clock className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-info" />
            )}
            <span className={cn("truncate font-medium", ended ? "text-muted-foreground" : "text-foreground")}>
              {task.status === "cancelled"
                ? t(($) => $.agent_stream.cancelled, { name: agentName })
                : task.status === "failed"
                  ? t(($) => $.agent_stream.failed, { name: agentName })
                  : isQueued
                    ? t(($) => $.agent_live.is_queued, { name: agentName })
                    : isWaitingLocalDirectory
                      ? t(($) => $.agent_live.is_waiting_local_directory, { name: agentName })
                      : isDispatched
                        ? t(($) => $.agent_live.is_starting, { name: agentName })
                        : t(($) => $.agent_live.is_working, { name: agentName })}
            </span>
            {!ended && elapsed && (
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {isParked ? t(($) => $.agent_live.queued_elapsed_prefix, { elapsed }) : elapsed}
              </span>
            )}
          </span>
          {!ended && stepSummary && (
            <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
              <StepIcon className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">{stepSummary}</span>
            </span>
          )}
        </span>
      </button>
      <AgentTranscriptDialog
        open={open}
        onOpenChange={setOpen}
        task={task}
        items={items}
        agentName={agentName}
        isLive={task.status === "running"}
      />
    </>
  );
}
