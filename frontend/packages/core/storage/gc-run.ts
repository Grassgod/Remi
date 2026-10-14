import type { GcRunMode, GcRunRequest } from "@multiremi/contracts/storage";
import { api } from "../api";

const POLL_INTERVAL_MS = 1_000;
// Client-side ceiling on the whole create→poll cycle. The server marks a run
// `timeout` after at most 20 minutes (10 pending + 10 running); staying above
// that lets its message surface before the generic client one fires, and a
// long first reclaim round is not reported as failed while it still runs.
const GC_RUN_POLL_TIMEOUT_MS = 21 * 60 * 1000;

// Designed for `useMutation` consumption: a dry run or reclaim is a
// user-triggered action, not read-through state.
export async function resolveRuntimeGcRun(
  runtimeId: string,
  mode: GcRunMode,
): Promise<GcRunRequest> {
  const initial = await api.createRuntimeGcRun(runtimeId, { mode });
  const start = Date.now();
  let current = initial;

  while (current.status === "pending" || current.status === "sent" || current.status === "running") {
    if (Date.now() - start > GC_RUN_POLL_TIMEOUT_MS) {
      throw new Error("storage run timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    current = await api.getRuntimeGcRun(runtimeId, initial.id);
  }

  if (current.status !== "completed") {
    throw new Error(current.error || "storage run failed");
  }
  return current;
}
