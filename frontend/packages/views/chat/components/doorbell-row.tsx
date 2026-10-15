"use client";

import type { BackgroundTaskDoorbellMetadata } from "@multiremi/contracts/unified-model";
import { cn } from "@multiremi/ui/lib/utils";
import { CircleCheck, CircleX } from "lucide-react";
import { useT } from "../../i18n";
import { backgroundTaskName } from "../lib/background-tasks";
import { useOpenBackgroundTasks } from "./background-task-view";

// The doorbell (PR 6 §2.5, §8.1): the platform `status` message a parked
// task's end writes to the agent, waking it. Chat shows it as one compact
// centered line, not a bubble, so the self-started reply that follows reads
// as the answer to it: 「后台任务 {{name}} 已完成 · 查看」.

export function DoorbellRow({ doorbell, sessionId }: { doorbell: BackgroundTaskDoorbellMetadata; sessionId: string | null }) {
  const { t } = useT("chat");
  const openTasks = useOpenBackgroundTasks(sessionId);
  const name = backgroundTaskName({ name: doorbell.name, command: null, task_id: doorbell.task_id });
  const done = doorbell.status === "completed";
  const text = done ? t(($) => $.bg_tasks.doorbell_done, { name }) : t(($) => $.bg_tasks.doorbell_failed, { name });
  const Icon = done ? CircleCheck : CircleX;
  return (
    <div data-doorbell={doorbell.task_id} data-doorbell-status={doorbell.status} className="flex justify-center py-1">
      <div className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className={cn("size-3.5 shrink-0", !done && "text-destructive/80")} aria-hidden="true" />
        <span className="min-w-0 truncate" title={text}>{text}</span>
        <span aria-hidden="true">·</span>
        <button type="button" data-doorbell-open
          onClick={() => openTasks({ task_id: doorbell.task_id, provider_session_id: doorbell.provider_session_id })}
          className="shrink-0 rounded font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
          {t(($) => $.bg_tasks.view_details)}
        </button>
      </div>
    </div>
  );
}
