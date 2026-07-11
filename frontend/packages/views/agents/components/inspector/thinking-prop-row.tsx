"use client";

import type { RuntimeModel } from "@multiremi/core/types";
import { useFleetProviderModels } from "@multiremi/core/runtimes";
import { PropRow } from "../../../common/prop-row";
import { useT } from "../../../i18n";
import { ThinkingPicker } from "./thinking-picker";

/**
 * Thinking row for the agent inspector. Hidden when the active model has
 * no `supported_levels` advertised AND nothing is persisted, so providers
 * that don't expose reasoning never surface an empty row. If the agent
 * already has a `thinking_level` saved (engine swap into a non-thinking
 * provider, or the fleet catalog shrank and dropped the entry),
 * we still render the row so the user can see the orphan token the
 * backend is still sending and explicit-clear it via the picker footer.
 *
 * Reuses the shared fleet-models query so it hits the same 60s cache as
 * the model picker; no extra round-trip on the inspector's hot path.
 */
export function ThinkingPropRow({
  wsId,
  provider,
  model,
  value,
  canEdit,
  onChange,
}: {
  wsId: string;
  provider: string;
  model: string;
  value: string;
  canEdit: boolean;
  onChange: (next: string) => Promise<void> | void;
}) {
  const { t } = useT("agents");
  const { models } = useFleetProviderModels(wsId, provider);

  const entry = pickModelEntry(models, model);
  const levels = entry?.thinking?.supported_levels ?? [];
  if (levels.length === 0 && !value) return null;

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

function pickModelEntry(
  models: RuntimeModel[],
  model: string,
): RuntimeModel | undefined {
  if (model) return models.find((m) => m.id === model);
  return models.find((m) => m.default) ?? models[0];
}
