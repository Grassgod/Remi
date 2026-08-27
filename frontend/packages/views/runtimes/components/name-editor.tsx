"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import type { AgentRuntime } from "@multiremi/core/types";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useUpdateRuntime } from "@multiremi/core/runtimes/mutations";
import { Input } from "@multiremi/ui/components/ui/input";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";

interface NameEditorProps {
  value: string;
  displayValue?: string;
  displayAs?: "span" | "h2";
  title: string;
  onSave: (value: string) => Promise<void>;
  textClassName?: string;
  inputClassName?: string;
}

export function NameEditor({
  value,
  displayValue,
  displayAs = "span",
  title,
  onSave,
  textClassName,
  inputClassName,
}: NameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const cancel = () => {
    setEditing(false);
    setDraft(value);
  };

  const save = async () => {
    if (saving.current) return;
    const next = draft.trim();
    if (!next || next === value) {
      cancel();
      return;
    }
    saving.current = true;
    setPending(true);
    try {
      await onSave(next);
      setDraft(next);
      setEditing(false);
    } catch {
      // The caller owns error reporting; keep the editor open for correction.
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  if (!editing) {
    const label =
      displayAs === "h2" ? (
        <h2 className={cn("truncate", textClassName)}>{displayValue ?? value}</h2>
      ) : (
        <span className={cn("truncate", textClassName)}>{displayValue ?? value}</span>
      );
    return (
      <>
        {label}
        <button
          type="button"
          title={title}
          aria-label={title}
          className="group shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setDraft(value);
            setEditing(true);
          }}
        >
          <Pencil className="h-3 w-3 opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        </button>
      </>
    );
  }

  return (
    <span
      className="inline-flex min-w-0"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <Input
        autoFocus
        value={draft}
        maxLength={100}
        disabled={pending}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") void save();
          else if (event.key === "Escape") cancel();
        }}
        className={cn("h-7 w-56", inputClassName)}
      />
    </span>
  );
}

export function RuntimeNameEditor({
  runtime,
  displayValue,
  compact = false,
  heading = false,
}: {
  runtime: AgentRuntime;
  displayValue?: string;
  compact?: boolean;
  heading?: boolean;
}) {
  const { t } = useT("runtimes");
  const wsId = useWorkspaceId();
  const updateRuntime = useUpdateRuntime(wsId);

  return (
    <NameEditor
      value={runtime.name}
      displayValue={displayValue}
      displayAs={heading ? "h2" : "span"}
      title={t(($) => $.detail.name_edit_hint)}
      textClassName={compact ? "text-sm font-medium" : "text-base font-semibold tracking-tight"}
      inputClassName={compact ? "w-40 text-sm font-medium" : "text-base font-semibold"}
      onSave={async (name) => {
        try {
          await updateRuntime.mutateAsync({
            runtimeId: runtime.id,
            patch: { name },
          });
          toast.success(t(($) => $.detail.name_toast_updated));
        } catch (error) {
          toast.error(
            error instanceof Error && error.message
              ? error.message
              : t(($) => $.detail.name_toast_failed),
          );
          throw error;
        }
      }}
    />
  );
}
