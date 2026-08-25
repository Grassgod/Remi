import type {
  MultiremiNotificationChannelKind,
  MultiremiNotificationDelivery,
  MultiremiWorkspace,
} from "@multiremi/contracts/types.js";
import type { NotificationDeliveryContext } from "@multiremi/store/repos/notification-channels-repo.js";
import { createLogger } from "@shared/logger.js";
import { buildInboxNotificationCard } from "./inbox-card.js";
import { redactNotificationError } from "./error-redaction.js";
import {
  PermanentNotificationDeliveryError,
  type OutboundNotificationSender,
} from "./types.js";

const log = createLogger("notification-dispatcher");

export type NotificationSenderRegistry = Partial<Record<MultiremiNotificationChannelKind, OutboundNotificationSender>>;

export interface NotificationDispatcherStore {
  getNotificationDeliveryContext(id: string): NotificationDeliveryContext | null;
  listPendingNotificationDeliveries(now: string, limit?: number): MultiremiNotificationDelivery[];
  claimNotificationDeliveryAttempt(
    id: string,
    expectedAttempts: number,
    maxAttempts: number,
    claimedAt: string,
    leasedUntil: string,
  ): MultiremiNotificationDelivery | null;
  markNotificationDeliverySent(id: string, expectedAttempts: number): MultiremiNotificationDelivery | null;
  markNotificationDeliveryFailed(id: string, error: string, expectedAttempts: number): MultiremiNotificationDelivery | null;
  recordNotificationDeliveryError(id: string, error: string, expectedAttempts: number): MultiremiNotificationDelivery | null;
  resetNotificationDeliveryForRetry(id: string): MultiremiNotificationDelivery | null;
  getWorkspace(id: string): MultiremiWorkspace | null;
}

export interface OutboundNotificationDispatcherOptions {
  store: NotificationDispatcherStore;
  senders?: NotificationSenderRegistry;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sweepIntervalMs?: number;
  leaseMs?: number;
  sendTimeoutMs?: number;
  publicUrl?: string | null;
}

export class OutboundNotificationDispatcher {
  private readonly store: NotificationDispatcherStore;
  private readonly senders: NotificationSenderRegistry;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sweepIntervalMs: number;
  private readonly leaseMs: number;
  private readonly sendTimeoutMs: number;
  private readonly publicUrl: string | null;
  private readonly inFlight = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: OutboundNotificationDispatcherOptions) {
    this.store = options.store;
    this.senders = {
      feishu_group: lazyFeishuGroupSender(),
      ...options.senders,
    };
    this.maxAttempts = positiveInteger(options.maxAttempts, 3);
    this.retryBaseDelayMs = positiveInteger(options.retryBaseDelayMs, 1_000);
    this.sweepIntervalMs = positiveInteger(options.sweepIntervalMs, 30_000);
    this.sendTimeoutMs = positiveInteger(options.sendTimeoutMs, 15_000);
    this.leaseMs = Math.max(positiveInteger(options.leaseMs, 30_000), this.sendTimeoutMs * 2);
    this.publicUrl = options.publicUrl?.trim() || process.env.MULTIREMI_PUBLIC_URL?.trim() || null;
  }

  start(): void {
    if (this.sweepTimer) return;
    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  async sweep(): Promise<void> {
    const pending = this.store.listPendingNotificationDeliveries(new Date().toISOString(), 100);
    await Promise.allSettled(pending.map((delivery) => this.dispatch(delivery.id)));
  }

  async dispatch(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try {
      await this.dispatchClaimed(id);
    } catch (error) {
      log.warn(`notification delivery ${id} dispatcher error: ${redactNotificationError(error)}`);
    } finally {
      this.inFlight.delete(id);
    }
  }

  retry(id: string): MultiremiNotificationDelivery | null {
    const delivery = this.store.resetNotificationDeliveryForRetry(id);
    if (delivery) queueMicrotask(() => void this.dispatch(id));
    return delivery;
  }

  private async dispatchClaimed(id: string): Promise<void> {
    const context = this.store.getNotificationDeliveryContext(id);
    if (!context || context.delivery.status !== "pending") return;
    const claimedAt = new Date();
    if (leaseIsActive(context.delivery.leasedUntil, claimedAt)) return;
    if (context.delivery.attempts >= this.maxAttempts) {
      this.store.markNotificationDeliveryFailed(
        id,
        "notification delivery retry attempts exhausted after lease expiry",
        context.delivery.attempts,
      );
      return;
    }
    if (!context.channel) {
      this.store.markNotificationDeliveryFailed(id, "notification channel not found", context.delivery.attempts);
      return;
    }
    if (!context.channel.enabled) {
      this.store.markNotificationDeliveryFailed(id, "notification channel is disabled", context.delivery.attempts);
      return;
    }
    if (!context.item) {
      this.store.markNotificationDeliveryFailed(id, "inbox item not found", context.delivery.attempts);
      return;
    }
    const sender = this.senders[context.delivery.channelKind];
    if (!sender) {
      this.store.markNotificationDeliveryFailed(
        id,
        `unsupported notification channel kind: ${context.delivery.channelKind}`,
        context.delivery.attempts,
      );
      return;
    }
    const claimedAtIso = claimedAt.toISOString();
    const claimed = this.store.claimNotificationDeliveryAttempt(
      id,
      context.delivery.attempts,
      this.maxAttempts,
      claimedAtIso,
      new Date(claimedAt.getTime() + this.leaseMs).toISOString(),
    );
    if (!claimed) return;
    const workspace = this.store.getWorkspace(context.delivery.workspaceId);
    const card = buildInboxNotificationCard({
      item: context.item,
      workspace,
      publicUrl: this.publicUrl,
    });
    try {
      await withTimeout(
        Promise.resolve().then(() => sender.send({
          chatId: context.channel!.target.chatId,
          card,
          channel: context.channel!,
          delivery: claimed,
          item: context.item!,
        })),
        this.sendTimeoutMs,
      );
      this.store.markNotificationDeliverySent(id, claimed.attempts);
    } catch (error) {
      const message = redactNotificationError(error);
      if (error instanceof PermanentNotificationDeliveryError || claimed.attempts >= this.maxAttempts) {
        this.store.markNotificationDeliveryFailed(id, message, claimed.attempts);
        return;
      }
      const recorded = this.store.recordNotificationDeliveryError(id, message, claimed.attempts);
      if (recorded) this.scheduleRetry(id, this.retryBaseDelayMs * 2 ** (claimed.attempts - 1));
    }
  }

  private scheduleRetry(id: string, delayMs: number): void {
    const existing = this.retryTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.retryTimers.delete(id);
      void this.dispatch(id);
    }, delayMs);
    timer.unref?.();
    this.retryTimers.set(id, timer);
  }
}

function lazyFeishuGroupSender(): OutboundNotificationSender {
  let sender: OutboundNotificationSender | null = null;
  return {
    async send(notification): Promise<void> {
      if (!sender) {
        const { createFeishuGroupSender } = await import("./feishu-group-sender.js");
        sender = createFeishuGroupSender();
      }
      await sender.send(notification);
    },
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function leaseIsActive(leasedUntil: string | null, now: Date): boolean {
  if (!leasedUntil) return false;
  const expiresAt = Date.parse(leasedUntil);
  return Number.isFinite(expiresAt) && expiresAt > now.getTime();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`notification send timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
