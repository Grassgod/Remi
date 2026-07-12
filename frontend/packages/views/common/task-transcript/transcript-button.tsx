"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ScrollText } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import { api } from "@multiremi/core/api";
import { chatKeys } from "@multiremi/core/chat/queries";
import { useTaskScopeSubscription } from "@multiremi/core/realtime";
import type { AgentTask } from "@multiremi/core/types/agent";
import type { TaskMessagePayload } from "@multiremi/core/types/events";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import { buildTimeline, type TimelineItem } from "./build-timeline";

interface TranscriptButtonProps {
  task: AgentTask;
  agentName: string;
  /**
   * Pre-loaded timeline. When provided the button skips the fetch and opens
   * the dialog immediately — used by the live card where `items` already
   * accumulate via WS. Omit for terminal tasks; the button will fetch via
   * `api.listTaskMessages` on the first click and cache the result.
   */
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
export function TranscriptButton({
  task,
  agentName,
  items: providedItems,
  isLive = false,
  className,
  title = "View transcript",
  headerSlot,
}: TranscriptButtonProps) {
  const [open, setOpen] = useState(false);

  // When the parent doesn't own the timeline, read from the shared
  // ["task-messages", id] query cache. use-realtime-sync writes every WS
  // task:message frame into that key, so an open dialog updates live without a
  // manual refetch. Chat tasks additionally need a scope subscription; issue
  // tasks ride the workspace-wide broadcast.
  const useQueryCache = providedItems === undefined;
  const { data: liveMessages, isFetching } = useQuery({
    queryKey: chatKeys.taskMessages(task.id),
    queryFn: () => api.listTaskMessages(task.id),
    enabled: open && useQueryCache,
    staleTime: Infinity,
  });
  const loading = isFetching && !liveMessages;
  useTaskScopeSubscription(task.id, open && useQueryCache);

  const liveItems = useMemo(
    () => (liveMessages ? buildTimeline(liveMessages as TaskMessagePayload[]) : undefined),
    [liveMessages],
  );
  const items = providedItems ?? liveItems ?? [];

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    },
    [],
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={<button type="button" />}
          onClick={handleClick}
          disabled={loading}
          aria-label={title}
          className={cn(
            "flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-50",
            className,
          )}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ScrollText className="h-3.5 w-3.5" />
          )}
        </TooltipTrigger>
        <TooltipContent>{title}</TooltipContent>
      </Tooltip>

      {open && (
        <AgentTranscriptDialog
          open={open}
          onOpenChange={setOpen}
          task={task}
          items={items}
          agentName={agentName}
          isLive={isLive}
          headerSlot={headerSlot}
        />
      )}
    </>
  );
}
