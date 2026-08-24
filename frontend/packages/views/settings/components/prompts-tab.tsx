"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, FileLock2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import type { WorkspacePromptSettings } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@multiremi/ui/components/ui/tabs";
import { copyText } from "@multiremi/ui/lib/clipboard";
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
  const [templateOpen, setTemplateOpen] = useState(false);
  const template = useQuery({
    queryKey: ["workspace-prompt-template", workspaceId],
    queryFn: () => api.getWorkspacePromptTemplate(workspaceId),
    enabled: templateOpen && Boolean(workspaceId),
  });
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

      <div className="flex flex-wrap items-start gap-3 border-y py-4">
        <FileLock2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t(($) => $.prompts.system_title)}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t(($) => $.prompts.system_description)}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setTemplateOpen(true)}>
          <Eye className="size-3.5" />
          {t(($) => $.prompts.view_template)}
        </Button>
      </div>

      <PromptTemplateDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        template={template.data ?? null}
        loading={template.isPending}
        failed={template.isError}
        onRetry={() => void template.refetch()}
      />

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

function PromptTemplateDialog({
  open,
  onOpenChange,
  template,
  loading,
  failed,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  template: { bootstrap: string; delta: string } | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useT("settings");
  const [mode, setMode] = useState<"bootstrap" | "delta">("bootstrap");
  const [copiedMode, setCopiedMode] = useState<"bootstrap" | "delta" | null>(null);
  const prompt = template?.[mode] ?? "";
  const unavailable = failed || (!loading && !prompt);

  async function copyPrompt() {
    if (!prompt) return;
    if (await copyText(prompt)) {
      setCopiedMode(mode);
      setTimeout(() => setCopiedMode(null), 1_500);
    } else {
      toast.error(t(($) => $.prompts.copy_failed));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(80vh,48rem)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:!max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t(($) => $.prompts.template_title)}</DialogTitle>
          <DialogDescription>{t(($) => $.prompts.template_description)}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex min-h-0 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : unavailable ? (
          <div className="flex min-h-0 flex-col items-center justify-center gap-3">
            <p className="text-sm text-destructive">{t(($) => $.prompts.template_load_failed)}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>{t(($) => $.prompts.retry)}</Button>
          </div>
        ) : (
          <Tabs
            value={mode}
            onValueChange={(value) => setMode(value === "delta" ? "delta" : "bootstrap")}
            className="min-h-0 overflow-hidden"
          >
            <div className="flex items-center justify-between gap-3">
              <TabsList>
                <TabsTrigger value="bootstrap">{t(($) => $.prompts.bootstrap_tab)}</TabsTrigger>
                <TabsTrigger value="delta">{t(($) => $.prompts.delta_tab)}</TabsTrigger>
              </TabsList>
              <Button variant="outline" size="sm" onClick={() => void copyPrompt()}>
                {copiedMode === mode ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copiedMode === mode ? t(($) => $.prompts.copied) : t(($) => $.prompts.copy)}
              </Button>
            </div>
            <TabsContent value="bootstrap" className="mt-3 min-h-0 overflow-auto border-t bg-muted/30">
              <pre
                aria-label={t(($) => $.prompts.bootstrap_preview_label)}
                className="min-w-max p-4 font-mono text-xs leading-relaxed whitespace-pre"
              >
                {template?.bootstrap}
              </pre>
            </TabsContent>
            <TabsContent value="delta" className="mt-3 min-h-0 overflow-auto border-t bg-muted/30">
              <pre
                aria-label={t(($) => $.prompts.delta_preview_label)}
                className="min-w-max p-4 font-mono text-xs leading-relaxed whitespace-pre"
              >
                {template?.delta}
              </pre>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
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
