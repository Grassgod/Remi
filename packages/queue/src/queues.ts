/**
 * Queue name constants and typed data interfaces for BunQueue.
 */

import type { Provider } from "@shared/contracts/provider-types.js";
import type { Connector } from "@connectors/base.js";

export const QUEUES = {
  CRON: "remi:cron",
} as const;

/** remi:cron — 定时任务 */
export interface CronJobData {
  jobId: string;
  handler: string;
  handlerConfig?: Record<string, unknown>;
}

/**
 * QueueHost — the minimal structural surface the queue package needs from the
 * Remi core, declared here so the queue package does not depend on remi/core.
 * The concrete `Remi` class satisfies this shape at every call site.
 */
export interface QueueHost {
  _providers: Map<string, Provider>;
  _connectors: Connector[];
  authStore: { checkAndRefreshAll(): Promise<void> } | null;
  metrics: { fetchUsageFromAPI(): Promise<void> };
  _getProvider(name?: string | null): Provider;
}
