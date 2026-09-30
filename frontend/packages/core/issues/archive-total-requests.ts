import type { QueryClient, QueryKey } from "@tanstack/react-query";

const requestsByClient = new WeakMap<QueryClient, Map<string, symbol>>();

export function createArchivedTotalWriter(
  client: QueryClient, wsId: string, countKey: QueryKey, queryKey: QueryKey, signal: () => AbortSignal,
) {
  let requests = requestsByClient.get(client);
  if (!requests) {
    requests = new Map();
    requestsByClient.set(client, requests);
  }
  const request = Symbol();
  requests.set(wsId, request);
  const updates = client.getQueryState(countKey)?.dataUpdateCount ?? 0;
  const finish = () => {
    if (requests.get(wsId) !== request) return;
    requests.delete(wsId);
    if (!requests.size && requestsByClient.get(client) === requests) requestsByClient.delete(client);
  };
  // Cancel/clear/remove settle the retryer even if the transport never settles.
  // Reading Query.promise does not consume the context's lazy abort signal.
  void client.getQueryCache().find({ queryKey, exact: true })?.promise?.then(finish, finish);
  const publish = (total: number | undefined) => {
    if (requests.get(wsId) !== request
      || (client.getQueryState(countKey)?.dataUpdateCount ?? 0) !== updates
      || signal().aborted) return;
    if (total === undefined) throw new Error("List response is missing requested archived_total");
    client.setQueryData(countKey, total);
  };
  return { publish, finish };
}

// Internal test inspection; this module is not part of the package exports.
export function archivedTotalRequestStateForTesting(client: QueryClient) {
  const requests = requestsByClient.get(client);
  return { count: requests?.size ?? 0, hasClient: !!requests };
}
