"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { ContentEditor } from "../../../editor/content-editor";
import type { Squad } from "@multiremi/core/types";
import { useT } from "../../../i18n";

// Instructions tab body — mirrors agent's InstructionsTab. ContentEditor +
// Save button. The squad leader's prompt picks these up at task claim time
// (server/internal/handler/daemon.go).
export function SquadInstructionsTab({
  squad,
  onSave,
  onDirtyChange,
}: {
  squad: Squad;
  onSave: (instructions: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useT("squads");
  const [value, setValue] = useState(squad.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const isDirty = value !== (squad.instructions ?? "");

  useEffect(() => {
    setValue(squad.instructions ?? "");
  }, [squad.id, squad.instructions]);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(value);
    } catch {
      // toast handled by parent
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        {t(($) => $.instructions_tab.description)}
      </p>

      <div className="flex-1 min-h-0 overflow-y-auto rounded-md border bg-background px-4 py-3 transition-colors focus-within:border-input">
        <ContentEditor
          key={squad.id}
          defaultValue={value}
          onUpdate={setValue}
          placeholder="e.g. Always start by writing a failing test. Prefer small, atomic commits."
          debounceMs={150}
          disableMentions
          className="min-h-full"
        />
      </div>

      <div className="flex items-center justify-end gap-3">
        {isDirty && (
          <span className="text-xs text-muted-foreground">{t(($) => $.instructions_tab.unsaved_changes)}</span>
        )}
        <Button size="sm" onClick={handleSave} disabled={!isDirty || saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {t(($) => $.instructions_tab.save_button)}
        </Button>
      </div>
    </div>
  );
}
