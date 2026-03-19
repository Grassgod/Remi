// Status
export interface SystemStatus {
  daemon: { alive: boolean; pid: number | null };
  sessions: { total: number; main: number; threads: number };
  tokens: { total: number; valid: number; nextExpiry: string | null };
  memory: { entities: number; entityTypes: string[]; dailyLogs: number; latestLog: string | null };
}

// Memory
export interface EntitySummary {
  type: string;
  name: string;
  tags: string[];
  summary: string;
  aliases: string[];
  related: string[];
  path: string;
  updatedAt: string;
}

export interface EntityDetail extends EntitySummary {
  content: string;
  body: string;
  createdAt: string;
}

export interface DailyLogEntry {
  date: string;
  size: number;
}

export interface DailyEntry {
  date: string;
  content: string;
}

export interface SearchResult {
  source: string;
  name: string;
  snippet: string;
  path: string;
}

// Sessions
export interface SessionEntry {
  key: string;
  sessionId: string;
  isThread: boolean;
}

// Auth
export interface TokenStatus {
  service: string;
  type: string;
  valid: boolean;
  expiresAt: number;
  expiresIn: string;
  refreshable: boolean;
}

// Config
export interface RemiConfig {
  [key: string]: unknown;
}

// Projects
export type ProjectMap = Record<string, string>; // alias → path

// Analytics
export interface TokenMetricEntry {
  ts: string;
  src: "remi" | "cli";
  sid: string | null;
  model: string | null;
  in: number;
  out: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number | null;
  dur: number | null;
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
  rateLimitType: string;
  utilization: number;
  resetsAt: string;
  status: string;
  updatedAt: string;
}

export interface AnalyticsSummary {
  today: DailySummary;
  week: DailySummary;
  month: DailySummary;
  dailyHistory: DailySummary[];
  usage: UsageQuota[];
}

// Traces
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  serviceName: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
  attributes: Record<string, string | number | boolean>;
  events?: Array<{ name: string; timestamp: string; attributes?: Record<string, string | number | boolean> }>;
}

export interface TraceData {
  traceId: string;
  rootSpan: SpanData;
  spans: SpanData[];
  startTime: string;
  endTime: string;
  durationMs: number;
  source?: string;
  status: "OK" | "ERROR" | "UNSET";
}

// Logs
export interface LogEntry {
  ts: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  module: string;
  msg: string;
  traceId?: string;
  spanId?: string;
  data?: Record<string, unknown>;
}

export interface LogQueryResult {
  entries: LogEntry[];
  total: number;
  hasMore: boolean;
}

// Monitor
export interface MonitorStats {
  uptime: number;
  activeSessions: number;
  requestsToday: number;
  requestsLastHour: number;
  errorsToday: number;
  errorRate: number;
  latencyP50: number | null;
  latencyP95: number | null;
  latencyAvg: number | null;
  tracesCount: number;
  logsCount: number;
  topOperations: Array<{ name: string; count: number; avgMs: number }>;
}

// Scheduler
export interface CronSchedule {
  kind: "cron" | "every" | "at";
  expr?: string;
  tz?: string;
  intervalMs?: number;
  at?: string;
}

export interface CronJobLastRun {
  status: "ok" | "error" | "skipped";
  finishedAt: string;
  durationMs: number;
  error?: string;
}

export interface SchedulerJobStatus {
  jobId: string;
  jobName: string;
  enabled: boolean;
  handler: string;
  schedule: CronSchedule;
  lastRun: CronJobLastRun | null;
  nextRunAt: string | null;
  consecutiveErrors: number;
}

export interface SchedulerStatus {
  jobs: SchedulerJobStatus[];
}

export interface CronRunEntry {
  ts: string;
  status: "ok" | "error" | "skipped";
  durationMs: number;
  error?: string;
  jobId?: string;
}

export interface DailySchedulerSummary {
  date: string;
  total: number;
  ok: number;
  error: number;
  skipped: number;
}

// Symlinks
export interface SymlinkMapping {
  source: string;
  target: string;
  type: "dir" | "file";
  status: "ok" | "broken" | "not_linked" | "missing_target";
}

export interface SymlinksStatus {
  mappings: SymlinkMapping[];
  stats: { total: number; ok: number; broken: number; notLinked: number };
}

// Database
export interface DbStats {
  dbPath: string;
  dbSizeBytes: number;
  journalMode: string;
  tables: {
    kv: { count: number };
    embeddings: { count: number };
  };
}

export interface KvEntry {
  key: string;
  value: string;
  updated_at: string;
}

export interface EmbeddingEntry {
  id: string;
  content_hash: string;
  metadata: Record<string, string> | null;
  embedded_at: string;
}
