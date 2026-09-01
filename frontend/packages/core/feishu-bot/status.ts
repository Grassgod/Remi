import type { FeishuBotStatus } from "../types";

/**
 * How a status should read at a glance. Kept out of the component so the
 * mapping is testable, and so the `default` branch is written once: a status a
 * newer server invents renders neutral rather than crashing the switch or
 * — worse — falling through to the green "online" tone.
 */
export type FeishuBotStatusTone = "positive" | "progress" | "warning" | "danger" | "neutral";

export function feishuBotStatusTone(status: string): FeishuBotStatusTone {
  switch (status as FeishuBotStatus) {
    case "online":
      return "positive";
    case "deploying":
    case "connecting":
      return "progress";
    // `degraded` means two Runtimes both think they host the bot, and
    // `runtime_offline` means nobody does. Both are actionable-but-not-broken,
    // so they share the amber tone with the offline case.
    case "degraded":
    case "runtime_offline":
      return "warning";
    case "failed":
      return "danger";
    case "stopped":
    case "not_configured":
      return "neutral";
    default:
      return "neutral";
  }
}

/** True while the control plane is still converging on the desired state. */
export function isFeishuBotBusy(status: string): boolean {
  return status === "deploying" || status === "connecting";
}
