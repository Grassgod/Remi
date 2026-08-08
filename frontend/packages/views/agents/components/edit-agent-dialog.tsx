"use client";

import { useId, useMemo, useState } from "react";
import { Globe, Lock } from "lucide-react";
import type {
  Agent,
  AgentVisibility,
  UpdateAgentRequest,
} from "@multiremi/core/types";
import { AGENT_DESCRIPTION_MAX_LENGTH } from "@multiremi/core/agents";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useFleetProviderModels } from "@multiremi/core/runtimes";
import { isImeComposing } from "@multiremi/core/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import { Input } from "@multiremi/ui/components/ui/input";
import { Label } from "@multiremi/ui/components/ui/label";
import { useT } from "../../i18n";
import { AvatarPicker } from "./avatar-picker";
import { CharCounter } from "./char-counter";
import { EngineSelect } from "./engine-select";
import { InstructionsEditor } from "./instructions-editor";
import { ModelDropdown } from "./model-dropdown";
import { ThinkingPicker } from "./inspector/thinking-picker";

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
  const fieldId = useId();
  const nameId = `${fieldId}-name`;
  const descriptionId = `${fieldId}-description`;
  const visibilityLabelId = `${fieldId}-visibility-label`;
  const concurrencyId = `${fieldId}-concurrency`;
  const thinkingLabelId = `${fieldId}-thinking-label`;
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
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="space-y-0 border-b px-5 py-3">
          <DialogTitle className="text-base font-semibold">
            {t(($) => $.edit_dialog.title)}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs">
            {t(($) => $.edit_dialog.description)}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="min-w-0 space-y-4">
            <div className="flex items-start gap-4">
              <AvatarPicker
                value={avatarUrl}
                onChange={setAvatarUrl}
                size={64}
              />
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <Label
                    htmlFor={nameId}
                    className="text-xs text-muted-foreground"
                  >
                    {t(($) => $.create_dialog.name_label)}
                  </Label>
                  <Input
                    id={nameId}
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
                  <Label
                    htmlFor={descriptionId}
                    className="text-xs text-muted-foreground"
                  >
                    {t(($) => $.create_dialog.description_label)}
                  </Label>
                  <Input
                    id={descriptionId}
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
              <Label
                id={visibilityLabelId}
                className="text-xs text-muted-foreground"
              >
                {t(($) => $.create_dialog.visibility_label)}
              </Label>
              <div
                role="group"
                aria-labelledby={visibilityLabelId}
                className="mt-1.5 flex gap-2"
              >
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

            <EngineSelect
              wsId={wsId ?? ""}
              value={provider}
              onChange={switchEngine}
            />

            <ModelDropdown
              wsId={wsId ?? ""}
              provider={provider}
              value={model}
              onChange={setModel}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label
                  htmlFor={concurrencyId}
                  className="text-xs text-muted-foreground"
                >
                  {t(($) => $.inspector.prop_concurrency)}
                </Label>
                <Input
                  id={concurrencyId}
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
                  <Label
                    id={thinkingLabelId}
                    className="text-xs text-muted-foreground"
                  >
                    {t(($) => $.inspector.prop_thinking)}
                  </Label>
                  {/* No input frame around the picker: only the chip is
                      clickable, and a border made the whole row look like a
                      form control that ignores clicks. The chip carries its
                      own hover affordance (CHIP_CLASS); the h-9 wrapper only
                      keeps the baseline aligned with the concurrency input. */}
                  <div
                    role="group"
                    aria-labelledby={thinkingLabelId}
                    className="mt-1 flex h-9 items-center"
                  >
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

        <DialogFooter className="m-0 shrink-0 rounded-b-xl border-t bg-muted/30 px-5 py-3">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t(($) => $.edit_dialog.cancel)}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSave || saving}>
            {saving
              ? t(($) => $.edit_dialog.saving)
              : t(($) => $.edit_dialog.save)}
          </Button>
        </DialogFooter>
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
  const { t } = useT("agents");
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
        <div className="font-medium">{t(($) => $.visibility[value].label)}</div>
        <div className="text-xs text-muted-foreground">
          {t(($) => $.visibility[value].description)}
        </div>
      </div>
    </button>
  );
}
