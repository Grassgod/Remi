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
  metadata?: Record<string, unknown>;
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

export interface SyncRule {
  name: string;
  source: string;
  target: string;
  format: string;
  key?: string;
  extraKeys?: Record<string, string>;
}

// Config
export interface RemiConfig {
  [key: string]: unknown;
}

// Projects
export type ProjectMap = Record<string, string>; // alias → path (legacy)

export type InitStepName = "create_chat" | "setup_dir" | "write_config" | "register_complete";
export type InitStepStatus = "pending" | "running" | "done" | "error";
export type ProjectInitStatus = "pending" | "running" | "completed" | "failed";

export interface InitStep {
  name: InitStepName;
  label: string;
  status: InitStepStatus;
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface Project {
  id: string;
  name: string;
  chatId: string | null;
  repoUrl: string | null;
  cwd: string | null;
  pipelineConfig: unknown | null;
  initStatus: ProjectInitStatus;
  initSteps: InitStep[];
  createdAt: string;
  updatedAt: string;
  groupCount?: number;
}

export interface ProjectInitInput {
  alias: string;
  name: string;
  repoUrl?: string;
  dirMode: "clone" | "existing";
  parentDir?: string;
  existingPath?: string;
}

export interface GroupConfig {
  chatId: string;
  projectId: string;
  name: string;
  monitor: boolean;
  replyMode: "thread" | "direct";
  systemPrompt: string;
  allowedTools: string[];
  allowedMcps: string[];
  addDirs: string[];
  provider?: string;
  cwd?: string;
  launchCommand?: string;
  createdAt: string;
  updatedAt: string;
  projectCwd?: string;
  projectName?: string;
}

export interface GroupConfigInput {
  chatId: string;
  projectId?: string;
  name?: string;
  monitor?: boolean;
  replyMode?: "thread" | "direct";
  systemPrompt?: string;
  allowedTools?: string[];
  allowedMcps?: string[];
  addDirs?: string[];
  provider?: string;
  cwd?: string;
  launchCommand?: string;
}

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
  allTime?: DailySummary;
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

// Traces — list item (flat, from DB)
export interface TraceListItem {
  id: number;
  status: string;
  durationMs: number;
  model: string | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  connector: string | null;
  chatId?: string;
  userMessage?: string;
  createdAt: string;
}

// Traces — stats (server-side aggregation)
export interface TraceStats {
  total: number;
  processing: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  p95DurationMs: number;
}

// Traces — tool call from JSONL
export interface ToolCallData {
  name: string;
  input: Record<string, unknown>;
  output: string;
  durationMs: number;
  status: "ok" | "error";
}

// Traces — detail (DB meta + JSONL tool calls)
export interface TraceDetail {
  meta: {
    status: string;
    durationMs: number;
    model: string | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    connector: string | null;
    chatId: string;
    senderName: string | null;
    threadId?: string;
    messageId?: string;
    sessionId?: string;
  };
  userMessage: string | null;
  toolCalls: ToolCallData[];
  jsonlAvailable: boolean;
  remiSpans: Array<{ op: string; ms: number }>;
  timeline: TraceTimelineEntry[];
}

export interface TraceTimelineEntry {
  name: string;
  startMs: number;
  durationMs: number;
  depth: number;
  toolIndex?: number;
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
  pm2Memory: number | null;
  pm2Restarts: number | null;
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
  config?: Record<string, unknown>;
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
  phase?: string;
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
  category: "soul" | "global" | "memory" | "wiki" | "project";
  projectAlias: string | null;
  parentHash: string | null;
}

export interface SymlinksStatus {
  mappings: SymlinkMapping[];
  stats: { total: number; ok: number; broken: number; notLinked: number };
}

// Database
export interface DbTableInfo {
  name: string;
  rowCount: number;
  type: string;
}

export interface DbStats {
  dbPath: string;
  dbSizeBytes: number;
  journalMode: string;
  sqliteVersion: string;
  vecEnabled: boolean;
  tables: DbTableInfo[];
  totalTables: number;
  totalRows: number;
}

export interface DbColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

export interface DbIndexInfo {
  name: string;
  unique: boolean;
  columns: string[];
  sql: string | null;
}

export interface DbTableSchema {
  name: string;
  type: "table" | "virtual";
  sql: string;
  columns: DbColumnInfo[];
  indexes: DbIndexInfo[];
}

export interface DbSchemaResponse {
  tables: DbTableSchema[];
}

export interface DbTableDataResponse {
  tableName: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated?: boolean;
  executionMs: number;
  type: "query" | "execute";
  changes?: number;
  error?: string;
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

// Conversations
export interface ConversationSummary {
  id: string;
  chatId: string;
  threadId: string | null;
  sessionId?: string;
  topic: string;
  messageCount: number;
  tokenCount: number;
  totalCost: number;
  updatedAt: string;
  status: "active" | "completed";
}

export interface ChatMessage {
  id: string;
  type: string;
  content: string;
  senderType: "user" | "app";
  senderId: string;
  createTime: string;
  steps?: StepItem[];
  sessionName?: string;
  meta?: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    cost: number | null;
    duration: number;
    toolCount?: number;
    sessionId?: string;
    traceId?: number;
  };
}

export interface StepItem {
  type: "thinking" | "tool";
  content: string;
  name?: string;
  thinking?: string;  // merged thinking before tool (if type=tool)
}

// Missions
export interface MissionItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  projectId: string;
  chatId: string;
  threadId: string | null;
  currentStep: string;
  mrUrl: string | null;
  mrStatus: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  totalTokens: number;
  totalCost: number;
  totalDuration: number;
}

export interface MissionStats {
  total: number;
  byStatus: Record<string, number>;
  totalCost: number;
  totalTokens: number;
}

// Wiki
export interface WikiFileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: WikiFileNode[];
}

export interface WikiFileContent {
  content: string;
  lastModified?: string;
  gitInfo?: { hash: string; message: string; author: string; date: string };
}

export interface WikiGitEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

// ── Memory – Recall Debug ──

export interface RecallLayerResult {
  name: string;
  ran: boolean;
  durationMs: number;
  candidateCount: number;
  exitedEarly?: boolean;
  reason?: string;
  matches: Array<{ source: string; name: string; snippet: string }>;
}

export interface RecallDebugResult {
  query: string;
  result: string;
  totalMs: number;
  layers: RecallLayerResult[];
}

// ── Memory – Project Memories ──

export interface ProjectMemory {
  projectId: string;
  projectName: string;
  projectPath: string;
  hasMemoryMd: boolean;
  memoryMdSize: number;
  files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }>;
}

// ── Traces – List Response ──

export interface TraceListResponse {
  items: TraceListItem[];
  hasMore: boolean;
}

// ── Logs – Stats ──

export interface LogStats {
  total: number;
  levels: { DEBUG: number; INFO: number; WARN: number; ERROR: number };
  hourly: Array<{ hour: number; count: number; errors: number }>;
  moduleCount: number;
  topModules: string[];
  lastError: string | null;
  lastErrorModule: string | null;
}

// ── Conversations – Chat Info ──

export interface ChatInfo {
  chatId: string;
  name: string;
  conversationCount: number;
  messageCount: number;
  isP2P: boolean;
}

// ── Missions – Detail ──

export interface ContractCase {
  id: string;
  description: string;
  input: string;
  expectedOutput: string;
  type: "unit" | "integration" | "e2e";
}

export interface MissionDetailItem extends MissionItem {
  outputDir: string | null;
  contract: {
    cases?: ContractCase[];
    acceptanceCriteria: string[];
    verificationResults?: {
      caseResults: Array<{ caseId: string; passed: boolean; detail: string }>;
      overallPassed: boolean;
      verifiedAt: string;
    };
  } | null;
}

// ── Skills ──

export interface SkillInfo {
  name: string;
  description: string;
  hasSchedule: boolean;
  cron?: string;
  outputDir?: string;
  reportCount?: number;
  lastReportDate?: string;
}

export interface SkillFileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: SkillFileNode[];
}

// ── Agents ──

export interface AgentInfo {
  name: string;
  cwd: string;
  model: string;
  trigger: string;
  cron?: string;
  debounce_ms?: number;
  timeoutMs: number;
  mcp: boolean;
  description: string;
  permissions: { mcpTools: string[]; cliTools: string[] };
  skills: string[];
  lastRun: AgentRunEntry | null;
  runsToday: number;
  successRate7d: number;
}

export interface AgentDetail {
  claudeMd: string;
  settingsJson: string;
  skills: Array<{ name: string; content: string }>;
}

export interface AgentRunEntry {
  ts: string;
  agent: string;
  model: string;
  exit: number;
  duration_ms: number;
  stdout_len: number;
  stderr_len: number;
}

// ── MCP ──

export interface McpScope {
  id: string;
  label: string;
  path: string;
  mcpJsonPath: string;
  serverCount: number;
  hasConfig: boolean;
}

export interface McpScopeDetail {
  raw: string;
  servers: Array<{
    name: string;
    command: string;
    args: string[];
    envKeys: string[];
  }>;
}
