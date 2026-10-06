import type { AgentRuntime } from "@multiremi/core/types";
import { deriveRuntimeHealth } from "@multiremi/core/runtimes";

// The compact token formatter lives with the other cross-view formatters.
// Re-exported here because every usage table in this directory reaches for it
// through `../utils` alongside the aggregation helpers it renders.
export { formatTokens } from "../common/format";

// A live local daemon re-registers itself within seconds of a server-side
// delete (daemon self-heal, #2404), so deleting an online local runtime from
// the UI has no lasting effect. Both the detail page and the list row menu
// gate their Delete affordance on this same predicate.
export function isSelfHealingRuntime(
  runtime: AgentRuntime,
  now = Date.now(),
): boolean {
  return (
    runtime.runtime_mode === "local" &&
    deriveRuntimeHealth(runtime, now) === "online"
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// Compound-unit relative timestamp ("2m 14s ago", "1d 4h ago", "6d 19h ago")
// — gives the user enough precision to tell "just lost" from "long lost"
// at a glance without forcing them to mouse-over for a full timestamp.
export function formatLastSeen(lastSeenAt: string | null): string {
  if (!lastSeenAt) return "Never";
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 5_000) return "Just now";

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return `${seconds}s ago`;
  if (hours < 1) {
    const s = seconds % 60;
    return s > 0 ? `${minutes}m ${s}s ago` : `${minutes}m ago`;
  }
  if (days < 1) {
    const m = minutes % 60;
    return m > 0 ? `${hours}h ${m}m ago` : `${hours}h ago`;
  }
  const h = hours % 24;
  return h > 0 ? `${days}d ${h}h ago` : `${days}d ago`;
}

// Turns the back-end's `device_info` string ("MacBook-Pro · darwin-amd64",
// "some-host · linux-amd64") into something humans recognise. We don't have
// hardware model or geo data on the wire today, so we settle for an OS-aware
// rewrite of the GOOS/GOARCH suffix while preserving the hostname.
export function formatDeviceInfo(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed
    .split(" · ")
    .map((part) => prettifyOsArch(part))
    .join(" · ");
}

function prettifyOsArch(part: string): string {
  const lower = part.toLowerCase();
  // Pattern: <os>-<arch>; e.g. darwin-amd64, linux-arm64, windows-amd64.
  const match = lower.match(/^(darwin|linux|windows|freebsd|openbsd|netbsd)-(amd64|arm64|386|arm)$/);
  if (!match) return part;
  const os = match[1] ?? "";
  const arch = match[2] ?? "";
  const osLabel = OS_LABEL[os] ?? os;
  const archLabel = ARCH_LABEL[arch] ?? arch;
  return `${osLabel} (${archLabel})`;
}

const OS_LABEL: Record<string, string> = {
  darwin: "macOS",
  linux: "Linux",
  windows: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
  netbsd: "NetBSD",
};

const ARCH_LABEL: Record<string, string> = {
  amd64: "x86_64",
  arm64: "arm64",
  "386": "x86",
  arm: "arm",
};

// Strip leading "v" from version strings — GitHub releases ship `v0.2.17`,
// daemon metadata reports `0.2.15`; normalising lets us compare both.
function stripVersionPrefix(v: string): string {
  return v.replace(/^v/, "");
}

// True iff `latest` is strictly newer than `current` by dotted-numeric
// comparison. Non-numeric / missing segments compare as 0 ("0.2" < "0.2.1").
// Used by the runtime-list CLI column to decide whether to surface the ↑
// marker; same logic also lives inline in update-section.tsx for now.
export function isVersionNewer(latest: string, current: string): boolean {
  const l = stripVersionPrefix(latest).split(".").map(Number);
  const c = stripVersionPrefix(current).split(".").map(Number);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] ?? 0;
    const cv = c[i] ?? 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}


// ---------------------------------------------------------------------------
// Cost estimation
