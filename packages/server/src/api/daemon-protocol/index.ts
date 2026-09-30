/**
 * Server-side connection layer for daemon protocol v2 (MUL-417).
 *
 * This is the seam the rest of the server talks to: `server.ts` hands over the
 * upgraded socket and the per-runtime authorization rules, and everything else -
 * the session registry, the handshake, the downlink sequence, the ack deadline,
 * backpressure and the frame metrics - lives behind it.
 *
 * A-2 removes the per-runtime v1 wake-up path. Upgrades must carry the protocol=2
 * URL marker; every runtime is advertised and authorized in hello instead.
 *
 * NO BUSINESS FRAMES. A-1 wires the transport: `hello`, `hb`, the downlink
 * sequence and its deadline, acks, backpressure, RPC dispatch and the frame
 * metrics. `task.offer` (A-3), `pending_*` (A-4), the uplink reports (A-5) and
 * the trace stream (A-6) register through the session's hooks. `welcome.trace_heads`
 * answers `{}` until A-6 fills it.
 */

import {
  DAEMON_PROTOCOL_CLOSE_CODES,
  DAEMON_PROTOCOL_VERSION,
  type DaemonHeartbeatReplyPayload,
  type DaemonProtocolCap,
  type DaemonRuntimeCapabilities,
} from "@multiremi/contracts/daemon-protocol.js";
import { createId } from "@multiremi/ids.js";
import { multiremiVersion } from "@multiremi/version.js";
import {
  FEISHU_CONCIERGE_PROTOCOL_VERSION,
  FEISHU_DECISION_CARD_PROTOCOL_VERSION,
  FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION,
  type MultiremiAccessToken,
  type MultiremiDaemonHeartbeatAck,
  type MultiremiDaemonSshMeshStatus,
} from "@multiremi/contracts/types.js";
import type { MultiremiStore } from "@multiremi/store/store.js";
import {
  startWsFrameMetricsSummary,
  type WsFrameMetricsOptions,
  type WsFrameMetricsRuntime,
} from "./metrics.js";
import { DaemonSessionRegistry } from "./session-registry.js";
import {
  DaemonProtocolSession,
  daemonAuthorizationCloseCode,
  setDaemonProtocolDbCounters,
  type DaemonProtocolSocket,
  type DaemonSessionHeartbeat,
  type DaemonSessionHello,
  type DaemonSessionRuntimeAuthorization,
} from "./session.js";
import { readPayload, type DaemonParsedFrame } from "./frames.js";

function runtimeCapabilityOptions(capabilities: DaemonRuntimeCapabilities | undefined) {
  const reported = capabilities ?? {};
  const version = (value: unknown) => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  return {
    supportsBatchImport: reported.supports_batch_import === true,
    supportsDirectoryScan: reported.supports_directory_scan === true,
    supportsSkillDirectory: reported.supports_skill_directory === true,
    supportsBotMenu: reported.supports_bot_menu === true,
    agentPluginProtocol: version(reported.agent_plugin_protocol),
    supportsFeishuBotConfig: version(reported.feishu_concierge_protocol) >= FEISHU_CONCIERGE_PROTOCOL_VERSION,
    supportsDecisionCard: version(reported.feishu_decision_card) >= FEISHU_DECISION_CARD_PROTOCOL_VERSION,
    supportsIssueDecisionCard: version(reported.feishu_issue_decision_card) >= FEISHU_ISSUE_DECISION_CARD_PROTOCOL_VERSION,
  };
}

/** How a v2 connection's identity is established before `hello` is read. */
export interface DaemonProtocolIdentity {
  accessToken: MultiremiAccessToken | null;
  /** True when the connection presented the deployment master credential. */
  masterToken: boolean;
}

/** An RPC handler a later sub-issue registers. */
export type DaemonProtocolRpcHandler = (
  frame: DaemonParsedFrame,
  session: DaemonProtocolSession,
) => Promise<unknown | null> | unknown | null;

export interface DaemonProtocolSessionHooks {
  stop?(): void;
  hello?(session: DaemonProtocolSession, hello: DaemonSessionHello): void;
  heartbeat?(session: DaemonProtocolSession, heartbeat: DaemonSessionHeartbeat): void;
  reply?(session: DaemonProtocolSession, frame: DaemonParsedFrame): void;
  ack?(session: DaemonProtocolSession, ack: number): void;
  drain?(session: DaemonProtocolSession): void;
  close?(session: DaemonProtocolSession): void;
}

export interface DaemonProtocolLayerOptions {
  store: MultiremiStore;
  /** Server version reported in `welcome`. */
  serverVersion?: string;
  /** Metrics configuration; `startMultiremiServer` supplies the env-resolved one. */
  metrics?: WsFrameMetricsOptions;
  /**
   * Process DB counters used for per-frame attribution.
   *
   * Feeds the per-frame `db_ms` only. The process total is reported once, by
   * `api_minute_summary`; see `metrics.ts` for why it is not repeated here.
   */
  dbCounters?: () => { dbMs: number; dbQueries: number };
}

export class DaemonProtocolLayer {
  readonly registry = new DaemonSessionRegistry();
  private readonly store: MultiremiStore;
  private readonly serverVersion: string;
  private readonly metrics: WsFrameMetricsRuntime | null;
  /** RPC handlers registered by later sub-issues, keyed by frame type. */
  private readonly rpcHandlers = new Map<string, DaemonProtocolRpcHandler>();
  private readonly sessionHooks = new Set<DaemonProtocolSessionHooks>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly eventHandlers = new Map<string, DaemonProtocolRpcHandler>();
  private readonly bestEffortHandlers = new Map<string, DaemonProtocolRpcHandler>();
  private readonly replyListeners = new Set<(frame: DaemonParsedFrame, session: DaemonProtocolSession) => void>();
  private readonly closeListeners = new Set<(session: DaemonProtocolSession) => void>();
  private traceHeads: (session: DaemonProtocolSession) => Record<string, number> = () => ({});

  constructor(options: DaemonProtocolLayerOptions) {
    this.store = options.store;
    this.serverVersion = options.serverVersion ?? multiremiVersion;
    if (options.dbCounters) setDaemonProtocolDbCounters(options.dbCounters);
    this.metrics = options.metrics ? startWsFrameMetricsSummary(options.metrics) : null;
  }

  /** Emit the current frame window now. Tests and smoke runs use this. */
  flushMetrics(): void {
    this.metrics?.flush();
  }

  recordOfferSweepRecovery(): void { this.metrics?.recordOfferSweepRecovery(); }

  stop(): void {
    this.metrics?.stop();
    for (const hooks of this.sessionHooks) hooks.stop?.();
  }


  /** Open a v2 session for an upgraded socket. */
  openSession(socket: DaemonProtocolSocket, identity: DaemonProtocolIdentity): DaemonProtocolSession {
    const sessionId = createId("dws");
    const session: DaemonProtocolSession = new DaemonProtocolSession({
      sessionId,
      socket,
      registry: this.registry,
      serverVersion: this.serverVersion,
      ownerAccessToken: identity.accessToken,
      authorizeRuntime: (daemonId, runtimeId) => this.authorizeRuntime(identity, daemonId, runtimeId),
      onHello: hello => {
        for (const runtimeId of session.runtimeIds) {
          this.store.recordDaemonProtocol(runtimeId, hello.daemonId, DAEMON_PROTOCOL_VERSION, hello.cliVersion);
          const runtime = hello.runtimes.find(entry => entry.runtimeId === runtimeId);
          this.store.heartbeatRuntime(runtimeId, { claimPending: false, ...runtimeCapabilityOptions(runtime?.capabilities) });
        }
        for (const hooks of this.sessionHooks) hooks.hello?.(session, hello);
      },
      onHeartbeat: heartbeat => {
        const reply = this.handleHeartbeat(heartbeat);
        for (const hooks of this.sessionHooks) hooks.heartbeat?.(session, heartbeat);
        return reply;
      },
      onFrame: (sample) => this.metrics?.record(sample),
      onRpc: frame => this.dispatchRpc(frame, session),
      onEvent: frame => this.eventHandlers.get(frame.type)?.(frame, session) ?? null,
      onBestEffort: frame => this.bestEffortHandlers.get(frame.type)?.(frame, session) ?? null,
      traceHeads: () => this.traceHeads(session),
      onReply: frame => {
        for (const hooks of this.sessionHooks) hooks.reply?.(session, frame);
        for (const listener of this.replyListeners) listener(frame, session);
      },
      onAck: ack => { for (const hooks of this.sessionHooks) hooks.ack?.(session, ack); },
      onDrain: () => { for (const hooks of this.sessionHooks) hooks.drain?.(session); },
      onClose: () => {
        for (const hooks of this.sessionHooks) hooks.close?.(session);
        for (const listener of this.closeListeners) listener(session);
      },
    });
    return session;
  }

  /**
   * Authorize a v2 upgrade, i.e. establish *who* is connecting.
   *
   * A v1 upgrade has to name its runtimes up front, so its whole check happens
   * against a known list. A v2 socket does not know its runtimes until it sends
   * `hello`, so the upgrade can only settle identity and membership here; the
   * per-runtime rules run in {@link authorizeRuntime} once the list arrives. Both
   * halves reuse the HTTP daemon identity and membership rules.
   */
  async resolveIdentity(
    req: Request,
    authToken: string,
  ): Promise<{ identity: DaemonProtocolIdentity } | { response: Response }> {
    const header = req.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const masterToken = Boolean(authToken) && token === authToken;
    if (token && !masterToken) {
      const accessToken = await this.store.verifyAccessToken(token);
      if (!accessToken) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
      if (accessToken.type !== "daemon") {
        return {
          response: Response.json(
            { error: "daemon token required", code: "daemon_token_required" },
            { status: 403 },
          ),
        };
      }
      if (!accessToken.daemonId?.trim()) {
        return {
          response: Response.json(
            { error: "forbidden for daemon identity", code: "daemon_identity_forbidden" },
            { status: 403 },
          ),
        };
      }
      if (!isOwnerStillMember(this.store, accessToken)) {
        return {
          response: Response.json(
            {
              error: "daemon owner is no longer a workspace member",
              code: "daemon_owner_membership_required",
            },
            { status: 403 },
          ),
        };
      }
      if (this.store.isDaemonRetired(accessToken.workspaceId, accessToken.daemonId.trim())) {
        return {
          response: Response.json(
            { error: "daemon has been retired", code: "daemon_retired" },
            { status: 410 },
          ),
        };
      }
      return { identity: { accessToken, masterToken: false } };
    }
    if (authToken && !masterToken) {
      return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };
    }
    // Master credential, or auth-disabled open mode: the historical daemon
    // credential, kept working exactly as the HTTP path keeps it.
    return { identity: { accessToken: null, masterToken: true } };
  }

  /**
   * The per-runtime authorization rule, exposed for direct test coverage.
   *
   * The rules are pure functions of store state, and a case that drives them
   * through a socket would have to assert a close code to observe which branch
   * ran. Naming the rule keeps the test about the rule.
   */
  authorizeRuntimeForTest(
    identity: DaemonProtocolIdentity,
    daemonId: string,
    runtimeId: string,
  ): Promise<DaemonSessionRuntimeAuthorization> {
    return this.authorizeRuntime(identity, daemonId, runtimeId);
  }

  /** The `hb` handler, exposed so its store effects and reply can be asserted. */
  handleHeartbeatForTest(heartbeat: DaemonSessionHeartbeat): DaemonHeartbeatReplyPayload {
    return this.handleHeartbeat(heartbeat);
  }

  /** Register an RPC handler. A-6 uses this for `trace.head`/`subscribe`/`fetch`. */
  registerRpcHandler(frameType: string, handler: DaemonProtocolRpcHandler): void {
    this.rpcHandlers.set(frameType, handler);
  }

  registerSessionHooks(hooks: DaemonProtocolSessionHooks): void { this.sessionHooks.add(hooks); }

  trackBackground(run: Promise<unknown>): void {
    this.background.add(run);
    void run.finally(() => this.background.delete(run)).catch(() => {});
  }

  async drain(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  registerEventHandler(frameType: string, handler: DaemonProtocolRpcHandler): void {
    this.eventHandlers.set(frameType, handler);
  }

  registerBestEffortHandler(frameType: string, handler: DaemonProtocolRpcHandler): void {
    this.bestEffortHandlers.set(frameType, handler);
  }

  setTraceHeads(source: (session: DaemonProtocolSession) => Record<string, number>): void { this.traceHeads = source; }
  onReply(listener: (frame: DaemonParsedFrame, session: DaemonProtocolSession) => void): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }
  onClose(listener: (session: DaemonProtocolSession) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Close every live session with 4001 (server shutdown). */
  closeAll(reason = "server shutting down"): void {
    for (const session of this.registry.listSessions()) session.closeForServerShutdown();
  }

  private async dispatchRpc(frame: DaemonParsedFrame, session: DaemonProtocolSession): Promise<unknown | null> {
    const handler = this.rpcHandlers.get(frame.type);
    if (!handler) return null;
    return handler(frame, session);
  }
  /**
   * Per-runtime authorization, reusing the HTTP daemon identity rules
   * applies to a v1 socket's runtime list.
   *
   * Two kinds of answer come out of here, and the difference is the important
   * part:
   *
   *   - **daemon-level** (`scope: "daemon"`): retired, bad credential, wrong
   *     workspace, owner no longer a member. The session closes with the terminal
   *     code the HTTP path would have answered with.
   *   - **runtime-level** (`scope: "runtime"`): the runtime's row is gone, or it
   *     belongs to another daemon. v1 answered 404 for both (`runtime not found`),
   *     and 404 is not terminal - the session keeps serving the daemon's other
   *     runtimes and reports this one as `runtime_gone` on the next heartbeat.
   *
   * The daemon-level checks run first and key on the credential's workspace, not
   * the runtime's: retirement and membership are facts about the daemon named by
   * the token, so a runtime hint must not be able to redirect them.
   */
  private async authorizeRuntime(
    identity: DaemonProtocolIdentity,
    daemonId: string,
    runtimeId: string,
  ): Promise<DaemonSessionRuntimeAuthorization> {
    const sessionDaemonId = daemonId;
    const token = identity.accessToken;
    const runtime = this.store.getRuntimeLite(runtimeId);

    // ── daemon-level facts: the connection itself is not usable ──────────────
    // A retired daemon must stop reconnecting, whatever else is true about it.
    const daemonWorkspaceId = token?.workspaceId ?? runtime?.workspaceId ?? "local";
    if (sessionDaemonId && this.store.isDaemonRetired(daemonWorkspaceId, sessionDaemonId)) {
      return {
        runtimeId,
        ok: false,
        scope: "daemon",
        status: 410,
        code: "daemon_retired",
        message: "daemon has been retired",
      };
    }

    if (token?.type === "daemon") {
      // The `hello` must claim the identity the credential actually holds. Without
      // this, a token for daemon B could open a session claiming daemon A, evict
      // A's live connection through the registry's replacement rule, and hold the
      // slot while being unable to serve any of A's runtimes.
      const claimedDaemonId = sessionDaemonId?.trim();
      const tokenDaemonId = token.daemonId?.trim();
      if (!claimedDaemonId || !tokenDaemonId || claimedDaemonId !== tokenDaemonId) {
        return {
          runtimeId,
          ok: false,
          scope: "daemon",
          status: 403,
          code: "daemon_identity_forbidden",
          message: "hello daemon_id does not match the credential's daemon identity",
        };
      }
      // Membership is re-read rather than trusted from the upgrade: a credential
      // can survive its owner's removal from the workspace, and the terminal close
      // code exists so the daemon stops reconnecting instead of retrying forever.
      if (!isOwnerStillMember(this.store, token)) {
        return {
          runtimeId,
          ok: false,
          scope: "daemon",
          status: 401,
          code: "daemon_owner_membership_required",
          message: "daemon owner is no longer a workspace member",
        };
      }
    }

    // ── runtime-level facts: exclude this runtime, keep the socket ────────────
    if (!runtime) {
      // A daemon reconnecting after its runtime row was deleted still advertises
      // the old id. The daemon's recovery is to register it again, which it
      // cannot do if the socket is closed terminally.
      return {
        runtimeId,
        ok: false,
        scope: "runtime",
        status: 404,
        code: "runtime_not_found",
        message: `runtime ${runtimeId} is not registered`,
      };
    }

    // ── runtime ownership ─────────────────────────────────────────────────────
    // One rule for every credential type, checked before the credential-type
    // branches, because the registry's replacement rule would otherwise let a
    // master credential (or auth-disabled open mode) claim a runtime another
    // daemon is actively serving and evict that whole connection.
    //
    // A runtime row with no `daemonId` is historical data that predates the
    // binding, so it stays claimable - but only by the credentials that were
    // always allowed to claim it.
    const runtimeDaemonId = runtime.daemonId?.trim() ?? "";
    const helloDaemonId = sessionDaemonId?.trim() ?? "";

    // A runtime in another workspace is the same kind of fact. A daemon process
    // serves one workspace with one credential, so this almost always means the
    // token moved to a new workspace while the local state still names the old
    // runtime - which the daemon fixes by re-registering, not by stopping forever.
    // (Credential problems of their own are covered by 4401/4403 above.)
    if (token?.type === "daemon" && (runtime.workspaceId ?? "local") !== token.workspaceId) {
      return {
        runtimeId,
        ok: false,
        scope: "runtime",
        status: 404,
        code: "runtime_not_found",
        message: `runtime ${runtimeId} is not registered`,
      };
    }

    if (runtimeDaemonId) {
      if (runtimeDaemonId !== helloDaemonId) {
        // Reported as "does not exist", matching the v1 upgrade's
        // `hideForbiddenAsNotFound`. A daemon must not be able to probe which
        // runtime ids exist on other machines, and the answer it needs is the same
        // either way: this runtime is not mine, stop serving it.
        return {
          runtimeId,
          ok: false,
          scope: "runtime",
          status: 404,
          code: "runtime_not_found",
          message: `runtime ${runtimeId} is not registered`,
        };
      }
    } else if (token?.type === "daemon") {
      // A bound daemon credential may only serve rows that name it.
      return {
        runtimeId,
        ok: false,
        scope: "runtime",
        status: 404,
        code: "runtime_not_found",
        message: `runtime ${runtimeId} is not registered`,
      };
    }

    if (token?.type === "daemon") return { runtimeId, ok: true, scope: "runtime" };

    // Master credential or auth-disabled open mode: the historical daemon
    // credential, kept working exactly as the HTTP path keeps it.
    if (identity.masterToken || !token) return { runtimeId, ok: true, scope: "daemon" };
    // Unreachable through `resolveIdentity` (it refuses non-daemon tokens), kept
    // as the fail-closed default so a future caller cannot widen the surface.
    return {
      runtimeId,
      ok: false,
      scope: "daemon",
      status: 403,
      code: "daemon_token_required",
      message: "daemon token required",
    };
  }

  /**
   * `hb`: liveness plus the drain acknowledgement, and nothing else.
   *
   * A live process-level socket proves every runtime it serves is reachable, so
   * every *served* runtime is stamped; the drain acknowledgement is recorded per
   * runtime because the drain gate scores runtimes, not daemons.
   *
   * Runtimes the handshake excluded are reported - and only reported. Their rows
   * are never written: one of them may belong to a different daemon, and stamping
   * it would make this machine look alive for a runtime it does not own.
   */
  private handleHeartbeat(heartbeat: DaemonSessionHeartbeat): DaemonHeartbeatReplyPayload {
    // Recheck daemon-wide authority before stamping any runtime heartbeat.
    if (this.heartbeatOwnerCheck(heartbeat)) return { runtime_acks: [] };
    // Reading the maintenance row also enforces the drain lease TTL lazily, so a
    // crashed updater cannot leave the platform draining forever. The row itself
    // is not consumed here: `drainStatus` is the reader that scores runtimes, and
    // the daemon learns about draining from the `platform.drain` push (A-4).
    this.store.getPlatformMaintenance();

    const ackGeneration = readNonNegativeInteger(heartbeat.payload.drain_ack_generation);
    const activeTaskCount = readNonNegativeInteger(heartbeat.payload.active_task_count);
    const reportedRuntimes = Array.isArray(heartbeat.payload.runtimes) ? heartbeat.payload.runtimes.map(readPayload) : [];

    // Keyed by runtime id so the reply can be assembled in the order the `hello`
    // advertised, which is the order the daemon reads it in.
    const acksByRuntime = new Map<string, MultiremiDaemonHeartbeatAck>();
    for (const runtimeId of heartbeat.runtimeIds) {
      // `claimPending: false` because the v2 server does not sweep the pending
      // families on a heartbeat (MUL-389's merged poll): those become pushes in A-4.
      const reported = reportedRuntimes.find(entry => entry.runtime_id === runtimeId);
      const ack = this.store.heartbeatRuntime(runtimeId, { claimPending: false,
        ...runtimeCapabilityOptions(readPayload(reported?.capabilities) as DaemonRuntimeCapabilities) });
      if (ack.status === "runtime_gone") {
        // The row vanished between the handshake and now. Same report as a
        // handshake-time exclusion: tell the daemon, do not close the socket, and
        // do not resurrect the row - the daemon registers it again, or does not.
        acksByRuntime.set(runtimeId, ack);
        continue;
      }
      if (reported && Object.prototype.hasOwnProperty.call(reported, "ssh_mesh_protocol")) {
        this.store.recordSshMeshHeartbeat(runtimeId,
          readNonNegativeInteger(reported.ssh_mesh_protocol) ?? 0,
          reported.ssh_mesh_status as MultiremiDaemonSshMeshStatus | undefined);
      }
      if (ackGeneration !== null) {
        this.store.recordRuntimeDrainAck(runtimeId, ackGeneration, activeTaskCount);
      }
      acksByRuntime.set(runtimeId, ack);
    }

    // Runtimes the handshake excluded are answered `runtime_gone` from here, with
    // no store write at all. The shape is A-0's `MultiremiDaemonHeartbeatAck`
    // unchanged - membership in this list is the only difference from a served
    // runtime, and a new status value would have changed the v1/v2 shared type.
    for (const runtimeId of heartbeat.unavailableRuntimeIds) {
      acksByRuntime.set(runtimeId, { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true });
    }

    const advertised = heartbeat.advertisedRuntimeIds.length
      ? heartbeat.advertisedRuntimeIds
      : [...heartbeat.runtimeIds, ...heartbeat.unavailableRuntimeIds];
    return { runtime_acks: advertised.map((runtimeId) => (
      acksByRuntime.get(runtimeId) ?? { runtime_id: runtimeId, status: "runtime_gone", runtime_gone: true }
    )) };
  }

  /**
   * Re-check retirement, credential validity and owner membership on each hb.
   *
   * The v1 path made this check per message; v2 keeps the property without paying
   * it per frame, because the only thing a stale credential can still do before
   * the next heartbeat is finish the turn it already started.
   */
  private heartbeatOwnerCheck(heartbeat: { daemonId: string }): boolean {
    const session = this.registry.get(heartbeat.daemonId);
    if (!session || !(session instanceof DaemonProtocolSession)) return false;
    const token = session.ownerAccessToken;
    if (!token || token.type !== "daemon") return false;
    if (this.store.isDaemonRetired(token.workspaceId, heartbeat.daemonId)) {
      session.closeWithCode(DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired, "daemon_retired");
      return true;
    }
    if (!this.store.isAccessTokenStillValid(token)) {
      session.closeWithCode(DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked, "authority_revoked");
      return true;
    }
    if (isOwnerStillMember(this.store, token)) return false;
    session.closeWithCode(
      DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked,
      "daemon owner is no longer a workspace member",
    );
    return true;
  }
}


function isOwnerStillMember(store: MultiremiStore, token: MultiremiAccessToken): boolean {
  const owner = token.userId?.trim();
  return !owner || owner === "local" || Boolean(store.getUserRoleInWorkspace(owner, token.workspaceId));
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export { DaemonProtocolSession, DaemonSessionRegistry };
export { daemonAuthorizationCloseCode };
export type { DaemonProtocolSocket, DaemonSessionRuntimeAuthorization };
