/**
 * The human-request event feed for the Live Hub (MUL-403 §2 item 4, MUL-400 E5).
 *
 * ## What travels here
 *
 * Four lifecycle transitions, keyed by request id: `created`, `responded`,
 * `expired`, `cancelled`. `reminder_due` deliberately does **not** come through the
 * hub (plan 2/6 §3): the bot host already derives it from `expires_at` on its own
 * timer, and routing it here would make the hub a second scheduler.
 *
 * ## Where the events come from
 *
 * `MultiremiStore.onHumanRequest` — a listener the store facade calls *at the write
 * path*, once per transition, carrying the request row and its owning workspace.
 * The obvious-looking alternative is the existing `task:*` event stream, and it is
 * wrong: `task:running` fires once per task resume, and a task resumes only when its
 * **last** pending request settles, so a task with two open requests would report
 * one transition and silently drop the other. E5 keys its cards by request id, so
 * the store publishes the request that changed.
 *
 * The store is where the mapping from its own statuses (`timeout`) to the feed's
 * names (`expired`) already happened, so this module does not restate it.
 *
 * ## Who consumes it
 *
 * Only a process with `MULTIREMI_BACKGROUND_JOBS` enabled. That is deliberately a
 * capability check rather than a hard-coded role: the flag is what says "this
 * process runs the bot host and the card writers", which is what E5 needs, and it
 * keeps a future topology from having to learn the hub's role table.
 */

import type { MultiremiTaskHumanRequest } from "@multiremi/contracts/types.js";
import { createLogger } from "@shared/logger.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import type { HumanRequestEvent, HumanRequestEventType } from "./live-hub.js";

const log = createLogger("hub-human-requests");

/**
 * The write surface this feed needs from a hub.
 *
 * Deliberately *not* part of `LiveHub`: C0 froze that interface and the
 * subscription half (`subscribeHumanRequests`) is what E5 consumes. Publishing is
 * a writer concern, so it lives on `HubImpl` and is reached through the structural
 * check below — an injected hub that cannot publish disables the feed instead of
 * failing to start.
 */
export interface HumanRequestSink {
  publishHumanRequest(event: HumanRequestEvent): void;
}

/** True when a hub can publish human-request events. */
export function isHumanRequestSink(hub: unknown): hub is HumanRequestSink {
  return Boolean(hub && typeof (hub as HumanRequestSink).publishHumanRequest === "function");
}

/** Whether this process runs the background jobs, and therefore consumes the feed. */
export function consumesHumanRequestFeed(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MULTIREMI_BACKGROUND_JOBS?.trim().toLowerCase();
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "no", "off"].includes(raw);
}

/**
 * Map a store transition onto the event E5 distinguishes.
 *
 * One function rather than a table at the call site so the two spellings
 * (`created`/`responded`/`expired`/`cancelled` on the wire) are converted exactly
 * once, and a new store status cannot reach the wire unclassified.
 */
export function humanRequestEventType(
  type: HumanRequestEventType,
): HumanRequestEventType {
  return type;
}

/** The store transition shape this feed consumes (a structural subset of it). */
export interface HumanRequestTransitionLike {
  type: HumanRequestEventType;
  request: Pick<MultiremiTaskHumanRequest, "id" | "taskId" | "createdAt" | "respondedAt">;
  workspaceId: string;
}

/** The store surface this feed needs: one listener, and the hub to publish into. */
export interface HumanRequestStoreLike {
  onHumanRequest(listener: (transition: HumanRequestTransitionLike) => void): () => void;
}

export interface HumanRequestFeedOptions {
  store: HumanRequestStoreLike;
  /** The hub to publish into; a hub without `publishHumanRequest` disables the feed. */
  hub: unknown;
  /** Whether this process consumes the feed. Defaults to reading the env flag. */
  enabled?: boolean;
  /** Injected for tests; defaults to the module logger. */
  warn?: (message: string) => void;
}

/**
 * Bridge the store's human-request transitions onto a hub.
 *
 * Returns a detach handle. A disabled feed attaches nothing, which is what makes
 * `MULTIREMI_BACKGROUND_JOBS=0` a process that does not consume: no listener, no
 * work, no events.
 */
export function attachHumanRequestFeed(options: HumanRequestFeedOptions): { detach(): void; enabled: boolean } {
  const enabled = (options.enabled ?? consumesHumanRequestFeed()) && isHumanRequestSink(options.hub);
  if (!enabled) return { detach: () => {}, enabled: false };

  const warn = options.warn ?? ((message: string) => { log.warn(message); });
  const hub = options.hub as HumanRequestSink;
  const detach = options.store.onHumanRequest((transition) => {
    const event: HumanRequestEvent = {
      type: humanRequestEventType(transition.type),
      workspace_id: transition.workspaceId,
      request_id: transition.request.id,
      task_id: transition.request.taskId,
      at: transition.request.respondedAt ?? transition.request.createdAt,
    };
    try {
      hub.publishHumanRequest(event);
    } catch (error) {
      warn(`publishing ${event.type} for ${event.request_id} failed: ${errorText(error)}`);
    }
  });
  return { enabled: true, detach };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A store the feed can attach to; narrowed so a test double need not build one. */
export type HumanRequestFeedStore = MultiremiStore;
