"use client";

import { useState } from "react";
import { CircleAlert, ScrollText } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TimelineItem } from "./build-timeline";
import { TaskTraceDialog } from "./task-trace-dialog";
import { useT } from "../../i18n";

interface TranscriptButtonProps {
  task: AgentTask;
  agentName: string;
  /** Legacy caller data is ignored: v2 traces are read from the trace endpoint. */
  items?: TimelineItem[];
  isLive?: boolean;
  className?: string;
  title?: string;
  /**
   * Optional content rendered above the transcript event list. Used to
   * surface autopilot webhook payloads inline with the run history.
   */
  headerSlot?: React.ReactNode;
}

/**
 * Compact icon-button that opens the full transcript dialog. Used on any
 * surface that lists agent tasks (issue activity card, agent detail
 * activity tab). Owns its own dialog state and lazy-load — the parent
 * just drops it in.
 */
export function TranscriptButton({ task, agentName, className, title, headerSlot }: TranscriptButtonProps) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  const active = ["dispatched", "running", "waiting_local_directory", "awaiting_human"].includes(task.status);
  const label = title ?? (active ? t(($) => $.transcript.view_live) : t(($) => $.transcript.view_finished));

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" />}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); setOpen(true); }}
          aria-label={label}
          className={cn(
            "relative flex h-11 w-11 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors md:h-7 md:w-7",
            className,
          )}
        >
          <ScrollText className="h-3.5 w-3.5" />
          {active && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-info md:right-0 md:top-0" />}
          {task.status === "failed" && <CircleAlert className="absolute right-1 top-1 h-2.5 w-2.5 text-warning" />}
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>

      {open && <TaskTraceDialog task={task} agentName={agentName} onOpenChange={setOpen} headerSlot={headerSlot} />}
    </>
  );
}
