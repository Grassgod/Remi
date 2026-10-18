/**
 * Chat logs kept in memory across chat switches.
 *
 * A Chat window leases the log of the chat it shows; switching away or hiding
 * the window releases it. A released log keeps its rows (not its connection), so
 * coming back paints them at once and refreshes the tail in the background.
 *
 * The pool belongs to one `(user, workspace)` and holds nothing else: changing
 * either, or logging out, disposes every log. Released logs are bounded: at
 * most {@link CHAT_LOG_POOL_MAX_RELEASED} (the least recently released goes
 * first), none longer than {@link CHAT_LOG_POOL_TTL_MS} after release. A leased
 * log is never evicted, nor is a released one whose chat has a running turn.
 *
 * Nothing is persisted: the pool is a module-level, in-memory cache. Issue logs
 * do not use it.
 */
import type { IssueLogReplica } from "./issue-log";

/** What the pool needs from a log; `IssueLogReplica` implements it. */
export interface RetainedLog {
  /** Drop caches only a connection needs; called on release. */
  trimRetained(): void;
  /** Disconnect and drop every row; called on eviction. */
  dispose(): void;
}

export interface ChatLogLease<T extends RetainedLog> {
  readonly replica: T;
  /** Whether the log was released earlier and is shown again, rather than new. */
  readonly retained: boolean;
  release(): void;
}

export interface ChatLogPoolOptions {
  maxReleased?: number;
  ttlMs?: number;
  now?: () => number;
}

export const CHAT_LOG_POOL_MAX_RELEASED = 10;
export const CHAT_LOG_POOL_TTL_MS = 3 * 60 * 60 * 1000;

interface Entry<T> {
  replica: T;
  leased: boolean;
  /** Set once the log has been released; `retained` means it had been. */
  releasedAt: number | null;
  /** Removed from the pool while leased; disposed when released. */
  detached: boolean;
}

export class ChatLogPool<T extends RetainedLog> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly listeners = new Set<() => void>();
  private readonly maxReleased: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private scope: string | null = null;
  private busy: (sessionId: string) => boolean = () => false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ChatLogPoolOptions = {}) {
    this.maxReleased = options.maxReleased ?? CHAT_LOG_POOL_MAX_RELEASED;
    this.ttlMs = options.ttlMs ?? CHAT_LOG_POOL_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** For `useSyncExternalStore`: membership changed. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The log held for a chat, leased or not; `undefined` outside the current scope. */
  peek(scope: string, sessionId: string): T | undefined {
    return scope === this.scope ? this.entries.get(sessionId)?.replica : undefined;
  }

  /**
   * The identity the pool serves. Any change, including to `null` (logged
   * out), disposes the logs of the previous one.
   */
  setScope(scope: string | null): void {
    if (scope === this.scope) return;
    this.clear();
    this.scope = scope;
  }

  /**
   * Lease `replica` for `sessionId`: it becomes the pool's log for the chat
   * unless the pool holds another one. Returns `null` when it does, or when
   * the chat's log is leased already — a log has one connection, so a second
   * holder must use a log of its own.
   */
  acquire(scope: string, sessionId: string, replica: T): ChatLogLease<T> | null {
    this.setScope(scope);
    let entry = this.entries.get(sessionId);
    if (entry && (entry.replica !== replica || entry.leased)) return null;
    const retained = entry?.releasedAt != null;
    if (!entry) {
      entry = { replica, leased: true, releasedAt: null, detached: false };
      this.entries.set(sessionId, entry);
      this.notify();
    }
    entry.leased = true;
    const held = entry;
    let released = false;
    this.sweep();
    return {
      replica, retained,
      release: () => {
        if (released) return;
        released = true;
        held.leased = false;
        if (held.detached) { held.replica.dispose(); return; }
        held.releasedAt = this.now();
        held.replica.trimRetained();
        this.sweep();
      },
    };
  }

  /** Chats with a running turn: their released logs are not evicted. */
  setBusy(isBusy: ((sessionId: string) => boolean) | null): void {
    this.busy = isBusy ?? (() => false);
    this.sweep();
  }

  /** Dispose every released log and detach the leased ones (disposed on release). */
  clear(): void {
    if (this.entries.size === 0) return;
    for (const entry of this.entries.values()) {
      if (entry.leased) entry.detached = true;
      else entry.replica.dispose();
    }
    this.entries.clear();
    this.schedule();
    this.notify();
  }

  get size(): number { return this.entries.size; }

  /** Evict expired released logs, then the least recently released beyond the limit. */
  sweep(): void {
    const now = this.now();
    const evictable = [...this.entries].filter(([sessionId, entry]) => !entry.leased && !this.busy(sessionId));
    const evicted = new Set<string>();
    for (const [sessionId, entry] of evictable) {
      if (now - entry.releasedAt! >= this.ttlMs) evicted.add(sessionId);
    }
    const kept = evictable.filter(([sessionId]) => !evicted.has(sessionId))
      .sort(([, left], [, right]) => left.releasedAt! - right.releasedAt!);
    for (const [sessionId] of kept.slice(0, Math.max(0, kept.length - this.maxReleased))) evicted.add(sessionId);
    for (const sessionId of evicted) {
      this.entries.get(sessionId)!.replica.dispose();
      this.entries.delete(sessionId);
    }
    this.schedule();
    if (evicted.size) this.notify();
  }

  private schedule(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    let next = Infinity;
    for (const [sessionId, entry] of this.entries) {
      if (entry.leased || entry.releasedAt === null || this.busy(sessionId)) continue;
      next = Math.min(next, entry.releasedAt + this.ttlMs);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(() => { this.timer = null; this.sweep(); }, Math.max(0, next - this.now()));
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** The pool's identity for a user in a workspace; `null` until both are known. */
export function chatLogScope(userId: string | null | undefined, workspaceId: string | null | undefined): string | null {
  return userId && workspaceId ? `${userId}\u0000${workspaceId}` : null;
}

/** The page's Chat log pool. */
export const chatLogPool = new ChatLogPool<IssueLogReplica>();

/** Whether a released or leased log exists for this chat (an SSR seed is then ignored). */
export function hasPooledChatLog(userId: string | null | undefined, workspaceId: string | null | undefined, sessionId: string | null | undefined): boolean {
  const scope = chatLogScope(userId, workspaceId);
  return !!scope && !!sessionId && chatLogPool.peek(scope, sessionId) !== undefined;
}

/** Logout: no conversation content outlives the identity that read it. */
export function clearChatLogPool(): void {
  chatLogPool.setScope(null);
}
