/**
 * The hub's health fields (MUL-403 §1 item 9, plan 2/6 §1).
 *
 * - **`/health`** answers "is fan-out healthy". It carries the hub's own numbers:
 *   how many streams and frames are resident, how much of the memory budget they
 *   use, how many subscribers are paused, and the p95 of a fan-out tick. A rising
 *   `flush_p95_ms` is the ADR's reversal signal (> 50ms sustained moves fan-out to
 *   a worker thread), so it is reported as a number rather than a verdict: only the
 *   operator knows what the baseline was.
 * `/readyz` keeps the API role response from main. Peer health does not affect
 * readiness; operators inspect the hub snapshot through `/health`.
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
