/**
 * The hub's health and readiness fields (MUL-403 §1 item 9, plan 2/6 §1).
 *
 * Two different audiences, two different payloads:
 *
 * - **`/health`** answers "is fan-out healthy". It carries the hub's own numbers:
 *   how many streams and frames are resident, how much of the memory budget they
 *   use, how many subscribers are paused, and the p95 of a fan-out tick. A rising
 *   `flush_p95_ms` is the ADR's reversal signal (> 50ms sustained moves fan-out to
 *   a worker thread), so it is reported as a number rather than a verdict: only the
 *   operator knows what the baseline was.
 * - **`/readyz`** answers "is this process the one that should serve". It carries
 *   the routing facts a deploy needs: which role this process resolved, which
 *   transport it fans out through, whether a peer link is configured, how many
 *   times the hub repaired its own ring, and the p95 of a hole wait.
 *
 * Both payloads grow fields only when a hub exists, so a process without one
 * (the snapshot harness, a unit test that builds an app for one route) keeps the
 * byte-identical `{ok: true}` bodies the route golden holds. That is deliberate:
 * the golden is a compatibility contract for every consumer of `/readyz`, and the
 * fields here are additive by design.
 */

import type { HubSnapshot, ObservableLiveHub } from "./hub-core.js";
import type { LiveHub } from "./live-hub.js";

/** True when a hub can describe itself. */
export function isObservableHub(hub: LiveHub | ObservableLiveHub | null | undefined): hub is ObservableLiveHub {
  return Boolean(hub && typeof (hub as ObservableLiveHub).snapshot === "function");
}

/**
 * The `/health` additions.
 *
 * `hub` is present only when there is a hub; every number inside it comes from
 * {@link ObservableLiveHub.snapshot}, so the route never invents a counter.
 */
export function hubHealthPayload(hub: LiveHub | ObservableLiveHub | null | undefined): {
  hub?: HubSnapshot;
} {
  if (!isObservableHub(hub)) return {};
  return { hub: hub.snapshot() };
}

/**
 * The `/readyz` additions, named for the deploy that reads them.
 *
 * `hub.peer_link` is the *configuration* fact (`MULTIREMI_PEER_URL` set), not a
 * liveness probe: the peer channel belongs to MUL-462, and a readiness endpoint
 * that reported "the peer is down" would restart this process for the other
 * process's problem. The channel's own liveness is `/health/realtime`'s business
 * once MUL-462 exposes it.
 */
export function hubReadyzPayload(
  hub: LiveHub | ObservableLiveHub | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): {
  hub?: {
    role: string;
    transport: string;
    peer_link: boolean;
    fill_count: number;
    hub_hole_wait_ms: number;
  };
} {
  if (!isObservableHub(hub)) return {};
  const snapshot = hub.snapshot();
  return {
    hub: {
      role: snapshot.role,
      transport: snapshot.transport,
      peer_link: Boolean(env.MULTIREMI_PEER_URL?.trim()),
      fill_count: snapshot.fill_count,
      hub_hole_wait_ms: snapshot.hole_wait_ms,
    },
  };
}
