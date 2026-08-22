"use client";

import { useId, useState } from "react";
import { FastForward, Loader2, MessageSquarePlus } from "lucide-react";
import { api } from "@multiremi/core/api";
import type { AgentTask } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Label } from "@multiremi/ui/components/ui/label";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multiremi/ui/components/ui/tooltip";
import { toast } from "sonner";
import { useT } from "../../i18n";

type TaskSteerMode = "steer" | "force_answer";

const TERMINAL_TASK_STATUSES = new Set<AgentTask["status"]>([
  "completed",
  "failed",
  "cancelled",
]);

interface TaskSteerActionsProps {
  task: Pick<AgentTask, "id" | "status">;
  showLabels?: boolean;
}

export function TaskSteerActions({ task, showLabels = false }: TaskSteerActionsProps) {
  const { t } = useT("issues");
  const [mode, setMode] = useState<TaskSteerMode>("steer");
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fieldId = useId();

  if (TERMINAL_TASK_STATUSES.has(task.status)) return null;

  const openDialog = (nextMode: TaskSteerMode) => {
    setMode(nextMode);
    setContent("");
    setOpen(true);
  };

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (submitting || (mode === "steer" && !trimmed)) return;

    setSubmitting(true);
    try {
      await api.steerTask(
        task.id,
        mode === "force_answer"
          ? { force_answer: true, ...(trimmed ? { content: trimmed } : {}) }
          : { content: trimmed },
      );
      toast.success(
        mode === "force_answer"
          ? t(($) => $.task_steer.force_answer_sent)
          : t(($) => $.task_steer.steer_sent),
      );
      setOpen(false);
      setContent("");
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.task_steer.send_failed),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const triggerClassName = showLabels
    ? "flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted-foreground transition-colors hover:bg-info/10 hover:text-info"
    : "flex items-center justify-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground";

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => openDialog("steer")}
              aria-label={t(($) => $.task_steer.steer_button)}
            />
          }
          className={triggerClassName}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {showLabels && <span>{t(($) => $.task_steer.steer_button)}</span>}
        </TooltipTrigger>
        <TooltipContent>{t(($) => $.task_steer.steer_tooltip)}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => openDialog("force_answer")}
              aria-label={t(($) => $.task_steer.force_answer_button)}
            />
          }
          className={triggerClassName}
        >
          <FastForward className="h-3.5 w-3.5" />
          {showLabels && <span>{t(($) => $.task_steer.force_answer_button)}</span>}
        </TooltipTrigger>
        <TooltipContent>{t(($) => $.task_steer.force_answer_tooltip)}</TooltipContent>
      </Tooltip>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!submitting) setOpen(nextOpen);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {mode === "force_answer"
                ? t(($) => $.task_steer.force_answer_title)
                : t(($) => $.task_steer.steer_title)}
            </DialogTitle>
            <DialogDescription>
              {mode === "force_answer"
                ? t(($) => $.task_steer.force_answer_description)
                : t(($) => $.task_steer.steer_description)}
            </DialogDescription>
          </DialogHeader>

          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <Label htmlFor={fieldId}>
              {mode === "force_answer"
                ? t(($) => $.task_steer.force_answer_note_label)
                : t(($) => $.task_steer.steer_content_label)}
            </Label>
            <Textarea
              id={fieldId}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={
                mode === "force_answer"
                  ? t(($) => $.task_steer.force_answer_note_placeholder)
                  : t(($) => $.task_steer.steer_content_placeholder)
              }
              rows={4}
              autoFocus
              disabled={submitting}
            />

            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={submitting}
              >
                {t(($) => $.task_steer.cancel)}
              </Button>
              <Button
                type="submit"
                disabled={submitting || (mode === "steer" && !content.trim())}
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === "force_answer"
                  ? t(($) => $.task_steer.force_answer_submit)
                  : t(($) => $.task_steer.steer_submit)}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
