/**
 * MetricsCollector — Token usage metrics persistence layer.
 *
 * Stores token usage data as daily JSONL files under ~/.remi/metrics/.
 * Each line is a JSON object representing one request's token usage.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("metrics");

// ── Types ──────────────────────────────────────────────

export interface TokenMetricEntry {
  ts: string;                  // ISO-8601
  src: "remi" | "cli";        // data source
  sid: string | null;          // sessionId
  model: string | null;
  in: number;                  // inputTokens
  out: number;                 // outputTokens
  cacheCreate: number;         // cache_creation_input_tokens
  cacheRead: number;           // cache_read_input_tokens
  cost: number | null;         // costUsd
  dur: number | null;          // durationMs
  project: string | null;
  connector: string | null;
}

export interface DailySummary {
  date: string;
  totalIn: number;
  totalOut: number;
  totalCacheCreate: number;
  totalCacheRead: number;
  totalCost: number;
  requestCount: number;
  models: Record<string, { in: number; out: number; count: number }>;
  sources: Record<string, number>;
}

export interface UsageQuota {
  rateLimitType: string;    // "five_hour" | "seven_day" | "seven_day_sonnet" | "seven_day_opus"
  utilization: number;      // 0-100 percentage
  resetsAt: string;         // ISO-8601
  status: string;           // "allowed" | "rate_limited"
  updatedAt: string;        // ISO-8601
}

export interface AnalyticsSummary {
  today: DailySummary;
  week: DailySummary;   // last 7 days
  month: DailySummary;  // last 30 days
  dailyHistory: DailySummary[];
  usage: UsageQuota[];  // Claude subscription usage quotas
}

// ── MetricsCollector ──────────────────────────────────

export class MetricsCollector {
  readonly metricsDir: string;
  private _usageQuotas = new Map<string, UsageQuota>();

  constructor(remiDir: string) {
    this.metricsDir = join(remiDir, "metrics");
    if (!existsSync(this.metricsDir)) {
      mkdirSync(this.metricsDir, { recursive: true });
    }
    this._loadUsageQuotas();
  }

  /** Update a usage quota from a rate_limit event. */
  updateUsage(rateLimitType: string, resetsAt: string, status: string): void {
    const existing = this._usageQuotas.get(rateLimitType);
    this._usageQuotas.set(rateLimitType, {
      rateLimitType,
      utilization: existing?.utilization ?? 0,
      resetsAt,
      status,
      updatedAt: new Date().toISOString(),
    });
    this._saveUsageQuotas();
  }

  /** Fetch usage from Anthropic OAuth API and update quotas. */
  async fetchUsageFromAPI(): Promise<void> {
    const credPath = join(process.env.HOME ?? "", ".claude", ".credentials.json");
    if (!existsSync(credPath)) return;

    let token: string;
    try {
      const creds = JSON.parse(readFileSync(credPath, "utf-8"));
      token = creds?.claudeAiOauth?.accessToken;
      if (!token) return;
    } catch { return; }

    try {
      const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          "Authorization": `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return;

      const data = await resp.json() as Record<string, { utilization: number | null; resets_at: string } | null>;
      const now = new Date().toISOString();

      for (const [key, value] of Object.entries(data)) {
        if (!value || typeof value !== "object" || value.utilization === null || value.utilization === undefined) continue;
        const existing = this._usageQuotas.get(key);
        this._usageQuotas.set(key, {
          rateLimitType: key,
          utilization: value.utilization,
          resetsAt: value.resets_at ?? existing?.resetsAt ?? "",
          status: existing?.status ?? "allowed",
          updatedAt: now,
        });
      }
      this._saveUsageQuotas();
      log.info(`Usage quotas updated from API: ${[...this._usageQuotas.values()].map(q => `${q.rateLimitType}=${q.utilization}%`).join(", ")}`);
    } catch (e) {
      log.debug("Failed to fetch usage from API:", e);
    }
  }

  /** Get all known usage quotas (always re-reads from disk for cross-process visibility). */
  getUsageQuotas(): UsageQuota[] {
    this._loadUsageQuotas();
    return [...this._usageQuotas.values()];
  }

  private _loadUsageQuotas(): void {
    const p = join(this.metricsDir, ".usage-quotas.json");
    if (!existsSync(p)) return;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8")) as UsageQuota[];
      for (const q of data) this._usageQuotas.set(q.rateLimitType, q);
    } catch { /* ignore */ }
  }

  private _saveUsageQuotas(): void {
    const p = join(this.metricsDir, ".usage-quotas.json");
    try {
      writeFileSync(p, JSON.stringify([...this._usageQuotas.values()]), "utf-8");
    } catch { /* ignore */ }
  }

  /** Append a token metric entry to today's JSONL file. */
  record(entry: TokenMetricEntry): void {
    const date = entry.ts.slice(0, 10); // YYYY-MM-DD
    const filePath = join(this.metricsDir, `${date}.jsonl`);
    try {
      appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (e) {
      log.error("Failed to write metric entry:", e);
    }
  }

  /** Read and parse all entries for a given date. */
  readDay(date: string): TokenMetricEntry[] {
    const filePath = join(this.metricsDir, `${date}.jsonl`);
    if (!existsSync(filePath)) return [];

    const entries: TokenMetricEntry[] = [];
    try {
      const raw = readFileSync(filePath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
    } catch (e) {
      log.warn(`Failed to read metrics for ${date}:`, e);
    }
    return entries;
  }

  /** Aggregate entries for a date range into DailySummary[]. */
  getSummary(start: string, end: string): DailySummary[] {
    const dates = this.listDates().filter(d => d >= start && d <= end);
    return dates.map(date => this._summarizeDay(date));
  }

  /** Get analytics overview: today + 7d + 30d + daily history. */
  getAnalytics(): AnalyticsSummary {
    const now = new Date();
    const today = _dateStr(now);
    const week7 = _dateStr(new Date(now.getTime() - 6 * 86400000));
    const month30 = _dateStr(new Date(now.getTime() - 29 * 86400000));

    const allDailies = this.getSummary(month30, today);
    const todaySummary = allDailies.find(d => d.date === today) ?? _emptySummary(today);

    return {
      today: todaySummary,
      week: _mergeSummaries(allDailies.filter(d => d.date >= week7), "7d"),
      month: _mergeSummaries(allDailies, "30d"),
      dailyHistory: allDailies,
      usage: this.getUsageQuotas(),
    };
  }

  /** List available metric dates (YYYY-MM-DD), sorted descending. */
  listDates(): string[] {
    if (!existsSync(this.metricsDir)) return [];
    return readdirSync(this.metricsDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => f.replace(".jsonl", ""))
      .sort((a, b) => b.localeCompare(a));
  }

  /** Get most recent N metric entries across all dates. */
  getRecent(limit: number): TokenMetricEntry[] {
    const dates = this.listDates();
    const entries: TokenMetricEntry[] = [];

    for (const date of dates) {
      const dayEntries = this.readDay(date);
      entries.push(...dayEntries);
      if (entries.length >= limit) break;
    }

    // Sort by timestamp descending and take limit
    return entries
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, limit);
  }

  private _summarizeDay(date: string): DailySummary {
    const entries = this.readDay(date);
    const summary = _emptySummary(date);

    for (const e of entries) {
      summary.totalIn += e.in;
      summary.totalOut += e.out;
      summary.totalCacheCreate += e.cacheCreate;
      summary.totalCacheRead += e.cacheRead;
      summary.totalCost += e.cost ?? _estimateCost(e.model, e);
      summary.requestCount++;

      const model = e.model || "unknown";
      if (!summary.models[model]) {
        summary.models[model] = { in: 0, out: 0, count: 0 };
      }
      summary.models[model].in += e.in;
      summary.models[model].out += e.out;
      summary.models[model].count++;

      const src = e.src;
      summary.sources[src] = (summary.sources[src] ?? 0) + 1;
    }

    return summary;
  }
}

// ── Pricing (per million tokens, USD) ────────────────

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-opus-4-6":           { input: 15, output: 75, cacheRead: 1.5, cacheCreate: 18.75 },
  "claude-sonnet-4-6":         { input: 3,  output: 15, cacheRead: 0.3, cacheCreate: 3.75 },
  "claude-haiku-4-5-20251001": { input: 0.8, output: 4, cacheRead: 0.08, cacheCreate: 1 },
};

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheCreate: 3.75 };

function _estimateCost(model: string | null, entry: { in: number; out: number; cacheRead: number; cacheCreate: number }): number {
  const p = (model && MODEL_PRICING[model]) || DEFAULT_PRICING;
  return (
    (entry.in * p.input +
     entry.out * p.output +
     entry.cacheRead * p.cacheRead +
     entry.cacheCreate * p.cacheCreate) / 1_000_000
  );
}

// ── Helpers ──────────────────────────────────────────

function _dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function _emptySummary(date: string): DailySummary {
  return {
    date,
    totalIn: 0, totalOut: 0,
    totalCacheCreate: 0, totalCacheRead: 0,
    totalCost: 0, requestCount: 0,
    models: {}, sources: {},
  };
}

function _mergeSummaries(summaries: DailySummary[], label: string): DailySummary {
  const merged = _emptySummary(label);
  for (const s of summaries) {
    merged.totalIn += s.totalIn;
    merged.totalOut += s.totalOut;
    merged.totalCacheCreate += s.totalCacheCreate;
    merged.totalCacheRead += s.totalCacheRead;
    merged.totalCost += s.totalCost;
    merged.requestCount += s.requestCount;

    for (const [model, data] of Object.entries(s.models)) {
      if (!merged.models[model]) merged.models[model] = { in: 0, out: 0, count: 0 };
      merged.models[model].in += data.in;
      merged.models[model].out += data.out;
      merged.models[model].count += data.count;
    }

    for (const [src, count] of Object.entries(s.sources)) {
      merged.sources[src] = (merged.sources[src] ?? 0) + count;
    }
  }
  return merged;
}
