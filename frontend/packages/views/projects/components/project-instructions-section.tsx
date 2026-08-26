"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, Pencil, Save } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multiremi/ui/components/ui/tabs";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { cn } from "@multiremi/ui/lib/utils";
import { ReadonlyContent } from "../../editor";
import { useT } from "../../i18n";
import { useFormatRelativeDate } from "./labels";

export const PROJECT_INSTRUCTIONS_MAX_LENGTH = 4000;

interface ProjectInstructionsSectionProps {
  instructions: string;
  deltaInstructions?: string;
  revision: number;
  updatedAt: string | null;
  updatedByName?: string;
  editable: boolean;
  onSave: (instructions: string, deltaInstructions: string, expectedRevision: number) => Promise<void>;
}

export function ProjectInstructionsSection({
  instructions,
  deltaInstructions = "",
  revision,
  updatedAt,
  updatedByName,
  editable,
  onSave,
}: ProjectInstructionsSectionProps) {
  const { t } = useT("projects");
  const formatRelativeDate = useFormatRelativeDate();
  const [open, setOpen] = useState(false);
  const hasInstructions = instructions.trim() || deltaInstructions.trim();

  return (
    <section>
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 text-xs font-medium">{t(($) => $.instructions.title)}</h3>
        {editable && (
          <Button type="button" variant="ghost" size="sm" className="h-6 shrink-0 gap-1 px-1.5 text-xs text-muted-foreground" onClick={() => setOpen(true)}>
            <Pencil className="size-3" />
            {t(($) => $.instructions.edit)}
          </Button>
        )}
      </div>

      <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{t(($) => $.instructions.summary)}</p>

      {hasInstructions ? (
        <div className="space-y-2">
          {instructions.trim() && <InstructionsPreview content={instructions} />}
          {deltaInstructions.trim() && (
            <p className="text-[11px] text-muted-foreground">
              {t(($) => $.instructions.delta_configured, { count: [...deltaInstructions].length })}
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs italic text-muted-foreground/70">{t(($) => $.instructions.empty)}</p>
      )}

      {updatedAt && (
        <p className="mt-2 truncate text-[11px] text-muted-foreground/80">
          {updatedByName
            ? t(($) => $.instructions.updated_by, { when: formatRelativeDate(updatedAt), name: updatedByName })
            : t(($) => $.instructions.updated, { when: formatRelativeDate(updatedAt) })}
        </p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          {open && (
            <ProjectInstructionsEditor
              initialBootstrap={instructions}
              initialDelta={deltaInstructions}
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

// Collapsed height of the sidebar preview, in px. ~6 lines at the compact
// 12px/1.6 rhythm — enough to show a heading plus the first bullets.
const PREVIEW_COLLAPSED_HEIGHT = 112;

// Slack below the clamp before the toggle appears. Without it a block that
// overshoots by a couple of pixels (a trailing margin) offers an "expand"
// that visibly reveals nothing.
const PREVIEW_OVERFLOW_SLACK = 12;

/**
 * Markdown preview that clamps to a fixed height with a fade-out, rather than
 * cutting the content mid-element. The toggle only renders when the content
 * actually overflows, so short instructions look no different from before.
 */
function InstructionsPreview({ content }: { content: string }) {
  const { t } = useT("projects");
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Markdown height is not knowable until it renders (and shifts again when
  // the sidebar is resized or a Mermaid/KaTeX block settles), so measure the
  // unclamped inner element instead of guessing from the source length.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => {
      setOverflowing(el.scrollHeight > PREVIEW_COLLAPSED_HEIGHT + PREVIEW_OVERFLOW_SLACK);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [content]);

  const clamped = overflowing && !expanded;

  return (
    <div>
      <div
        className="relative overflow-hidden"
        style={clamped ? { maxHeight: PREVIEW_COLLAPSED_HEIGHT } : undefined}
      >
        {/* The clamp lives on the wrapper so this element keeps its full
            scrollHeight for the measurement above. */}
        <div ref={contentRef}>
          <ReadonlyContent content={content} density="compact" className="text-muted-foreground" />
        </div>
        {clamped && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-background"
          />
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          className="mt-1 flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? t(($) => $.instructions.collapse) : t(($) => $.instructions.expand)}
          <ChevronDown className={cn("size-3 transition-transform", expanded && "rotate-180")} />
        </button>
      )}
    </div>
  );
}

function ProjectInstructionsEditor({
  initialBootstrap,
  initialDelta,
  initialRevision,
  onSave,
  onClose,
}: {
  initialBootstrap: string;
  initialDelta: string;
  initialRevision: number;
  onSave: (instructions: string, deltaInstructions: string, expectedRevision: number) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useT("projects");
  const baseBootstrapRef = useRef(initialBootstrap);
  const baseDeltaRef = useRef(initialDelta);
  const baseRevisionRef = useRef(initialRevision);
  const [bootstrap, setBootstrap] = useState(baseBootstrapRef.current);
  const [delta, setDelta] = useState(baseDeltaRef.current);
  const [saving, setSaving] = useState(false);
  const bootstrapLength = [...bootstrap].length;
  const deltaLength = [...delta].length;
  const overLimit = bootstrapLength > PROJECT_INSTRUCTIONS_MAX_LENGTH || deltaLength > PROJECT_INSTRUCTIONS_MAX_LENGTH;
  const dirty = bootstrap !== baseBootstrapRef.current || delta !== baseDeltaRef.current;

  const commit = async () => {
    const nextBootstrap = bootstrap.trimEnd();
    const nextDelta = delta.trimEnd();
    if (overLimit) return;
    if (nextBootstrap === baseBootstrapRef.current && nextDelta === baseDeltaRef.current) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await onSave(nextBootstrap, nextDelta, baseRevisionRef.current);
      toast.success(t(($) => $.instructions.saved_toast));
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(t(($) => $.instructions.revision_conflict));
      } else {
        toast.error(error instanceof Error && error.message ? error.message : t(($) => $.instructions.save_failed));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(($) => $.instructions.dialog_title)}</DialogTitle>
        <DialogDescription>{t(($) => $.instructions.dialog_description)}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          {t(($) => $.instructions.inheritance_notice)}
        </div>
        <div className="flex items-start gap-2 text-xs leading-relaxed text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{t(($) => $.instructions.secret_warning)}</span>
        </div>

        <Tabs defaultValue="bootstrap">
          <TabsList>
            <TabsTrigger value="bootstrap">{t(($) => $.instructions.bootstrap_tab)}</TabsTrigger>
            <TabsTrigger value="delta">{t(($) => $.instructions.delta_tab)}</TabsTrigger>
          </TabsList>
          <ProjectPromptEditor
            tab="bootstrap"
            label={t(($) => $.instructions.bootstrap_label)}
            hint={t(($) => $.instructions.bootstrap_hint)}
            value={bootstrap}
            onChange={setBootstrap}
            placeholder={t(($) => $.instructions.bootstrap_placeholder)}
            disabled={saving}
          />
          <ProjectPromptEditor
            tab="delta"
            label={t(($) => $.instructions.delta_label)}
            hint={t(($) => $.instructions.delta_hint)}
            value={delta}
            onChange={setDelta}
            placeholder={t(($) => $.instructions.delta_placeholder)}
            disabled={saving}
          />
        </Tabs>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onClose}>{t(($) => $.instructions.cancel)}</Button>
        <Button type="button" size="sm" disabled={saving || overLimit || !dirty} onClick={() => void commit()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {t(($) => $.instructions.save)}
        </Button>
      </DialogFooter>
    </>
  );
}

function ProjectPromptEditor({
  tab,
  label,
  hint,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  tab: string;
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
}) {
  const { t } = useT("projects");
  const length = [...value].length;
  const overLimit = length > PROJECT_INSTRUCTIONS_MAX_LENGTH;
  return (
    <TabsContent value={tab} className="mt-4 space-y-3">
      <div>
        <label htmlFor={`project-${tab}-prompt`} className="text-xs font-medium">{label}</label>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Textarea
        id={`project-${tab}-prompt`}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={overLimit}
        className={cn("min-h-64 max-h-[50vh] resize-y font-mono text-xs leading-relaxed", overLimit && "border-destructive")}
      />
      <p className={cn("text-right text-xs tabular-nums text-muted-foreground", overLimit && "text-destructive")}>
        {t(($) => $.instructions.character_count, { count: length, max: PROJECT_INSTRUCTIONS_MAX_LENGTH })}
      </p>
    </TabsContent>
  );
}
