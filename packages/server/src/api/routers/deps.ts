import type { MultiremiScheduler } from "@multiremi/scheduler.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { MemoryWebhookRateLimiter } from "../helpers.js";

/**
 * The values `createMultiremiApp` closes over. Domain routers receive them
 * explicitly — passing this object is the only change the D3 split makes to
 * the handlers, which are otherwise moved verbatim out of the app factory.
 */
export interface RouterDeps {
  store: MultiremiStore;
  scheduler: MultiremiScheduler | null;
  authToken: string;
  webhookRateLimiter: MemoryWebhookRateLimiter;
  webhookIpRateLimiter: MemoryWebhookRateLimiter;
}
