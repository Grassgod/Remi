import type { UsageReport, UsagePrice, SetUsagePriceInput } from "@multiremi/contracts/usage-accounting";
import type { HttpClient } from "../http";
import { parseStrictResponse } from "../schema";
import { UsagePriceSchema, UsagePricesSchema, UsageReportSchema } from "../schemas/usage-accounting";

export interface UsageReportParams {
  days?: number | "all";
  since?: string;
  until?: string;
  project_id?: string | null;
  runtime_id?: string | null;
  tz: string;
}

export class UsageAccountingEndpoints {
  constructor(readonly http: HttpClient) {}
  async getUsageReport(wsId: string, params: UsageReportParams): Promise<UsageReport> {
    const query = new URLSearchParams({ workspace_id: wsId, tz: params.tz });
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    const raw = await this.http.fetch<unknown>(`/api/usage/report?${query}`);
    return parseStrictResponse(raw, UsageReportSchema, { endpoint: "GET /api/usage/report" });
  }
  async getUsagePrices(wsId: string): Promise<UsagePrice[]> {
    const raw = await this.http.fetch<unknown>(`/api/usage/prices?workspace_id=${encodeURIComponent(wsId)}`);
    return parseStrictResponse<{ prices: UsagePrice[] }>(raw, UsagePricesSchema, { endpoint: "GET /api/usage/prices" }).prices;
  }
  async setUsagePrice(wsId: string, input: SetUsagePriceInput): Promise<UsagePrice> {
    const raw = await this.http.fetch<unknown>(`/api/usage/prices?workspace_id=${encodeURIComponent(wsId)}`, { method: "POST", body: JSON.stringify(input) });
    return parseStrictResponse(raw, UsagePriceSchema, { endpoint: "POST /api/usage/prices" });
  }
}
