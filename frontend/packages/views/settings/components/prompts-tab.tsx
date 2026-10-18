"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Eye, FileLock2, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@multiremi/core/api";
import { useAuthStore } from "@multiremi/core/auth";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { memberListOptions } from "@multiremi/core/workspace/queries";
import type { PlatformPromptTemplatePreview, WorkspacePromptSettings } from "@multiremi/core/types";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Textarea } from "@multiremi/ui/components/ui/textarea";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { cn } from "@multiremi/ui/lib/utils";
import { useT } from "../../i18n";

/** The server's limit for the workspace's own prompt (ADR 0023). */
/** The server's limit: two former 8,000-character halves and the blank line between them. */
const MAX_LENGTH = 16_002;

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
  const [prompt, setPrompt] = useState(initial.prompt);
  const [saving, setSaving] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const template = useQuery({
    queryKey: ["workspace-prompt-template", workspaceId],
    queryFn: () => api.getWorkspacePromptTemplate(workspaceId),
    enabled: templateOpen && Boolean(workspaceId),
  });
  const dirty = prompt !== initial.prompt;
  const length = [...prompt].length;
  const overLimit = length > MAX_LENGTH;

  async function save() {
    if (!dirty || overLimit || saving || !canManage) return;
    setSaving(true);
    try {
      const next = await api.updateWorkspacePromptSettings(workspaceId, {
        prompt: prompt.trimEnd(),
        expected_revision: initial.revision,
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

      <div className="space-y-3">
        <div>
          <label htmlFor="workspace-prompt" className="text-sm font-medium">{t(($) => $.prompts.prompt_label)}</label>
          <p className="mt-1 text-xs text-muted-foreground">{t(($) => $.prompts.prompt_hint)}</p>
        </div>
        <Textarea
          id="workspace-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t(($) => $.prompts.prompt_placeholder)}
          disabled={!canManage || saving}
          aria-invalid={overLimit}
          className={cn("min-h-80 resize-y font-mono text-xs leading-relaxed", overLimit && "border-destructive")}
        />
        <p className={cn("text-right text-xs tabular-nums text-muted-foreground", overLimit && "text-destructive")}>
          {t(($) => $.prompts.character_count, { count: length, max: MAX_LENGTH })}
        </p>
      </div>

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

type TemplateBlock = "instructions" | "input";

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
  template: PlatformPromptTemplatePreview | null;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}) {
  const { t } = useT("settings");
  const [copiedBlock, setCopiedBlock] = useState<TemplateBlock | null>(null);
  const unavailable = failed || (!loading && !template?.instructions);

  async function copyBlock(block: TemplateBlock) {
    const text = template?.[block];
    if (!text) return;
    if (await copyText(text)) {
      setCopiedBlock(block);
      setTimeout(() => setCopiedBlock(null), 1_500);
    } else {
      toast.error(t(($) => $.prompts.copy_failed));
    }
  }

  const blocks: { block: TemplateBlock; title: string; hint: string; label: string }[] = [
    {
      block: "instructions",
      title: t(($) => $.prompts.template_instructions_title),
      hint: t(($) => $.prompts.template_instructions_hint),
      label: t(($) => $.prompts.template_instructions_label),
    },
    {
      block: "input",
      title: t(($) => $.prompts.template_input_title),
      hint: t(($) => $.prompts.template_input_hint),
      label: t(($) => $.prompts.template_input_label),
    },
  ];

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
        ) : unavailable || !template ? (
          <div className="flex min-h-0 flex-col items-center justify-center gap-3">
            <p className="text-sm text-destructive">{t(($) => $.prompts.template_load_failed)}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>{t(($) => $.prompts.retry)}</Button>
          </div>
        ) : (
          <div className="min-h-0 space-y-6 overflow-y-auto">
            {blocks.map(({ block, title, hint, label }) => (
              <section key={block} className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium">{title}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
                    {template.sha256[block] && (
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/80" title={template.sha256[block]}>
                        {t(($) => $.prompts.template_sha256, { hash: template.sha256[block] })}
                      </p>
                    )}
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0" onClick={() => void copyBlock(block)}>
                    {copiedBlock === block ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    {copiedBlock === block ? t(($) => $.prompts.copied) : t(($) => $.prompts.copy)}
                  </Button>
                </div>
                <div className="overflow-x-auto rounded-md border bg-muted/30">
                  <pre
                    aria-label={label}
                    className="min-w-max p-4 font-mono text-xs leading-relaxed whitespace-pre"
                  >
                    {template[block]}
                  </pre>
                </div>
              </section>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
