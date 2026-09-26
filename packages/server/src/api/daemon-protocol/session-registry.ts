/**
 * Daemon-level session registry for protocol v2 (MUL-417).
 *
 * v1 keyed its registry by runtime (`Map<runtimeId, Set<socket>>`) because each
 * socket served exactly one runtime. v2 has one socket per daemon process, so the
 * primary key is the daemon and a secondary index answers the one question the
 * rest of the server still asks per runtime: "which connection can I send
 * `trace.read` for this runtime to?".
 *
 * Two facts about replacement, both from the protocol spec (§1.1):
 *
 *   - A newer connection for the same daemon wins, and the older one is closed
 *     with 4001. 4001 is `server_closing`, which the daemon retries with backoff,
 *     so a replacement looks like an ordinary reconnect to the losing side and
 *     never looks like an authority failure.
 *   - A runtime may only be owned by one connection. If a second daemon claims a
 *     runtime the first one already serves, the first loses its session for that
 *     same reason - the alternative is two process-level command streams driving
 *     one runtime, which is exactly what the single-socket design exists to stop.
 *
 * The registry holds sessions, never sockets: closing is the session's business,
 * which keeps this file testable with fakes and keeps close codes out of the
 * registry's vocabulary.
 */

/** The part of a session the registry needs. Implemented by `DaemonProtocolSession`. */
export interface DaemonProtocolSessionHandle {
  readonly sessionId: string;
  readonly daemonId: string;
  readonly runtimeIds: readonly string[];
  /** Close because a newer connection replaced this one. Always closes with 4001. */
  closeForReplacement(): void;
  /** Close because the server is shutting down. Also 4001, so the daemon retries. */
  closeForServerShutdown(): void;
}

export interface DaemonSessionRegistration {
  /** Sessions this registration evicted. Already closed when returned. */
  replaced: DaemonProtocolSessionHandle[];
}

export class DaemonSessionRegistry {
  private readonly byDaemon = new Map<string, DaemonProtocolSessionHandle>();
  /** `runtimeId -> daemonId`, the index `trace.read` routes through. */
  private readonly runtimeIndex = new Map<string, string>();

  /**
   * Register a session, evicting any session that already owns this daemon or one
   * of its runtimes. Eviction is close-then-forget, so a session cannot be
   * discovered here after it has been closed.
   */
  register(session: DaemonProtocolSessionHandle): DaemonSessionRegistration {
    const replaced: DaemonProtocolSessionHandle[] = [];
    const evict = (existing: DaemonProtocolSessionHandle | undefined): void => {
      if (!existing || existing === session || replaced.includes(existing)) return;
      replaced.push(existing);
      this.unregister(existing);
      existing.closeForReplacement();
    };

    evict(this.byDaemon.get(session.daemonId));
    for (const runtimeId of session.runtimeIds) {
      const owner = this.runtimeIndex.get(runtimeId);
      if (owner && owner !== session.daemonId) evict(this.byDaemon.get(owner));
    }

    this.byDaemon.set(session.daemonId, session);
    for (const runtimeId of session.runtimeIds) this.runtimeIndex.set(runtimeId, session.daemonId);
    return { replaced };
  }

  /**
   * Forget a session. Only removes the runtime index entries this session still
   * owns, so a session that was replaced by a newer one cannot evict its
   * successor's runtimes on the way out.
   */
  unregister(session: DaemonProtocolSessionHandle): void {
    if (this.byDaemon.get(session.daemonId) === session) this.byDaemon.delete(session.daemonId);
    for (const runtimeId of session.runtimeIds) {
      if (this.runtimeIndex.get(runtimeId) === session.daemonId) this.runtimeIndex.delete(runtimeId);
    }
  }

  get(daemonId: string): DaemonProtocolSessionHandle | null {
    return this.byDaemon.get(daemonId) ?? null;
  }

  /** The daemon id serving `runtimeId`, or null when no live session serves it. */
  daemonIdForRuntime(runtimeId: string): string | null {
    return this.runtimeIndex.get(runtimeId) ?? null;
  }

  /** The live session serving `runtimeId`, or null. Reverse RPC routing uses this. */
  sessionForRuntime(runtimeId: string): DaemonProtocolSessionHandle | null {
    const daemonId = this.runtimeIndex.get(runtimeId);
    return daemonId ? this.byDaemon.get(daemonId) ?? null : null;
  }

  listSessions(): DaemonProtocolSessionHandle[] {
    return [...this.byDaemon.values()];
  }

  get size(): number {
    return this.byDaemon.size;
  }
}
