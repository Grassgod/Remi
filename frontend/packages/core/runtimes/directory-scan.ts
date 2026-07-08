import { api } from "../api";
import type {
  CreateRuntimeDirectoryScanRequest,
  RuntimeDirectoryScanRequest,
} from "../types";

const POLL_INTERVAL_MS = 500;
// Client-side ceiling on the whole initiate→poll cycle.
//
// Timeout invariant: SCAN_POLL_TIMEOUT_MS must exceed the server's own
// pending (180s) + running (60s) timeouts
// (RUNTIME_DIRECTORY_SCAN_PENDING_TIMEOUT_MS +
// RUNTIME_DIRECTORY_SCAN_RUNNING_TIMEOUT_MS in src/multiremi/store/store.ts).
// The server marks a stalled request `timeout` with a message that tells the
// user their daemon may need updating; keeping this client timeout larger
// lets that server-side message surface before the generic client one fires.
const SCAN_POLL_TIMEOUT_MS = 270_000; // 4.5 minutes

// Designed for `useMutation` consumption (a plain async fn), not a cached
// query — a directory scan is a user-triggered action, not read-through state.
export async function resolveRuntimeDirectoryScan(
  runtimeId: string,
  params?: CreateRuntimeDirectoryScanRequest,
): Promise<RuntimeDirectoryScanRequest> {
  const initial = await api.initiateDirectoryScan(runtimeId, params);
  const start = Date.now();
  let current = initial;

  while (current.status === "pending" || current.status === "running") {
    if (Date.now() - start > SCAN_POLL_TIMEOUT_MS) {
      throw new Error("runtime directory scan timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await api.getDirectoryScanResult(runtimeId, initial.id);
  }

  if (current.status === "failed" || current.status === "timeout") {
    throw new Error(current.error || "runtime directory scan failed");
  }

  return current;
}
