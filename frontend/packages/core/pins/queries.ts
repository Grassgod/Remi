import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const pinKeys = {
  all: (wsId: string, userId: string) => ["pins", wsId, userId] as const,
  list: (wsId: string, userId: string) => [...pinKeys.all(wsId, userId), "list"] as const,
};

export function pinListOptions(
  wsId: string,
  userId: string,
  /** `false` keeps the cached list but does not fetch (MUL-472 b). */
  options: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: pinKeys.list(wsId, userId),
    queryFn: () => api.listPins(),
    enabled: options.enabled ?? true,
  });
}
