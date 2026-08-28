// Pure derivation of a runtime's user-facing "health" state from the raw
// server fields (status + last_seen_at). Splitting the offline state into
// time-bucketed flavors lets the UI distinguish "just lost — likely
// transient" from "long gone — needs attention" with no schema change.

import type { AgentRuntime } from "../types";
import {
  isRuntimeHeartbeatFresh,
  RUNTIME_HEARTBEAT_STALE_MS,
} from "@multiremi/contracts/runtime-health";
import type { RuntimeHealth } from "./types";

// The runtime sweeper GCs runtimes that have been offline for 7 days. We
// flag the last 24 hours of that window so users can rescue a runtime
// before it disappears silently.
const ABOUT_TO_GC_THRESHOLD_MS = 6 * 24 * 3600 * 1000; // 6 days

export function deriveRuntimeHealth(runtime: AgentRuntime, now: number): RuntimeHealth {
  const parsedLastSeen = runtime.last_seen_at
    ? Date.parse(runtime.last_seen_at)
    : Number.NaN;
  const lastSeen = Number.isFinite(parsedLastSeen) ? parsedLastSeen : null;

  if (
    runtime.status === "online" &&
    isRuntimeHeartbeatFresh(runtime.last_seen_at, now)
  ) {
    return "online";
  }

  // A missing or malformed heartbeat cannot establish how long the runtime
  // has been gone, so report the neutral offline state.
  if (lastSeen === null) return "offline";

  const offlineFor = now - lastSeen;

  // This state normally represents an explicit shutdown: the server already
  // marked the runtime offline even though its last heartbeat is still fresh.
  if (offlineFor < RUNTIME_HEARTBEAT_STALE_MS) return "recently_lost";
  if (offlineFor > ABOUT_TO_GC_THRESHOLD_MS) return "about_to_gc";
  return "offline";
}
