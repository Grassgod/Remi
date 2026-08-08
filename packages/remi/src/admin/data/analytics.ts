/**
 * RemiData — Analytics.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { type AnalyticsSummary, type DailySummary, type TokenMetricEntry } from "@shared/metrics/collector.js";
import { RemiDataContext } from "./context.js";

export class AnalyticsData {
  private _analyticsCache: { data: AnalyticsSummary; ts: number } | null = null;
  private readonly _cacheTTL = 60_000; // 60s

  constructor(private readonly ctx: RemiDataContext) {}

  getAnalyticsSummary(): AnalyticsSummary {
    const now = Date.now();
    if (this._analyticsCache && now - this._analyticsCache.ts < this._cacheTTL) {
      return this._analyticsCache.data;
    }
    const data = this.ctx._metrics.getAnalytics();
    this._analyticsCache = { data, ts: now };
    return data;
  }

  getAnalyticsDaily(start: string, end: string): DailySummary[] {
    return this.ctx._metrics.getSummary(start, end);
  }

  getRecentMetrics(limit: number): TokenMetricEntry[] {
    return this.ctx._metrics.getRecent(limit);
  }

  async refreshUsageQuotas(): Promise<void> {
    await this.ctx._metrics.fetchUsageFromAPI();
    this._analyticsCache = null;
  }
}
