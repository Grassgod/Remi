/**
 * In-process event bus. Handlers publish domain events (issue.created, etc.);
 * the realtime Hub subscribes per workspace and fans them out to connected WS
 * clients, which invalidate their TanStack Query caches. Mirrors the Go
 * events.Bus + realtime.Hub split (single-node; a Redis relay is a later
 * optimization for multi-node, exactly as the Go side documents).
 */

export interface BusEvent {
  /** Event type, e.g. "issue.created", "issue.updated", "comment.created". */
  type: string;
  /** Workspace the event belongs to (subscribers are keyed on this). */
  workspaceId: string;
  /** Arbitrary payload (usually { id } so the client invalidates by key). */
  payload?: Record<string, unknown>;
}

export type BusHandler = (e: BusEvent) => void;

export class EventBus {
  private readonly subs = new Map<string, Set<BusHandler>>();

  /** Subscribe to a workspace's events. Returns an unsubscribe function. */
  subscribe(workspaceId: string, handler: BusHandler): () => void {
    let set = this.subs.get(workspaceId);
    if (!set) {
      set = new Set();
      this.subs.set(workspaceId, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.subs.delete(workspaceId);
    };
  }

  publish(e: BusEvent): void {
    const set = this.subs.get(e.workspaceId);
    if (!set) return;
    // Snapshot so a handler that unsubscribes mid-fanout can't skip siblings.
    for (const h of [...set]) {
      try {
        h(e);
      } catch {
        /* a bad subscriber must not break the fanout */
      }
    }
  }

  /** Number of subscribers for a workspace (test/introspection helper). */
  subscriberCount(workspaceId: string): number {
    return this.subs.get(workspaceId)?.size ?? 0;
  }
}

/** Process-wide bus (single-node). */
export const bus = new EventBus();
