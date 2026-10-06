/** Recorded actual consumption is separate from diagnostic context occupancy. */
export interface TaskUsageUnit {
  unitId: string;
  revision: number;
  provider: string;
  model: string | null;
  modelSource?: "provider_reported" | "session_acknowledged" | "configured" | "unknown";
  purpose?: string;
  requestedModel?: string | null;
  connectionId?: string | null;
  scope: "request" | "turn" | "task";
  source: "provider_request" | "provider_turn" | "legacy_task" | "context_snapshot";
  accuracy: "exact" | "partial" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  actualUnsplitTokens: number | null;
  reportedTotalTokens: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  costAmount: number | null;
  costCurrency: string | null;
  costSource?: "provider_reported" | "sdk_estimate" | "unknown";
  occurredAt: string;
  evidenceRef?: string | null;
}

/** A cumulative snapshot of one execution attempt; retries have distinct run IDs. */
export interface TaskUsageSnapshot {
  version: 2;
  runId: string;
  revision: number;
  complete: boolean;
  units: TaskUsageUnit[];
}

export interface UsageStatusCounts {
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
  queued: number;
}

export interface UsageMetrics {
  actual_input_tokens: number;
  actual_output_tokens: number;
  actual_cache_read_tokens: number;
  actual_cache_write_tokens: number;
  actual_unsplit_tokens: number;
  actual_total_tokens: number;
  unknown_task_count: number;
  context_peak_tokens: number | null;
  task_count: number;
  total_seconds: number;
  known_cost_by_currency: Record<string, number>;
  /** Published flat rates and SDK estimates do not establish applicable billing. */
  reference_cost_by_currency?: Record<string, number>;
  sdk_estimate_cost_by_currency?: Record<string, number>;
  priced_tokens: number;
  unpriced_tokens: number;
  price_quality: "provider_reported" | "configured" | "published" | "mixed" | "unknown";
  complete: boolean;
  status_counts: UsageStatusCounts;
}

export interface UsageReport {
  summary: UsageMetrics;
  daily: Array<UsageMetrics & { date: string }>;
  by_agent: Array<UsageMetrics & { agent_id: string }>;
  by_model: Array<UsageMetrics & { provider: string; model: string | null; requested_model: string | null; model_source: "reported" | "requested" | "unknown"; model_provenance: string; purpose?: string; connection_id: string | null }>;
  by_runtime: Array<UsageMetrics & { runtime_id: string | null; runtime_provenance: string }>;
  task_daily: Array<{ date: string; task_count: number; total_seconds: number; status_counts: UsageStatusCounts }>;
  time_basis: { consumption: "unit_occurred_at"; terminal_tasks: "terminal_lifecycle_at"; active_tasks: "current_snapshot" };
  coverage: { priced_tokens: number; unpriced_tokens: number; token_ratio: number | null; unknown_task_count: number };
  as_of: string;
  pricing_revision: string;
  window: { since: string | null; until: string | null; days: number | null; tz: string; project_id: string | null; runtime_id: string | null };
}

export interface UsagePrice {
  id: string;
  workspace_id: string;
  provider: string;
  model: string;
  connection_id: string | null;
  requested_model_alias: boolean;
  currency: string;
  input_per_million: number | null;
  output_per_million: number | null;
  cache_read_per_million: number | null;
  cache_write_per_million: number | null;
  unsplit_per_million: number | null;
  source: "configured" | "published";
  source_url: string | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export type SetUsagePriceInput = Omit<UsagePrice, "id" | "workspace_id" | "created_at">;
