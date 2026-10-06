import { queryOptions, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SetUsagePriceInput } from "@multiremi/contracts/usage-accounting";
import type { UsageReportParams } from "../api/endpoints/usage-accounting";
import { api } from "../api";

export const usageKeys = {
  all: (wsId: string) => ["usage-accounting", wsId] as const,
  report: (wsId: string, params: UsageReportParams) => [...usageKeys.all(wsId), "report", params] as const,
  prices: (wsId: string) => [...usageKeys.all(wsId), "prices"] as const,
};
export function usageReportOptions(wsId: string, params: UsageReportParams) {
  return queryOptions({ queryKey: usageKeys.report(wsId, params), queryFn: () => api.getUsageReport(wsId, params), enabled: Boolean(wsId),
    staleTime: 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false });
}
export function usagePricesOptions(wsId: string, enabled = true) {
  return queryOptions({ queryKey: usageKeys.prices(wsId), queryFn: () => api.getUsagePrices(wsId), enabled: Boolean(wsId) && enabled, staleTime: 60_000 });
}
export function useSetUsagePrice(wsId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: SetUsagePriceInput) => api.setUsagePrice(wsId, input),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: usageKeys.all(wsId) }); } });
}
