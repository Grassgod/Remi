"use client";

import { useRef, useState } from "react";
import { AlertTriangle, Loader2, Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@multiremi/core/api";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { cn } from "@multiremi/ui/lib/utils";
import {
  ContentEditor,
  ReadonlyContent,
  type ContentEditorRef,
} from "../../editor";
import { useT } from "../../i18n";
import { useFormatRelativeDate } from "./labels";

export const PROJECT_INSTRUCTIONS_MAX_LENGTH = 4000;

interface ProjectInstructionsSectionProps {
  instructions: string;
  revision: number;
  updatedAt: string | null;
  updatedByName?: string;
  editable: boolean;
  onSave: (instructions: string, expectedRevision: number) => Promise<void>;
}

export function ProjectInstructionsSection({
  instructions,
  revision,
  updatedAt,
  updatedByName,
  editable,
  onSave,
}: ProjectInstructionsSectionProps) {
  const { t } = useT("projects");
  const formatRelativeDate = useFormatRelativeDate();
  const [open, setOpen] = useState(false);

  return (
    <section>
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 text-xs font-medium">
          {t(($) => $.instructions.title)}
        </h3>
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground"
            onClick={() => setOpen(true)}
          >
            <Pencil className="size-3" />
            {t(($) => $.instructions.edit)}
          </Button>
        )}
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
        {t(($) => $.instructions.summary)}
      </p>

      {instructions.trim() ? (
        <div className="max-h-24 overflow-hidden">
          <ReadonlyContent
            content={instructions}
            className="text-xs leading-relaxed text-muted-foreground"
          />
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground/70">
          {t(($) => $.instructions.empty)}
        </p>
      )}

      {updatedAt && (
        <p className="mt-2 truncate text-[11px] text-muted-foreground/80">
          {updatedByName
            ? t(($) => $.instructions.updated_by, {
                when: formatRelativeDate(updatedAt),
                name: updatedByName,
              })
            : t(($) => $.instructions.updated, {
                when: formatRelativeDate(updatedAt),
              })}
        </p>
      )}

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => setOpen(nextOpen)}
      >
        <DialogContent className="sm:max-w-2xl">
          {open && (
            <ProjectInstructionsEditor
              initialValue={instructions}
              initialRevision={revision}
              onSave={onSave}
              onClose={() => setOpen(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProjectInstructionsEditor({
  initialValue,
  initialRevision,
  onSave,
  onClose,
}: {
  initialValue: string;
  initialRevision: number;
  onSave: (instructions: string, expectedRevision: number) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT("projects");
  const editorRef = useRef<ContentEditorRef>(null);
  const baseValueRef = useRef(initialValue);
  const baseRevisionRef = useRef(initialRevision);
  const [draft, setDraft] = useState(baseValueRef.current);
  const [saving, setSaving] = useState(false);
  const length = [...draft].length;
  const overLimit = length > PROJECT_INSTRUCTIONS_MAX_LENGTH;
  const dirty = draft !== baseValueRef.current;

  const commit = async () => {
    const current = (editorRef.current?.getMarkdown() ?? draft).trimEnd();
    if ([...current].length > PROJECT_INSTRUCTIONS_MAX_LENGTH) return;
    if (current === baseValueRef.current) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await onSave(current, baseRevisionRef.current);
      toast.success(t(($) => $.instructions.saved_toast));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(t(($) => $.instructions.revision_conflict));
      } else {
        toast.error(
          error instanceof Error && error.message
            ? error.message
            : t(($) => $.instructions.save_failed),
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(($) => $.instructions.dialog_title)}</DialogTitle>
        <DialogDescription>
          {t(($) => $.instructions.dialog_description)}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {t(($) => $.instructions.effect_notice)}
        </div>
        <div className="flex items-start gap-2 text-xs leading-relaxed text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t(($) => $.instructions.secret_warning)}</span>
        </div>
        <div
          className={cn(
            "min-h-64 max-h-[50vh] overflow-y-auto rounded-md border bg-background px-4 py-3 transition-colors focus-within:border-input",
            overLimit && "border-destructive focus-within:border-destructive",
          )}
          aria-invalid={overLimit}
        >
          <ContentEditor
            ref={editorRef}
            defaultValue={draft}
            onUpdate={setDraft}
            placeholder={t(($) => $.instructions.placeholder)}
            debounceMs={0}
            disableMentions
            className="min-h-56"
          />
        </div>
        <div
          className={cn(
            "text-right text-xs tabular-nums text-muted-foreground",
            length >= PROJECT_INSTRUCTIONS_MAX_LENGTH * 0.9 && "text-warning",
            overLimit && "text-destructive",
          )}
        >
          {t(($) => $.instructions.character_count, {
            count: length,
            max: PROJECT_INSTRUCTIONS_MAX_LENGTH,
          })}
        </div>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={onClose}
        >
          {t(($) => $.instructions.cancel)}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving || overLimit || !dirty}
          onClick={() => void commit()}
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          {t(($) => $.instructions.save)}
        </Button>
      </DialogFooter>
    </>
  );
}
