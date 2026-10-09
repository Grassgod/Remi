"use client";

import { ArrowRightLeft } from "lucide-react";
import type { AgentTask } from "@multiremi/core/types";
import { executionModel as normalizeExecutionModel } from "@multiremi/shared/agent-execution";
import { useT } from "../../i18n";

export function ExecutionModelInfo({ task, agentModel, agentThinkingLevel, traceModel }: {
  task: AgentTask;
  agentModel?: string | null;
  agentThinkingLevel?: string | null;
  traceModel?: string | null;
}) {
  const { t } = useT("agents");
  const executionModel = [task.executionModel, task.execution_model]
    .map(normalizeExecutionModel).find(Boolean);
  const observedModel = normalizeExecutionModel(traceModel);
  const configuredModel = normalizeExecutionModel(agentModel);
  // Billing usage includes auxiliary calls such as progress summaries.
  const model = observedModel ?? executionModel ?? configuredModel;
  const switched = task.fallbackSwitched === true || task.fallback_switched === true;
  const inheritedThinking = !switched && !executionModel && model && model === configuredModel
    ? agentThinkingLevel : null;
  const snapshotMatches = !observedModel || !executionModel || observedModel === executionModel;
  const thinking = [snapshotMatches ? task.executionThinkingLevel : null,
    snapshotMatches ? task.execution_thinking_level : null, inheritedThinking]
    .find((value) => typeof value === "string" && value.trim())?.trim();
  const reason = task.switchReason ?? task.switch_reason;
  const reasonCode = typeof reason === "string" && reason.startsWith("gateway_resource:")
    ? reason.slice("gateway_resource:".length).split(";")[0] : null;
  const reasonLabel = typeof reason === "string" && reason.startsWith("gateway_resource:")
    ? reasonCode === "agent_error.model_not_found_or_unavailable"
      ? t(($) => $.fallback.reason_model_unavailable)
      : reasonCode === "agent_error.provider_server_error"
      ? t(($) => $.fallback.reason_server)
      : reasonCode === "queued_model_unavailable"
      ? t(($) => $.fallback.reason_queued)
      : reasonCode === "agent_error.provider_no_available_account"
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
