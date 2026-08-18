import type {
  AutopilotExecutionMode,
  AutopilotTriggerKind,
} from "../types";

export type ConfigurableAutopilotTriggerKind = Exclude<
  AutopilotTriggerKind,
  "api"
>;

const CONFIGURABLE_TRIGGER_KINDS: readonly ConfigurableAutopilotTriggerKind[] = [
  "schedule",
  "system_event",
  "webhook",
];

const EXECUTION_MODES: readonly AutopilotExecutionMode[] = [
  "create_issue",
  "trigger_issue",
  "run_only",
];

/**
 * A trigger-issue run needs the triggering Issue id. System events provide it;
 * schedule and webhook triggers do not. API callers are compatible because
 * they can explicitly provide a target Issue id, even though API triggers are
 * no longer configurable in the dashboard.
 */
export function isAutopilotTriggerCompatible(
  executionMode: AutopilotExecutionMode,
  triggerKind: AutopilotTriggerKind,
): boolean {
  if (triggerKind === "api") return true;
  if (triggerKind === "system_event") return executionMode === "trigger_issue";
  return executionMode !== "trigger_issue";
}

export function getCompatibleConfigurableTriggerKinds(
  executionMode: AutopilotExecutionMode,
): readonly ConfigurableAutopilotTriggerKind[] {
  return CONFIGURABLE_TRIGGER_KINDS.filter((kind) =>
    isAutopilotTriggerCompatible(executionMode, kind),
  );
}

export function getCompatibleAutopilotExecutionModes(
  triggerKinds: readonly AutopilotTriggerKind[],
): readonly AutopilotExecutionMode[] {
  return EXECUTION_MODES.filter((mode) =>
    triggerKinds.every((kind) => isAutopilotTriggerCompatible(mode, kind)),
  );
}

export function canRunAutopilotFromDashboard(
  executionMode: AutopilotExecutionMode,
): boolean {
  return executionMode !== "trigger_issue";
}

export function reconcileTriggerKindForExecutionMode(
  executionMode: AutopilotExecutionMode,
  currentKind: ConfigurableAutopilotTriggerKind,
): ConfigurableAutopilotTriggerKind {
  if (isAutopilotTriggerCompatible(executionMode, currentKind)) return currentKind;
  return getCompatibleConfigurableTriggerKinds(executionMode)[0]!;
}

export function reconcileExecutionModeForTriggerKind(
  triggerKind: ConfigurableAutopilotTriggerKind,
  currentMode: AutopilotExecutionMode,
): AutopilotExecutionMode {
  if (isAutopilotTriggerCompatible(currentMode, triggerKind)) return currentMode;
  return triggerKind === "system_event" ? "trigger_issue" : "create_issue";
}
