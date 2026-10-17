/**
 * Test double for replicas that share one Web Lock: several browser tabs, or
 * several session logs on one page (the floating chat over an Issue detail).
 * The first replica to ask takes the lock and leads; the rest follow over a
 * BroadcastChannel stand-in that, like the real one, reaches every other
 * channel of the same name (in this page too) asynchronously.
 */
import type { BrowserReplicaEnv } from "./browser";

export function sharedTabsEnv(): BrowserReplicaEnv {
  const channels = new Map<string, Set<SharedChannel>>();
  class SharedChannel {
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(readonly name: string) {
      const peers = channels.get(name) ?? new Set<SharedChannel>();
      peers.add(this);
      channels.set(name, peers);
    }
    postMessage(message: unknown): void {
      for (const peer of channels.get(this.name) ?? []) {
        if (peer === this) continue;
        const data = structuredClone(message);
        setTimeout(() => peer.onmessage?.({ data } as MessageEvent), 0);
      }
    }
    close(): void { channels.get(this.name)?.delete(this); }
  }
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const locks = {
    request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const run = () => {
          held.add(name);
          void Promise.resolve().then(callback).then(resolve, reject).finally(() => {
            held.delete(name);
            waiting.get(name)?.shift()?.();
          });
        };
        if (!held.has(name)) { run(); return; }
        const queue = waiting.get(name) ?? [];
        queue.push(run);
        waiting.set(name, queue);
        options.signal?.addEventListener("abort", () => {
          const index = queue.indexOf(run);
          if (index >= 0) queue.splice(index, 1);
          reject(new DOMException("The request was aborted", "AbortError"));
        });
      });
    },
  } as unknown as LockManager;
  return { hasOpfs: true, locks, broadcastChannel: SharedChannel as unknown as new (name: string) => BroadcastChannel };
}
