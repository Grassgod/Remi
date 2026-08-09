"use client";

import { useEffect, useId, useState } from "react";
import { LoaderCircle, Pencil } from "lucide-react";
import { useUpdateWorkspaceRepository } from "@multiremi/core/repositories";
import type { WorkspaceRepository } from "@multiremi/core/types";
import { isImeComposing } from "@multiremi/core/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import { Label } from "@multiremi/ui/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multiremi/ui/components/ui/popover";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { cn } from "@multiremi/ui/lib/utils";
import { toast } from "sonner";
import { useT } from "../i18n";

const MAX_DESCRIPTION_LENGTH = 200;

export function RepositoryDescriptionEditor({
  workspaceId,
  repository,
  canManage,
}: {
  workspaceId: string;
  repository: WorkspaceRepository;
  canManage: boolean;
}) {
  const { t } = useT("repositories");
  const updateRepository = useUpdateWorkspaceRepository(workspaceId);
  const textareaId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(repository.description ?? "");

  useEffect(() => {
    if (open) setDraft(repository.description ?? "");
  }, [open, repository.description]);

  if (!canManage) {
    return (
      <div
        className="truncate text-xs text-muted-foreground"
        title={repository.description ?? undefined}
      >
        {repository.description || "--"}
      </div>
    );
  }

  const normalizedDraft = draft.trim();
  const currentDescription = repository.description ?? "";
  const dirty = normalizedDraft !== currentDescription;

  const save = async () => {
    if (!dirty || updateRepository.isPending) return;
    try {
      await updateRepository.mutateAsync({
        repositoryId: repository.id,
        input: { description: normalizedDraft || null },
      });
      toast.success(t(($) => $.toast.description_updated));
      setOpen(false);
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t(($) => $.toast.description_update_failed),
      );
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && updateRepository.isPending) return;
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t(($) => $.description_editor.action_aria, {
              name: repository.name,
            })}
            className="group/description flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        }
      >
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            !repository.description && "italic text-muted-foreground/70",
          )}
          title={repository.description ?? undefined}
        >
          {repository.description || t(($) => $.description_editor.add)}
        </span>
        <Pencil className="size-3 shrink-0 opacity-0 transition-opacity group-hover/description:opacity-100 group-focus-visible/description:opacity-100 [@media(hover:none)]:opacity-100" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        positionerClassName="z-60"
        className="w-80 p-3"
      >
        <div className="flex flex-col gap-2.5">
          <Label htmlFor={textareaId} className="text-xs">
            {t(($) => $.description_editor.title)}
          </Label>
          <Textarea
            id={textareaId}
            autoFocus
            rows={3}
            maxLength={MAX_DESCRIPTION_LENGTH}
            value={draft}
            placeholder={t(($) => $.description_editor.placeholder)}
            className="min-h-20 resize-none text-xs"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                if (!updateRepository.isPending) setOpen(false);
                return;
              }
              if (isImeComposing(event)) return;
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {draft.length}/{MAX_DESCRIPTION_LENGTH}
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={updateRepository.isPending}
                onClick={() => setOpen(false)}
              >
                {t(($) => $.description_editor.cancel)}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!dirty || updateRepository.isPending}
                onClick={() => void save()}
              >
                {updateRepository.isPending && (
                  <LoaderCircle className="size-3.5 animate-spin" />
                )}
                {t(($) => $.description_editor.save)}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
