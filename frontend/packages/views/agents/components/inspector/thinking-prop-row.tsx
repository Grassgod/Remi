"use client";

import { useExecutionTargetModels } from "@multiremi/core/runtimes";
import { PropRow } from "../../../common/prop-row";
import { useT } from "../../../i18n";
import { ThinkingPicker } from "./thinking-picker";
import { getModelThinkingLevels } from "./thinking-levels";

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
  const { models, isLoading, isError } = useExecutionTargetModels(wsId, provider, runtimeId, executionGroupId, agentId);

  const levels = getModelThinkingLevels(models, model);
  if (levels.length === 0 && !value) {
    if (provider !== "claude" && provider !== "codex") return null;
    return (
      <PropRow label={t(($) => $.inspector.prop_thinking)} interactive={false}>
        <span className="px-1.5 py-0.5 text-xs text-muted-foreground" role="status">
          {isLoading
            ? t(($) => $.pickers.thinking_loading)
            : isError
              ? t(($) => $.pickers.thinking_load_error)
              : t(($) => $.pickers.thinking_unknown)}
        </span>
      </PropRow>
    );
  }

  return (
    <PropRow label={t(($) => $.inspector.prop_thinking)} interactive={false}>
      <ThinkingPicker
        value={value}
        levels={levels}
        canEdit={canEdit}
        onChange={onChange}
      />
    </PropRow>
  );
}
