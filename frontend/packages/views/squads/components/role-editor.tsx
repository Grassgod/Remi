"use client";

import { useEffect, useState } from "react";
import { isImeComposing } from "@multiremi/core/utils";
import { Input } from "@multiremi/ui/components/ui/input";
import { useT } from "../../i18n";

// Inline click-to-edit role line. Renders the current role as muted text;
// click (or click the placeholder when empty) to swap in an input that
// commits on blur / Enter and cancels on Escape. Avoids opening a modal
// for what is usually a one-word change.
export function RoleEditor({ value, onSave }: { value: string; onSave: (next: string) => Promise<void> }) {
  const { t } = useT("squads");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const commit = async () => {
    const next = draft.trim();
    if (next === value.trim()) { setEditing(false); return; }
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch {
      // toast handled by mutation
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <Input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (isImeComposing(e)) return;
          if (e.key === "Enter") void commit();
          else if (e.key === "Escape") { setDraft(value); setEditing(false); }
        }}
        disabled={saving}
        placeholder="Role (e.g. Reviewer)"
        className="h-6 mt-0.5 text-xs px-1.5"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="text-xs text-muted-foreground mt-0.5 text-left hover:text-foreground transition-colors"
    >
      {value || <span className="italic opacity-60">{t(($) => $.add_member_dialog.placeholder_role_inline)}</span>}
    </button>
  );
}
