/** Runtime heartbeats older than this threshold are considered stale. */
export const RUNTIME_HEARTBEAT_STALE_MS = 5 * 60 * 1000;

/** Whether the last heartbeat is present, parseable, and within the stale threshold. */
export function isRuntimeHeartbeatFresh(
  lastSeenAt: string | null | undefined,
  nowMs: number,
): boolean {
  if (!lastSeenAt) return false;
  const lastSeenMs = Date.parse(lastSeenAt);
  return (
    Number.isFinite(lastSeenMs) &&
    nowMs - lastSeenMs <= RUNTIME_HEARTBEAT_STALE_MS
  );
}
