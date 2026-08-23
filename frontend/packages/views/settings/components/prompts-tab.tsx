"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileLock2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import type { WorkspacePromptSettings } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multiremi/ui/components/ui/tabs";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";

const MAX_LENGTH = 8_000;

export function PromptsTab() {
  const { t } = useT("settings");
  const workspaceId = useWorkspaceId();
  const queryClient = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const members = useQuery(memberListOptions(workspaceId));
  const prompts = useQuery({
    queryKey: ["workspace-prompt-settings", workspaceId],
    queryFn: () => api.getWorkspacePromptSettings(workspaceId),
    enabled: Boolean(workspaceId),
  });
  const currentMember = members.data?.find((member) => member.user_id === user?.id) ?? null;
  const canManage = currentMember?.role === "owner" || currentMember?.role === "admin";

  if (prompts.isPending) {
    return <div className="flex min-h-40 items-center justify-center"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  }
  if (prompts.isError) {
    return (
      <div className="space-y-3 py-6">
        <p className="text-sm text-destructive">{t(($) => $.prompts.load_failed)}</p>
        <Button variant="outline" size="sm" onClick={() => void prompts.refetch()}>{t(($) => $.prompts.retry)}</Button>
      </div>
    );
  }

  return (
    <PromptSettingsEditor
      key={prompts.data.revision}
      workspaceId={workspaceId}
      initial={prompts.data}
      canManage={canManage}
      onSaved={(next) => queryClient.setQueryData(["workspace-prompt-settings", workspaceId], next)}
    />
  );
}

function PromptSettingsEditor({
  workspaceId,
  initial,
  canManage,
  onSaved,
}: {
  workspaceId: string;
  initial: WorkspacePromptSettings;
  canManage: boolean;
  onSaved: (next: WorkspacePromptSettings) => unknown;
}) {
  const { t } = useT("settings");
  const [bootstrapPrompt, setBootstrapPrompt] = useState(initial.bootstrapPrompt);
  const [deltaPrompt, setDeltaPrompt] = useState(initial.deltaPrompt);
  const [saving, setSaving] = useState(false);
  const dirty = bootstrapPrompt !== initial.bootstrapPrompt || deltaPrompt !== initial.deltaPrompt;
  const overLimit = [...bootstrapPrompt].length > MAX_LENGTH || [...deltaPrompt].length > MAX_LENGTH;

  async function save() {
    if (!dirty || overLimit || saving || !canManage) return;
    setSaving(true);
    try {
      const next = await api.updateWorkspacePromptSettings(workspaceId, {
        bootstrapPrompt: bootstrapPrompt.trimEnd(),
        deltaPrompt: deltaPrompt.trimEnd(),
        expectedRevision: initial.revision,
      });
      onSaved(next);
      toast.success(t(($) => $.prompts.saved));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(t(($) => $.prompts.revision_conflict));
      } else {
        toast.error(error instanceof Error ? error.message : t(($) => $.prompts.save_failed));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">{t(($) => $.prompts.title)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t(($) => $.prompts.description)}</p>
      </div>

      <div className="flex items-start gap-3 border-y py-4">
        <FileLock2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">{t(($) => $.prompts.system_title)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t(($) => $.prompts.system_description)}</p>
        </div>
      </div>

      <Tabs defaultValue="bootstrap">
        <TabsList>
          <TabsTrigger value="bootstrap">{t(($) => $.prompts.bootstrap_tab)}</TabsTrigger>
          <TabsTrigger value="delta">{t(($) => $.prompts.delta_tab)}</TabsTrigger>
        </TabsList>
        <PromptEditor
          value="bootstrap"
          prompt={bootstrapPrompt}
          onChange={setBootstrapPrompt}
          label={t(($) => $.prompts.bootstrap_label)}
          hint={t(($) => $.prompts.bootstrap_hint)}
          placeholder={t(($) => $.prompts.bootstrap_placeholder)}
          disabled={!canManage || saving}
        />
        <PromptEditor
          value="delta"
          prompt={deltaPrompt}
          onChange={setDeltaPrompt}
          label={t(($) => $.prompts.delta_label)}
          hint={t(($) => $.prompts.delta_hint)}
          placeholder={t(($) => $.prompts.delta_placeholder)}
          disabled={!canManage || saving}
        />
      </Tabs>

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        <p className="text-xs text-muted-foreground">
          {canManage ? t(($) => $.prompts.scope_hint) : t(($) => $.prompts.read_only)}
        </p>
        <Button size="sm" disabled={!canManage || !dirty || overLimit || saving} onClick={() => void save()}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
          {saving ? t(($) => $.prompts.saving) : t(($) => $.prompts.save)}
        </Button>
      </div>
    </div>
  );
}

function PromptEditor({
  value,
  prompt,
  onChange,
  label,
  hint,
  placeholder,
  disabled,
}: {
  value: string;
  prompt: string;
  onChange: (value: string) => void;
  label: string;
  hint: string;
  placeholder: string;
  disabled: boolean;
}) {
  const { t } = useT("settings");
  const length = [...prompt].length;
  const overLimit = length > MAX_LENGTH;
  return (
    <TabsContent value={value} className="mt-5 space-y-3">
      <div>
        <label htmlFor={`workspace-${value}-prompt`} className="text-sm font-medium">{label}</label>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </div>
      <Textarea
        id={`workspace-${value}-prompt`}
        value={prompt}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={overLimit}
        className={cn("min-h-80 resize-y font-mono text-xs leading-relaxed", overLimit && "border-destructive")}
      />
      <p className={cn("text-right text-xs tabular-nums text-muted-foreground", overLimit && "text-destructive")}>
        {t(($) => $.prompts.character_count, { count: length, max: MAX_LENGTH })}
      </p>
    </TabsContent>
  );
}
