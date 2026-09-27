/**
 * Server-side connection layer for daemon protocol v2 (MUL-417).
 *
 * This is the seam the rest of the server talks to: `server.ts` hands over the
 * upgraded socket and the per-runtime authorization rules, and everything else -
 * the session registry, the handshake, the downlink sequence, the ack deadline,
 * backpressure and the frame metrics - lives behind it.
 *
 * COEXISTENCE (A-1 only; A-2 deletes the old path). v1 daemons still connect per
 * runtime and still receive `daemon:task_available`, and their behavior is
 * unchanged: a socket that names `runtime_ids` is a v1 socket. A v2 socket is
 * recognized by either
 *
 *   - `?protocol=2` in the upgrade URL, which is what A-2's client will send; or
 *   - the absence of runtime parameters *and* a verified daemon token, which is
 *     the shape a v2 client has anyway.
 *
 * The explicit marker exists because the protocol document describes the frames
 * and deliberately says nothing about the URL, while the legacy path must stay
 * byte-identical for the fleet that is still on v1. Both rules are checked here,
 * in one place, and A-2 removes them together with the legacy path.
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
} from "@multiremi/contracts/daemon-protocol.js";
import { createId } from "@multiremi/ids.js";
import { multiremiVersion } from "@multiremi/version.js";
import type { MultiremiAccessToken, MultiremiDaemonHeartbeatAck } from "@multiremi/contracts/types.js";
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
  type DaemonSessionRuntimeAuthorization,
} from "./session.js";
import type { DaemonParsedFrame } from "./frames.js";

/** How a v2 connection's identity is established before `hello` is read. */
export interface DaemonProtocolIdentity {
  accessToken: MultiremiAccessToken | null;
  /** True when the connection presented the deployment master credential. */
  masterToken: boolean;
}

/** An RPC handler a later sub-issue registers. */
export type DaemonProtocolRpcHandler = (
  frame: DaemonParsedFrame,
) => Promise<unknown | null> | unknown | null;

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

  stop(): void {
    this.metrics?.stop();
  }

  /**
   * Whether an upgrade carrying no runtime parameters is a v2 connection, and
   * therefore whether {@link authorizeUpgrade}'s answer applies.
   *
   * The rules, in order, and why each exists:
   *
   *   1. Runtime parameters present -> v1, always. The envelope is the v1
   *      client's, and the v2 client never sends it.
   *   2. An explicit `?protocol=2` -> v2. A-2's client sends this, and it is the
   *      only way a connection is unambiguous even in an auth-disabled or
   *      bot-less deployment.
   *   3. Otherwise the caller must have authenticated as a daemon identity - the
   *      bindable daemon token, or the deployment master credential. A request
   *      with neither keeps today's answer (`runtime_ids required`, 400), which
   *      is what every malformed v1 upgrade already gets.
   *
   * Rule 3 deliberately excludes the open-mode case where no credential is
   * configured at all: without a credential there is nothing to bind a session's
   * daemon identity to, and the historical answer is more useful to a human
   * debugging with curl than a socket that waits for a `hello` nobody sends.
   */
  isV2Upgrade(url: URL, identity: DaemonProtocolIdentity, explicitMarker: boolean): boolean {
    if (hasRuntimeParameters(url)) return false;
    if (explicitMarker) return true;
    // The bindable daemon token, or the deployment master credential that the
    // v1 client also uses. A v2 daemon does not know its runtimes until it has
    // sent `hello`, so neither credential can name them in the query string.
    if (identity.masterToken) return true;
    return identity.accessToken?.type === "daemon";
  }

  /** Open a v2 session for an upgraded socket. */
  openSession(socket: DaemonProtocolSocket, identity: DaemonProtocolIdentity): DaemonProtocolSession {
    const sessionId = createId("dws");
    const session = new DaemonProtocolSession({
      sessionId,
      socket,
      registry: this.registry,
      serverVersion: this.serverVersion,
      ownerAccessToken: identity.accessToken,
      authorizeRuntime: (daemonId, runtimeId) => this.authorizeRuntime(identity, daemonId, runtimeId),
      onHeartbeat: (heartbeat) => this.handleHeartbeat(heartbeat),
      onFrame: (sample) => this.metrics?.record(sample),
      onRpc: (frame) => this.dispatchRpc(frame),
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
   * halves reuse the same store lookups as `authorizeDaemonWebSocketRequest`.
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

  /** Close every live session with 4001 (server shutdown). */
  closeAll(reason = "server shutting down"): void {
    for (const session of this.registry.listSessions()) session.closeForServerShutdown();
  }

  private async dispatchRpc(frame: DaemonParsedFrame): Promise<unknown | null> {
    const handler = this.rpcHandlers.get(frame.type);
    if (!handler) return null;
    return handler(frame);
  }

  /**
   * Per-runtime authorization, reusing the rules `authorizeDaemonWebSocketRequest`
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
    // Membership is re-checked here, not only at the handshake: a credential can
    // outlive its owner's place in the workspace, and the terminal close code
    // exists so the daemon stops reconnecting instead of retrying forever.
    if (this.heartbeatOwnerCheck(heartbeat)) return { runtime_acks: [] };
    // Reading the maintenance row also enforces the drain lease TTL lazily, so a
    // crashed updater cannot leave the platform draining forever. The row itself
    // is not consumed here: `drainStatus` is the reader that scores runtimes, and
    // the daemon learns about draining from the `platform.drain` push (A-4).
    this.store.getPlatformMaintenance();

    const ackGeneration = readNonNegativeInteger(heartbeat.payload.drain_ack_generation);
    const activeTaskCount = readNonNegativeInteger(heartbeat.payload.active_task_count);

    // Keyed by runtime id so the reply can be assembled in the order the `hello`
    // advertised, which is the order the daemon reads it in.
    const acksByRuntime = new Map<string, MultiremiDaemonHeartbeatAck>();
    for (const runtimeId of heartbeat.runtimeIds) {
      // `claimPending: false` because the v2 server does not sweep the pending
      // families on a heartbeat (MUL-389's merged poll): those become pushes in A-4.
      const ack = this.store.heartbeatRuntime(runtimeId, { claimPending: false });
      if (ack.status === "runtime_gone") {
        // The row vanished between the handshake and now. Same report as a
        // handshake-time exclusion: tell the daemon, do not close the socket, and
        // do not resurrect the row - the daemon registers it again, or does not.
        acksByRuntime.set(runtimeId, ack);
        continue;
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
   * Re-check the daemon owner's membership on each heartbeat and close 4401 when
   * it is gone.
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
    if (isOwnerStillMember(this.store, token)) return false;
    session.closeWithCode(
      DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked,
      "daemon owner is no longer a workspace member",
    );
    return true;
  }
}

/** Any of the three runtime-parameter spellings the v1 client and tests use. */
export function hasRuntimeParameters(url: URL): boolean {
  return url.searchParams.get("runtime_id") !== null
    || url.searchParams.get("runtime_ids") !== null
    || url.searchParams.get("runtimeId") !== null;
}

/** The explicit v2 marker, when the request carries one. */
export function requestsDaemonProtocolV2(url: URL): boolean {
  const marker = (url.searchParams.get("protocol") ?? url.searchParams.get("v") ?? "").trim();
  if (!marker) return false;
  return marker === String(DAEMON_PROTOCOL_VERSION);
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
