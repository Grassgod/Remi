"use client";

import { useState } from "react";
import type { AgentTask } from "@multiremi/core/types/agent";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import { useTurnTrace } from "./use-task-trace";

const ACTIVE_TASK_STATUSES = new Set(["dispatched", "running", "waiting_local_directory", "awaiting_human"]);

export function TaskTraceDialog(props: TaskTraceDialogProps) {
  // Each task owns its read and transcript selection state.
  return <TaskTraceDialogView key={props.task.id} {...props} />;
}

interface TaskTraceDialogProps {
  task: AgentTask;
  agentName: string;
  onOpenChange: (open: boolean) => void;
  headerSlot?: React.ReactNode;
  promptFallback?: React.ReactNode;
  initialView?: "execution" | "prompt";
}

/**
 * The execution dialog of one attempt: reads its turn + items trace when it
 * opens (every `view=turn` page, folded by the shared reducer) and follows the
 * trace socket while the task is active. The cache is the one Chat uses, so a
 * dialog opened on a running Chat turn shares its read and its frames.
 */
function TaskTraceDialogView({
  task,
  agentName,
  onOpenChange,
  headerSlot,
  promptFallback,
  initialView,
}: TaskTraceDialogProps) {
  const [open, setOpen] = useState(true);
  const active = ACTIVE_TASK_STATUSES.has(task.status);
  const trace = useTurnTrace(task.id, { enabled: open, live: open && active, turnId: task.turn_id });
  return (
    <AgentTranscriptDialog
      open={open}
      onOpenChange={(value) => { setOpen(value); onOpenChange(value); }}
      task={task}
      turn={trace.turn}
      items={trace.items}
      agentName={agentName}
      isLive={open && active && !trace.closed && !trace.error}
      headerSlot={headerSlot}
      promptFallback={promptFallback}
      initialView={initialView}
      traceRead={trace.read}
      traceClosed={trace.closed}
      traceLoading={!trace.loaded && !trace.error}
      traceError={trace.error}
      onTraceRetry={trace.retry}
    />
  );
}
