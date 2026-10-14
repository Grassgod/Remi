import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

// `wsId` isolates the cache per workspace; the request itself is scoped by the
// ApiClient workspace header, as for every other workspace query.
export const storageKeys = {
  all: (wsId: string) => ["storage", wsId] as const,
  settings: (wsId: string) => [...storageKeys.all(wsId), "settings"] as const,
  daemons: (wsId: string) => [...storageKeys.all(wsId), "daemons"] as const,
};

export function workspaceStorageOptions(wsId: string) {
  return queryOptions({
    queryKey: storageKeys.settings(wsId),
    queryFn: () => api.getWorkspaceStorage(wsId),
    enabled: Boolean(wsId),
  });
}

export function workspaceStorageDaemonsOptions(wsId: string) {
  return queryOptions({
    queryKey: storageKeys.daemons(wsId),
    queryFn: () => api.listWorkspaceStorageDaemons(wsId),
    enabled: Boolean(wsId),
  });
}
