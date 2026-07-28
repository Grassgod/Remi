"use client";

import { useMemo, useState } from "react";
import { Globe, Lock } from "lucide-react";
import type {
  Agent,
  AgentVisibility,
  UpdateAgentRequest,
} from "@multiremi/core/types";
import {
  AGENT_DESCRIPTION_MAX_LENGTH,
  VISIBILITY_DESCRIPTION,
  VISIBILITY_LABEL,
} from "@multiremi/core/agents";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useFleetProviderModels } from "@multiremi/core/runtimes";
import { isImeComposing } from "@multiremi/core/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { ProviderLogo } from "../../runtimes/components/provider-logo";
import { useT } from "../../i18n";
import { AvatarPicker } from "./avatar-picker";
import { CharCounter } from "./char-counter";
import { InstructionsEditor } from "./instructions-editor";
import { ModelDropdown } from "./model-dropdown";
import { ThinkingPicker } from "./inspector/thinking-picker";

const ENGINES = ["claude", "codex"] as const;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 50;

export function EditAgentDialog({
  agent,
  onClose,
  onSave,
}: {
  agent: Agent;
  onClose: () => void;
  onSave: (data: UpdateAgentRequest) => Promise<void>;
}) {
  const { t } = useT("agents");
  const wsId = useWorkspaceId();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    agent.avatar_url ?? null,
  );
  const [provider, setProvider] = useState(agent.provider || "claude");
  const [model, setModel] = useState(agent.model ?? "");
  const [thinkingLevel, setThinkingLevel] = useState(
    agent.thinking_level ?? "",
  );
  const [visibility, setVisibility] = useState<AgentVisibility>(
    agent.visibility,
  );
  const [maxConcurrency, setMaxConcurrency] = useState(
    String(agent.max_concurrent_tasks),
  );
  const [instructions, setInstructions] = useState(agent.instructions ?? "");
  const [saving, setSaving] = useState(false);

  const fleet = useFleetProviderModels(wsId ?? "", provider);
  const thinkingLevels = useMemo(() => {
    const selected = model
      ? fleet.models.find((entry) => entry.id === model)
      : fleet.models.find((entry) => entry.default) ?? fleet.models[0];
    return selected?.thinking?.supported_levels ?? [];
  }, [fleet.models, model]);

  const concurrency = Number(maxConcurrency);
  const validConcurrency =
    Number.isInteger(concurrency) &&
    concurrency >= MIN_CONCURRENCY &&
    concurrency <= MAX_CONCURRENCY;
  const canSave =
    name.trim().length > 0 &&
    [...description].length <= AGENT_DESCRIPTION_MAX_LENGTH &&
    validConcurrency;

  const switchEngine = (next: string) => {
    if (next === provider) return;
    setProvider(next);
    setModel("");
    setThinkingLevel("");
  };

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        avatar_url: avatarUrl ?? "",
        provider,
        model: model.trim(),
        thinking_level: thinkingLevel,
        visibility,
        max_concurrent_tasks: concurrency,
        instructions,
      });
      onClose();
    } catch {
      // The parent owns the API error toast so list and detail surfaces use
      // the same wording and cache rollback behavior.
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex !h-[85vh] !w-full !max-w-2xl !-translate-x-1/2 !-translate-y-1/2 !left-1/2 !top-1/2 flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-0 border-b px-5 py-3">
          <DialogTitle className="text-base font-semibold">
            {t(($) => $.edit_dialog.title)}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            {t(($) => $.edit_dialog.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="min-w-0 space-y-4">
            <div className="flex items-start gap-4">
              <AvatarPicker
                value={avatarUrl}
                onChange={setAvatarUrl}
                size={64}
              />
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t(($) => $.create_dialog.name_label)}
                  </Label>
                  <Input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t(($) => $.create_dialog.name_placeholder)}
                    className="mt-1"
                    onKeyDown={(event) => {
                      if (isImeComposing(event)) return;
                      if (event.key === "Enter") void submit();
                    }}
                  />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t(($) => $.create_dialog.description_label)}
                  </Label>
                  <Input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t(($) => $.create_dialog.description_placeholder)}
                    className="mt-1"
                  />
                  <div className="mt-1">
                    <CharCounter
                      length={[...description].length}
                      max={AGENT_DESCRIPTION_MAX_LENGTH}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">
                {t(($) => $.create_dialog.visibility_label)}
              </Label>
              <div className="mt-1.5 flex gap-2">
                <VisibilityOption
                  value="workspace"
                  selected={visibility === "workspace"}
                  onSelect={setVisibility}
                />
                <VisibilityOption
                  value="private"
                  selected={visibility === "private"}
                  onSelect={setVisibility}
                />
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">
                {t(($) => $.create_dialog.engine_label)}
              </Label>
              <div className="mt-1.5 flex gap-2">
                {ENGINES.map((engine) => (
                  <button
                    key={engine}
                    type="button"
                    onClick={() => switchEngine(engine)}
                    className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                      provider === engine
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted"
                    }`}
                  >
                    <ProviderLogo
                      provider={engine}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="font-medium capitalize">{engine}</span>
                  </button>
                ))}
              </div>
              {!fleet.isLoading && fleet.onlineRuntimeCount === 0 && (
                <p className="mt-1.5 text-xs text-warning">
                  {t(($) => $.create_dialog.engine_no_capacity)}
                </p>
              )}
            </div>

            <ModelDropdown
              wsId={wsId ?? ""}
              provider={provider}
              value={model}
              onChange={setModel}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="text-xs text-muted-foreground">
                  {t(($) => $.inspector.prop_concurrency)}
                </Label>
                <Input
                  type="number"
                  min={MIN_CONCURRENCY}
                  max={MAX_CONCURRENCY}
                  value={maxConcurrency}
                  onChange={(event) => setMaxConcurrency(event.target.value)}
                  className="mt-1 font-mono"
                />
                {!validConcurrency && (
                  <p className="mt-1 text-xs text-destructive">
                    {t(($) => $.pickers.concurrency_range, {
                      min: MIN_CONCURRENCY,
                      max: MAX_CONCURRENCY,
                    })}
                  </p>
                )}
              </div>

              {(thinkingLevels.length > 0 || thinkingLevel) && (
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {t(($) => $.inspector.prop_thinking)}
                  </Label>
                  <div className="mt-1 flex h-9 items-center rounded-md border px-2">
                    <ThinkingPicker
                      value={thinkingLevel}
                      levels={thinkingLevels}
                      onChange={setThinkingLevel}
                    />
                  </div>
                </div>
              )}
            </div>

            <InstructionsEditor
              value={instructions}
              onChange={setInstructions}
              placeholder={t(($) => $.edit_dialog.instructions_placeholder)}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t bg-background px-5 py-3">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t(($) => $.edit_dialog.cancel)}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSave || saving}>
            {saving
              ? t(($) => $.edit_dialog.saving)
              : t(($) => $.edit_dialog.save)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VisibilityOption({
  value,
  selected,
  onSelect,
}: {
  value: AgentVisibility;
  selected: boolean;
  onSelect: (value: AgentVisibility) => void;
}) {
  const Icon = value === "workspace" ? Globe : Lock;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex flex-1 items-center gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="text-left">
        <div className="font-medium">{VISIBILITY_LABEL[value]}</div>
        <div className="text-xs text-muted-foreground">
          {VISIBILITY_DESCRIPTION[value]}
        </div>
      </div>
    </button>
  );
}
