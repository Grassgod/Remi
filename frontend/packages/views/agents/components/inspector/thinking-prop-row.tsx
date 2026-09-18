"use client";

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
}) {
  const { t } = useT("agents");
  const { models, modelCatalogStatus, defaultThinking, isLoading, isError } = useExecutionTargetModels(wsId, provider, runtimeId, executionGroupId, agentId);

  const executionUnknown = isModelExecutionUnknown(provider, model, models, modelCatalogStatus);
  const unavailable = isModelUnavailable(provider, model, models, modelCatalogStatus);
  const levels = getModelThinkingLevels(models, model, defaultThinking);
  const thinking = getModelThinking(models, model, defaultThinking);
  if (levels.length === 0 && !value) {
    if (provider !== "claude" && provider !== "codex") return null;
    return (
      <PropRow label={t(($) => $.inspector.prop_thinking)} interactive={false}>
        <ThinkingStatus modelUnavailable={unavailable} modelExecutionUnknown={executionUnknown} thinking={thinking} isLoading={isLoading} isError={isError} />
      </PropRow>
    );
  }

  return (
    <PropRow label={t(($) => $.inspector.prop_thinking)} interactive={false}>
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
