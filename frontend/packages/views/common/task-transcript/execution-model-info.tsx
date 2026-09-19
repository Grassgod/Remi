"use client";

import { ArrowRightLeft } from "lucide-react";
import type { AgentTask } from "@multiremi/core/types";
import { useT } from "../../i18n";

export function ExecutionModelInfo({ task, agentModel, agentThinkingLevel, usageModel }: {
  task: AgentTask;
  agentModel?: string | null;
  agentThinkingLevel?: string | null;
  usageModel?: string | null;
}) {
  const { t } = useT("agents");
  const executionModel = [task.executionModel, task.execution_model]
    .find((value) => typeof value === "string" && value.trim())?.trim();
  const model = executionModel ?? [usageModel, agentModel]
    .find((value) => typeof value === "string" && value.trim())?.trim();
  const switched = task.fallbackSwitched === true || task.fallback_switched === true;
  const inheritedThinking = !switched && !executionModel && model && model === agentModel?.trim()
    ? agentThinkingLevel : null;
  const thinking = [task.executionThinkingLevel, task.execution_thinking_level,
    inheritedThinking]
    .find((value) => typeof value === "string" && value.trim())?.trim();
  const reason = task.switchReason ?? task.switch_reason;
  const reasonLabel = typeof reason === "string" && reason.startsWith("gateway_resource:")
    ? reason.includes("provider_no_available_account")
      ? t(($) => $.fallback.reason_no_account)
      : t(($) => $.fallback.reason_gateway)
    : t(($) => $.fallback.reason_unknown);

  if ((!model && !switched) ||
    (!switched && (task.status === "queued" || task.status === "dispatched" || task.status === "waiting_local_directory"))) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {model && <span className="min-w-0 truncate" title={t(($) => $.fallback.actual_model)}>
        {t(($) => $.fallback.actual_model)}: <span className="font-mono text-foreground">{model}</span>
        {thinking && <span className="ml-1">({thinking})</span>}
      </span>}
      {switched && <span className="inline-flex items-center gap-1 text-warning" title={reasonLabel}>
        <ArrowRightLeft className="h-3 w-3 shrink-0" />
        {t(($) => $.fallback.switched)} · {reasonLabel} · {t(($) => $.fallback.switch_count, { count: 1 })}
      </span>}
    </span>
  );
}
