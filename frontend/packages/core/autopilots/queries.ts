import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import type { ListAutopilotRunsResponse } from "../types";

export const autopilotKeys = {
  all: (wsId: string) => ["autopilots", wsId] as const,
  list: (wsId: string) => [...autopilotKeys.all(wsId), "list"] as const,
  detail: (wsId: string, id: string) =>
    [...autopilotKeys.all(wsId), "detail", id] as const,
  runs: (wsId: string, id: string) =>
    [...autopilotKeys.all(wsId), "runs", id] as const,
  run: (wsId: string, autopilotId: string, runId: string) =>
    [...autopilotKeys.all(wsId), "runs", autopilotId, runId] as const,
  deliveries: (wsId: string, id: string) =>
    [...autopilotKeys.all(wsId), "deliveries", id] as const,
  delivery: (wsId: string, autopilotId: string, deliveryId: string) =>
    [...autopilotKeys.all(wsId), "deliveries", autopilotId, deliveryId] as const,
};

export function autopilotListOptions(wsId: string) {
  return queryOptions({
    queryKey: autopilotKeys.list(wsId),
    queryFn: () => api.listAutopilots(),
    select: (data) => data.autopilots,
  });
}

export function autopilotDetailOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: autopilotKeys.detail(wsId, id),
    queryFn: () => api.getAutopilot(id),
  });
}

// Statuses after which a run can no longer change. `issue_created` is the
// terminal state for create_issue / trigger_issue autopilots — progress after
// that point lives on the issue, not on the run row.
const TERMINAL_RUN_STATUSES = new Set(["issue_created", "completed", "failed", "skipped"]);

export const ACTIVE_RUN_POLL_INTERVAL_MS = 2_500;
export const EMPTY_RUNS_POLL_INTERVAL_MS = 10_000;

// Conditional polling for the run-history list:
// - any non-terminal run → fast poll (a run is executing right now)
// - empty list → slow poll (waiting for the first run to appear, e.g. right
//   after a wiki build or webhook was fired from another page)
// - all terminal → stop polling entirely.
export function autopilotRunsRefetchInterval(
  data: ListAutopilotRunsResponse | undefined,
): number | false {
  if (!data) return false;
  if (data.runs.length === 0) return EMPTY_RUNS_POLL_INTERVAL_MS;
  return data.runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))
    ? ACTIVE_RUN_POLL_INTERVAL_MS
    : false;
}

export function autopilotRunsOptions(wsId: string, id: string) {
  return queryOptions({
    queryKey: autopilotKeys.runs(wsId, id),
    queryFn: () => api.listAutopilotRuns(id),
    select: (data) => data.runs,
    // Note: refetchInterval sees the raw (pre-`select`) cached response.
    refetchInterval: (query) => autopilotRunsRefetchInterval(query.state.data),
  });
}

// autopilotRunOptions fetches a single run with its full trigger_payload.
// The list endpoint (autopilotRunsOptions) omits trigger_payload to keep
// list responses small; callers (e.g. the run-detail dialog) use this
// query on demand when the user opens a run.
export function autopilotRunOptions(
  wsId: string,
  autopilotId: string,
  runId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: autopilotKeys.run(wsId, autopilotId, runId),
    queryFn: () => api.getAutopilotRun(autopilotId, runId),
    enabled: options?.enabled ?? true,
  });
}

// autopilotDeliveriesOptions powers the Deliveries section in the autopilot
// detail page. The list is slim — raw_body / selected_headers / response_body
// are omitted server-side. Detail rows are fetched on-demand when the user
// expands a row (see autopilotDeliveryOptions).
export function autopilotDeliveriesOptions(
  wsId: string,
  autopilotId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: autopilotKeys.deliveries(wsId, autopilotId),
    queryFn: () => api.listAutopilotDeliveries(autopilotId),
    select: (data) => data.deliveries,
    enabled: options?.enabled ?? true,
  });
}

// autopilotDeliveryOptions fetches the full delivery row including raw_body
// and headers subset. Used by the detail dialog opened from a list row.
export function autopilotDeliveryOptions(
  wsId: string,
  autopilotId: string,
  deliveryId: string,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: autopilotKeys.delivery(wsId, autopilotId, deliveryId),
    queryFn: () => api.getAutopilotDelivery(autopilotId, deliveryId),
    enabled: options?.enabled ?? true,
  });
}
