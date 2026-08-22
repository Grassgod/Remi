import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const platformLifecycleKeys = {
  all: ["platform-lifecycle"] as const,
  status: () => ["platform-lifecycle", "status"] as const,
};

export function platformStatusOptions() {
  return queryOptions({
    queryKey: platformLifecycleKeys.status(),
    queryFn: () => api.getPlatformStatus(),
    retry: false,
    refetchInterval: (query) => query.state.data?.activeOperation ? 2_000 : 30_000,
  });
}
