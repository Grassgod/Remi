"use client";

import { X } from "lucide-react";
import { isModelExecutionUnknown, isModelUnavailable, useExecutionTargetModels } from "@multiremi/core/runtimes";
import { PropRow } from "../../../common/prop-row";
import { useT } from "../../../i18n";
import { ThinkingPicker } from "./thinking-picker";
import { getModelThinking, getModelThinkingLevels } from "./thinking-levels";
import { ThinkingStatus } from "./thinking-status";

// The catalog is scoped to the selected machine and Runtime type.
export function ThinkingPropRow({
  wsId,
  runtimeId,
  executionGroupId,
  agentId,
  provider,
  model,
  value,
  canEdit,
  onChange,
  label,
}: {
  wsId: string;
  runtimeId?: string | null;
  executionGroupId?: string | null;
  agentId?: string;
  provider: string;
  model: string;
  value: string;
  canEdit: boolean;
  onChange: (next: string) => Promise<void> | void;
  label?: string;
}) {
  const { t } = useT("agents");
  const { models, modelCatalogStatus, defaultThinking, isLoading, isError } = useExecutionTargetModels(wsId, provider, runtimeId, executionGroupId, agentId);

  const executionUnknown = isModelExecutionUnknown(provider, model, models, modelCatalogStatus);
  const unavailable = isModelUnavailable(provider, model, models, modelCatalogStatus);
  const levels = getModelThinkingLevels(models, model, defaultThinking);
  const thinking = getModelThinking(models, model, defaultThinking);
  const loadFailed = isError || thinking?.status === "error";
  if (levels.length === 0 && !value) {
    if (provider !== "claude" && provider !== "codex") return null;
    return (
      <PropRow label={label ?? t(($) => $.inspector.prop_thinking)} interactive={false}>
        <ThinkingStatus modelUnavailable={unavailable} modelExecutionUnknown={executionUnknown} thinking={thinking} isLoading={isLoading} isError={isError} />
      </PropRow>
    );
  }

  // A saved effort with no selectable level is the stale-orphan state: the
  // model either declares no reasoning levels at all or the gateway never
  // reported any (Claude's /v1/models carries no effort field). Neither is
  // selectable, so mounting an editable picker with an empty list leaves the
  // user staring at a control that can't do anything. Show what is persisted
  // and keep the clear affordance — the server ignores the stale value and
  // drops `thinking_level` on the next save. A failed load is excluded: that
  // verdict is not authoritative, so it keeps the picker plus its status line.
  if (levels.length === 0 && !loadFailed) {
    return (
      <PropRow label={label ?? t(($) => $.inspector.prop_thinking)} interactive={false}>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <span
            className="min-w-0 truncate px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            title={value}
          >
            {value}
          </span>
          {canEdit && (
            <button
              type="button"
              onClick={() => void onChange("")}
              className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t(($) => $.pickers.thinking_clear_title)}
              aria-label={t(($) => $.pickers.thinking_clear_title)}
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <ThinkingStatus modelUnavailable={unavailable} modelExecutionUnknown={executionUnknown} thinking={thinking} isLoading={isLoading} isError={isError} />
        </div>
      </PropRow>
    );
  }

  return (
    <PropRow label={label ?? t(($) => $.inspector.prop_thinking)} interactive={false}>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
      <ThinkingPicker
        value={value}
        levels={levels}
        canEdit={canEdit && !unavailable && !executionUnknown}
        onChange={onChange}
      />
      {(thinking || levels.length === 0) && <ThinkingStatus modelUnavailable={unavailable} modelExecutionUnknown={executionUnknown} thinking={thinking} isLoading={isLoading} isError={isError} />}
      </div>
    </PropRow>
  );
}
