/**
 * Handshake gate for daemon protocol v2 (MUL-417, spec §7.1).
 *
 * Two checks decide whether a connection may proceed, and both read A-0's
 * constants rather than restating a number:
 *
 *   - `protocol` must be at least `DAEMON_PROTOCOL_MIN`;
 *   - `cli_version` must satisfy `meetsDaemonMinCliVersion`.
 *
 * A failure of either answers `reject` and then closes 4426. 4426 tells the
 * daemon "this is not an authority problem, upgrade yourself", which is the
 * branch that sends it to the HTTP upgrade channel instead of a reconnect loop.
 *
 * Everything above the protocol check is *per-runtime* authorization, not
 * version negotiation. That distinction is what the three terminal close codes
 * are for, and it is the only reason this file returns a close code at all
 * rather than an HTTP-shaped decision.
 */

import {
  DAEMON_MIN_CLI_VERSION,
  DAEMON_PROTOCOL_CLOSE_CODES,
  DAEMON_PROTOCOL_MIN,
  DAEMON_PROTOCOL_VERSION,
  meetsDaemonMinCliVersion,
  type DaemonHelloPayload,
  type DaemonHelloRuntime,
  type DaemonRejectPayload,
} from "@multiremi/contracts/daemon-protocol.js";
import { readInteger, readPayload, readString } from "./frames.js";

/** Why a handshake was refused, as the close code the daemon must act on. */
export type DaemonHandshakeRejectionCode =
  | typeof DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required
  | typeof DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked
  | typeof DAEMON_PROTOCOL_CLOSE_CODES.forbidden
  | typeof DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired;

export interface DaemonHandshakeRejection {
  code: DaemonHandshakeRejectionCode;
  /** Error code for the `reject` payload; only present on the 4426 branch. */
  errorCode: "daemon_protocol_upgrade_required" | "daemon_cli_upgrade_required" | null;
  hint: string;
}

export type DaemonHelloParseResult =
  | { ok: true; hello: DaemonHelloPayload }
  | { ok: false; reason: "malformed_hello" };

/**
 * Parse a `hello` payload.
 *
 * Strict on the fields the security decision reads (protocol, daemon id, cli
 * version, runtimes) and forgiving on `launched_by` / `caps`, which only tune
 * behaviour the server would otherwise get right by default.
 */
export function parseDaemonHello(payload: Record<string, unknown>): DaemonHelloParseResult {
  const protocol = readInteger(payload.protocol);
  const daemonId = readString(payload.daemon_id);
  const cliVersion = readString(payload.cli_version);
  if (protocol === null || !daemonId || !cliVersion) return { ok: false, reason: "malformed_hello" };

  const rawRuntimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
  const runtimes: DaemonHelloRuntime[] = [];
  for (const entry of rawRuntimes) {
    const runtime = readPayload(entry);
    const runtimeId = readString(runtime.runtime_id);
    if (!runtimeId) continue;
    runtimes.push({
      runtime_id: runtimeId,
      provider: readString(runtime.provider) ?? "any",
      max_concurrency: readInteger(runtime.max_concurrency) ?? 1,
      active_task_ids: Array.isArray(runtime.active_task_ids)
        ? runtime.active_task_ids.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim())
        : [],
    });
  }
  if (runtimes.length === 0) return { ok: false, reason: "malformed_hello" };

  return {
    ok: true,
    hello: {
      protocol,
      daemon_id: daemonId,
      cli_version: cliVersion,
      launched_by: readString(payload.launched_by),
      runtimes,
      caps: Array.isArray(payload.caps)
        ? payload.caps.filter((cap): cap is DaemonHelloPayload["caps"][number] => typeof cap === "string")
          .map((cap) => cap.trim())
          .filter(Boolean) as DaemonHelloPayload["caps"]
        : [],
    },
  };
}

/**
 * Version gate. Runs before authorization on purpose: a v1 daemon that also
 * fails auth should learn it has to upgrade, not that a runtime is missing -
 * otherwise the same fleet machine reports two different problems and the
 * operator fixes the wrong one.
 */
export function checkHandshakeVersion(hello: Pick<DaemonHelloPayload, "protocol" | "cli_version">): DaemonHandshakeRejection | null {
  if (hello.protocol < DAEMON_PROTOCOL_MIN) {
    return {
      code: DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required,
      errorCode: "daemon_protocol_upgrade_required",
      hint: `protocol ${hello.protocol} is below the minimum ${DAEMON_PROTOCOL_MIN}; upgrade the daemon CLI and reconnect`,
    };
  }
  if (!meetsDaemonMinCliVersion(hello.cli_version)) {
    return {
      code: DAEMON_PROTOCOL_CLOSE_CODES.protocol_upgrade_required,
      errorCode: "daemon_cli_upgrade_required",
      hint: `daemon CLI ${hello.cli_version} is below the minimum ${DAEMON_MIN_CLI_VERSION}; upgrade the daemon CLI and reconnect`,
    };
  }
  return null;
}

/** The `reject` payload for a refused handshake. */
export function daemonRejectPayload(rejection: DaemonHandshakeRejection): DaemonRejectPayload {
  return {
    code: rejection.errorCode ?? "authority_revoked",
    min_protocol: DAEMON_PROTOCOL_MIN,
    min_cli_version: DAEMON_MIN_CLI_VERSION,
    hint: rejection.hint,
  };
}

/**
 * Map a per-runtime authorization failure onto a close code.
 *
 * The three terminal codes carry the HTTP vocabulary the daemon already reacts
 * to (see `isTerminalDaemonAuthorityError`): 4401 replaced 401/403 credential
 * problems, 4403 a token that is not allowed on this socket, 4410 a retired
 * daemon. All three stop the reconnect loop, which is the point of separating
 * them from 4000/4001.
 */
export function daemonAuthorizationCloseCode(
  status: number,
  code?: string | null,
): DaemonHandshakeRejectionCode {
  if (code === "daemon_retired") return DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired;
  if (status === 410) return DAEMON_PROTOCOL_CLOSE_CODES.daemon_retired;
  if (status === 403) return DAEMON_PROTOCOL_CLOSE_CODES.forbidden;
  return DAEMON_PROTOCOL_CLOSE_CODES.authority_revoked;
}

/** Negotiated facts the `welcome` frame reports back. */
export function daemonWelcomeProtocolVersion(): number {
  return DAEMON_PROTOCOL_VERSION;
}
