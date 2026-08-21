import { describe, expect, it } from "vitest";
import {
  canRunAutopilotFromDashboard,
  getCompatibleAutopilotExecutionModes,
  getCompatibleConfigurableTriggerKinds,
  isAutopilotTriggerCompatible,
  reconcileExecutionModeForTriggerKind,
  reconcileTriggerKindForExecutionMode,
} from "./compatibility";

describe("Autopilot trigger compatibility", () => {
  it("only allows system events to supply trigger-Issue context", () => {
    expect(getCompatibleConfigurableTriggerKinds("trigger_issue")).toEqual([
      "system_event",
    ]);
    expect(getCompatibleConfigurableTriggerKinds("create_issue")).toEqual([
      "schedule",
      "scm_event",
      "webhook",
    ]);
    expect(getCompatibleConfigurableTriggerKinds("run_only")).toEqual([
      "schedule",
      "scm_event",
      "webhook",
    ]);
  });

  it("keeps API triggers compatible with an explicit target Issue", () => {
    expect(isAutopilotTriggerCompatible("trigger_issue", "api")).toBe(true);
    expect(getCompatibleAutopilotExecutionModes(["api"])).toEqual([
      "create_issue",
      "trigger_issue",
      "run_only",
    ]);
  });

  it("hides dashboard Run now when the UI cannot provide a target Issue", () => {
    expect(canRunAutopilotFromDashboard("trigger_issue")).toBe(false);
    expect(canRunAutopilotFromDashboard("create_issue")).toBe(true);
    expect(canRunAutopilotFromDashboard("run_only")).toBe(true);
  });

  it("intersects execution modes across every existing trigger", () => {
    expect(getCompatibleAutopilotExecutionModes(["schedule", "webhook"])).toEqual([
      "create_issue",
      "run_only",
    ]);
    expect(getCompatibleAutopilotExecutionModes(["scm_event"])).toEqual([
      "create_issue",
      "run_only",
    ]);
    expect(getCompatibleAutopilotExecutionModes(["system_event"])).toEqual([
      "trigger_issue",
    ]);
    expect(getCompatibleAutopilotExecutionModes(["system_event", "schedule"])).toEqual([]);
  });

  it("reconciles both sides when creating an Autopilot", () => {
    expect(reconcileTriggerKindForExecutionMode("trigger_issue", "schedule")).toBe(
      "system_event",
    );
    expect(reconcileTriggerKindForExecutionMode("run_only", "system_event")).toBe(
      "schedule",
    );
    expect(reconcileExecutionModeForTriggerKind("system_event", "create_issue")).toBe(
      "trigger_issue",
    );
    expect(reconcileExecutionModeForTriggerKind("webhook", "trigger_issue")).toBe(
      "create_issue",
    );
  });
});
