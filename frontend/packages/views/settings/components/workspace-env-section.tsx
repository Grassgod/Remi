"use client";

import { useState } from "react";
import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { api } from "@multiremi/core/api";
import { Button } from "@multiremi/ui/components/ui/button";
import { Card, CardContent } from "@multiremi/ui/components/ui/card";
import { Input } from "@multiremi/ui/components/ui/input";
import { toast } from "sonner";
import { useT } from "../../i18n";

// Workspace-level env for task sessions (MUL-49). Mirrors the agent env tab's
// two-phase flow: values never reach the browser until the admin explicitly
// clicks "Reveal & edit", and revealed values render as password inputs with a
// per-row eye toggle. Merge precedence at dispatch:
// agent customEnv > workspace env > daemon machine env.

let nextEnvId = 0;

interface EnvEntry {
  id: number;
  key: string;
  value: string;
  visible: boolean;
}

function envMapToEntries(env: Record<string, string>): EnvEntry[] {
  return Object.entries(env).map(([key, value]) => ({
    id: nextEnvId++,
    key,
    value,
    visible: false,
  }));
}

function entriesToEnvMap(entries: EnvEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const key = entry.key.trim();
    if (key) {
      map[key] = entry.value;
    }
  }
  return map;
}

export function WorkspaceEnvSection({ workspaceId }: { workspaceId: string }) {
  const { t } = useT("settings");

  // null = not revealed yet; [] is a legitimate empty map after reveal.
  const [revealed, setRevealed] = useState<EnvEntry[] | null>(null);
  const [originalMap, setOriginalMap] = useState<Record<string, string>>({});
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);

  const currentEnvMap = revealed ? entriesToEnvMap(revealed) : originalMap;
  const dirty =
    revealed !== null &&
    JSON.stringify(currentEnvMap) !== JSON.stringify(originalMap);

  const handleReveal = async () => {
    setRevealing(true);
    try {
      const resp = await api.getWorkspaceEnv(workspaceId);
      const env = resp.env ?? {};
      setOriginalMap(env);
      setRevealed(envMapToEntries(env));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.workspace_env.reveal_failed_toast),
      );
    } finally {
      setRevealing(false);
    }
  };

  const addEnvEntry = () => {
    setRevealed((prev) => [
      ...(prev ?? []),
      { id: nextEnvId++, key: "", value: "", visible: true },
    ]);
  };

  const removeEnvEntry = (index: number) => {
    setRevealed((prev) => (prev ?? []).filter((_, i) => i !== index));
  };

  const updateEnvEntry = (
    index: number,
    field: "key" | "value",
    val: string,
  ) => {
    setRevealed((prev) =>
      (prev ?? []).map((entry, i) =>
        i === index ? { ...entry, [field]: val } : entry,
      ),
    );
  };

  const toggleEnvVisibility = (index: number) => {
    setRevealed((prev) =>
      (prev ?? []).map((entry, i) =>
        i === index ? { ...entry, visible: !entry.visible } : entry,
      ),
    );
  };

  const handleSave = async () => {
    if (revealed === null) return;
    const keys = revealed.filter((e) => e.key.trim()).map((e) => e.key.trim());
    const uniqueKeys = new Set(keys);
    if (uniqueKeys.size < keys.length) {
      toast.error(t(($) => $.workspace_env.duplicate_keys_toast));
      return;
    }

    setSaving(true);
    try {
      const resp = await api.updateWorkspaceEnv(workspaceId, {
        env: currentEnvMap,
      });
      const env = resp.env ?? {};
      setOriginalMap(env);
      setRevealed(envMapToEntries(env));
      toast.success(t(($) => $.workspace_env.saved_toast));
    } catch (err) {
      toast.error(
        err instanceof Error && err.message
          ? err.message
          : t(($) => $.workspace_env.save_failed_toast),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t(($) => $.workspace_env.section_title)}</h2>
      </div>

      <Card>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {t(($) => $.workspace_env.section_hint)}
          </p>

          {revealed === null ? (
            <div className="flex items-start justify-between gap-3">
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Lock className="h-3.5 w-3.5" />
                {t(($) => $.workspace_env.not_revealed_hint)}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={revealing}
                onClick={handleReveal}
                className="shrink-0"
              >
                {revealing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                {revealing
                  ? t(($) => $.workspace_env.revealing)
                  : t(($) => $.workspace_env.reveal_action)}
              </Button>
            </div>
          ) : (
            <>
              {revealed.length > 0 ? (
                <div className="space-y-2">
                  {revealed.map((entry, index) => (
                    <div key={entry.id} className="flex items-center gap-2">
                      <Input
                        value={entry.key}
                        onChange={(e) => updateEnvEntry(index, "key", e.target.value)}
                        placeholder={t(($) => $.workspace_env.key_placeholder)}
                        className="w-[40%] font-mono text-xs"
                      />
                      <div className="relative flex-1">
                        <Input
                          type={entry.visible ? "text" : "password"}
                          value={entry.value}
                          onChange={(e) =>
                            updateEnvEntry(index, "value", e.target.value)
                          }
                          placeholder={t(($) => $.workspace_env.value_placeholder)}
                          className="pr-8 font-mono text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => toggleEnvVisibility(index)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          aria-label={entry.visible ? t(($) => $.workspace_env.hide_value_aria) : t(($) => $.workspace_env.show_value_aria)}
                        >
                          {entry.visible ? (
                            <EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => removeEnvEntry(index)}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label={t(($) => $.workspace_env.remove_aria)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs italic text-muted-foreground">
                  {t(($) => $.workspace_env.empty_editable)}
                </p>
              )}

              <div className="flex items-center justify-between gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addEnvEntry}
                >
                  <Plus className="h-3 w-3" />
                  {t(($) => $.workspace_env.add)}
                </Button>
                <div className="flex items-center gap-3">
                  {dirty && (
                    <span className="text-xs text-muted-foreground">
                      {t(($) => $.workspace_env.unsaved_changes)}
                    </span>
                  )}
                  <Button onClick={handleSave} disabled={!dirty || saving} size="sm">
                    {saving ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {t(($) => $.workspace_env.save)}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
