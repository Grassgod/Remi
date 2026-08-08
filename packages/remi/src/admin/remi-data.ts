/**
 * RemiData — File-system data access layer for ~/.remi/
 *
 * Reads/writes Remi's persistent data directly from disk.
 * Zero dependency on Remi core — completely decoupled.
 *
 * The implementation is split by domain under `./data/`; this class is the
 * facade the admin handler layer talks to. Every method below delegates to the
 * domain that owns it, so the public surface is unchanged.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type { AnalyticsSummary, DailySummary, TokenMetricEntry } from "@shared/metrics/collector.js";
import type { TraceData } from "@shared/tracing.js";
import type { LogEntry } from "@shared/logger.js";
import type { RecallDebugResult } from "@memory/store.js";
import type { ToolCallData } from "../conversation/tool-calls.js";
import type { DailyLogEntry, EntityDetail, EntitySummary, SearchResult, TokenStatus } from "./data/types.js";
import { RemiDataContext } from "./data/context.js";
import { SoulData } from "./data/soul.js";
import { MemoryEntitiesData } from "./data/entities.js";
import { MemorySearchData } from "./data/search.js";
import { DailyLogsData } from "./data/daily.js";
import { TokenSyncData } from "./data/tokens.js";
import { ConfigData } from "./data/config.js";
import { DaemonData } from "./data/daemon.js";
import { StatusData } from "./data/status.js";
import { AnalyticsData } from "./data/analytics.js";
import { TracesData } from "./data/traces.js";
import { LogsData } from "./data/logs.js";
import { MonitorData } from "./data/monitor.js";
import { SchedulerData } from "./data/scheduler.js";
import { SkillsData } from "./data/skills.js";
import { McpData } from "./data/mcp.js";

export type {
  EntitySummary,
  EntityDetail,
  TokenStatus,
  DailyLogEntry,
  SearchResult,
} from "./data/types.js";
export type { RecallDebugResult } from "@memory/store.js";

export class RemiData {
  readonly root: string;       // ~/.remi
  readonly memoryDir: string;  // ~/.remi/memory
  private readonly ctx: RemiDataContext;
  private readonly _soul: SoulData;
  private readonly _entities: MemoryEntitiesData;
  private readonly _search: MemorySearchData;
  private readonly _daily: DailyLogsData;
  private readonly _tokens: TokenSyncData;
  private readonly _config: ConfigData;
  private readonly _daemon: DaemonData;
  private readonly _status: StatusData;
  private readonly _analytics: AnalyticsData;
  private readonly _traces: TracesData;
  private readonly _logs: LogsData;
  private readonly _monitor: MonitorData;
  private readonly _scheduler: SchedulerData;
  private readonly _skills: SkillsData;
  private readonly _mcp: McpData;

  constructor(remiDir?: string) {
    this.root = remiDir ?? join(homedir(), ".remi");
    this.memoryDir = join(this.root, "memory");
    this.ctx = new RemiDataContext(this.root, () => this);
    this._soul = new SoulData(this.ctx);
    this._entities = new MemoryEntitiesData(this.ctx);
    this._search = new MemorySearchData(this.ctx);
    this._daily = new DailyLogsData(this.ctx);
    this._tokens = new TokenSyncData(this.ctx);
    this._config = new ConfigData(this.ctx);
    this._daemon = new DaemonData(this.ctx);
    this._status = new StatusData(this.ctx);
    this._analytics = new AnalyticsData(this.ctx);
    this._traces = new TracesData(this.ctx);
    this._logs = new LogsData(this.ctx);
    this._monitor = new MonitorData(this.ctx);
    this._scheduler = new SchedulerData(this.ctx);
    this._skills = new SkillsData(this.ctx);
    this._mcp = new McpData(this.ctx);
  }

  readSoul(): string {
    return this._soul.readSoul();
  }
  writeSoul(content: string): void {
    return this._soul.writeSoul(content);
  }

  listEntities(): EntitySummary[] {
    return this._entities.listEntities();
  }
  listProjectMemories(): Array<{
    projectId: string;
    projectName: string;
    projectPath: string;
    hasMemoryMd: boolean;
    memoryMdSize: number;
    files: Array<{ name: string; type: string; summary: string; path: string; updatedAt: string }>;
  }> {
    return this._entities.listProjectMemories();
  }
  readProjectMemoryFile(projectId: string, filePath: string): string {
    return this._entities.readProjectMemoryFile(projectId, filePath);
  }
  readEntity(type: string, name: string): EntityDetail | null {
    return this._entities.readEntity(type, name);
  }
  createEntity(opts: { type: string; name: string; observation?: string; tags?: string[]; summary?: string }): void {
    return this._entities.createEntity(opts);
  }
  updateEntity(type: string, name: string, content: string): boolean {
    return this._entities.updateEntity(type, name, content);
  }
  deleteEntity(type: string, name: string): boolean {
    return this._entities.deleteEntity(type, name);
  }

  searchMemory(query: string): SearchResult[] {
    return this._search.searchMemory(query);
  }
  async recallDebug(query: string, cwd?: string): Promise<RecallDebugResult> {
    return await this._search.recallDebug(query, cwd);
  }

  listDailyDates(): DailyLogEntry[] {
    return this._daily.listDailyDates();
  }
  readDaily(date: string): string {
    return this._daily.readDaily(date);
  }

  readSyncRules(): Array<{ name: string; source: string; target: string; format: string; key?: string; extraKeys?: Record<string, string> }> {
    return this._tokens.readSyncRules();
  }
  saveSyncRules(rules: Array<{ name: string; source: string; target: string; format: string; key?: string; extraKeys?: Record<string, string> }>): boolean {
    return this._tokens.saveSyncRules(rules);
  }
  previewSyncRule(source: string, target: string): { sourceContent: string | null; targetContent: string | null } {
    return this._tokens.previewSyncRule(source, target);
  }
  readTokenStatus(): TokenStatus[] {
    return this._tokens.readTokenStatus();
  }

  readConfig(): Record<string, any> {
    return this._config.readConfig();
  }
  updateConfig(patch: Record<string, any>): boolean {
    return this._config.updateConfig(patch);
  }

  getDaemonPid(): number | null {
    return this._daemon.getDaemonPid();
  }
  isDaemonAlive(): boolean {
    return this._daemon.isDaemonAlive();
  }

  getStatus() {
    return this._status.getStatus();
  }

  getAnalyticsSummary(): AnalyticsSummary {
    return this._analytics.getAnalyticsSummary();
  }
  getAnalyticsDaily(start: string, end: string): DailySummary[] {
    return this._analytics.getAnalyticsDaily(start, end);
  }
  getRecentMetrics(limit: number): TokenMetricEntry[] {
    return this._analytics.getRecentMetrics(limit);
  }
  async refreshUsageQuotas(): Promise<void> {
    return await this._analytics.refreshUsageQuotas();
  }

  getTraces(opts: {
    date: string;
    limit: number;
    offset?: number;
    status?: string;
    search?: string;
  }): { items: Array<{
    id: number;
    status: string;
    durationMs: number;
    model: string | null;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    connector: string | null;
    chatId: string | null;
    messageId: string | null;
    userMessage: string | null;
    createdAt: string;
  }>; hasMore: boolean } {
    return this._traces.getTraces(opts);
  }
  getTrace(traceId: string): TraceData | null {
    return this._traces.getTrace(traceId);
  }
  getTraceStats(date: string): {
    total: number;
    processing: number;
    errors: number;
    errorRate: number;
    avgDurationMs: number;
    p95DurationMs: number;
  } {
    return this._traces.getTraceStats(date);
  }
  getTraceDetail(id: number): {
    meta: {
      status: string;
      durationMs: number;
      model: string | null;
      costUsd: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      connector: string | null;
      chatId: string;
      threadId: string | null;
      messageId: string | null;
      senderName: string | null;
      sessionId: string | null;
    };
    userMessage: string | null;
    toolCalls: ToolCallData[];
    jsonlAvailable: boolean;
    remiSpans: Array<{ op: string; ms: number }>;
    timeline: Array<{
      name: string;
      startMs: number;
      durationMs: number;
      depth: number;
      toolIndex?: number;
    }>;
  } | null {
    return this._traces.getTraceDetail(id);
  }
  getTraceDetailByMessageId(messageId: string): ReturnType<TracesData["getTraceDetail"]> {
    return this._traces.getTraceDetailByMessageId(messageId);
  }

  getLogs(query: { date: string; level?: string | null; module?: string | null; traceId?: string | null; search?: string | null; limit: number; offset: number }): { entries: LogEntry[]; total: number; hasMore: boolean } {
    return this._logs.getLogs(query);
  }
  getLogModules(date?: string): string[] {
    return this._logs.getLogModules(date);
  }
  getLogStats(query?: { date?: string; level?: string | null; module?: string | null; search?: string | null; traceId?: string | null }): {
    total: number;
    levels: { DEBUG: number; INFO: number; WARN: number; ERROR: number };
    hourly: Array<{ hour: number; count: number; errors: number }>;
    moduleCount: number;
    topModules: string[];
    lastError: string | null;
    lastErrorModule: string | null;
  } {
    return this._logs.getLogStats(query);
  }

  getMonitorStats(): Record<string, unknown> {
    return this._monitor.getMonitorStats();
  }

  getSchedulerStatus() {
    return this._scheduler.getSchedulerStatus();
  }
  getSchedulerHistory(jobId?: string, limit = 50): Array<{ ts: string; status: string; durationMs: number; error?: string; jobId: string; runId?: string; phase?: string }> {
    return this._scheduler.getSchedulerHistory(jobId, limit);
  }
  getSchedulerSummary(days: number) {
    return this._scheduler.getSchedulerSummary(days);
  }

  listSkillScopes(): Array<{ scope: string; label: string; path: string; count: number }> {
    return this._skills.listSkillScopes();
  }
  listSkills(scope?: string): Array<{
    name: string; description: string; hasSchedule: boolean;
    cron?: string; outputDir?: string; reportCount?: number; lastReportDate?: string;
  }> {
    return this._skills.listSkills(scope);
  }
  getSkillTree(name: string, scope?: string): { name: string; path: string; type: "file" | "directory"; children?: any[] }[] | null {
    return this._skills.getSkillTree(name, scope);
  }
  getSkillsBasePath(scope?: string): string {
    return this._skills.getSkillsBasePath(scope);
  }
  readSkillFile(name: string, path = "SKILL.md", scope?: string): string | null {
    return this._skills.readSkillFile(name, path, scope);
  }
  writeSkillFile(name: string, content: string, path = "SKILL.md", scope?: string): boolean {
    return this._skills.writeSkillFile(name, content, path, scope);
  }
  listSkillReports(name: string, scope?: string): string[] {
    return this._skills.listSkillReports(name, scope);
  }
  readSkillReport(name: string, date: string, scope?: string): string | null {
    return this._skills.readSkillReport(name, date, scope);
  }

  listMcpServers(): Array<{ name: string; command: string; args: string[] }> {
    return this._mcp.listMcpServers();
  }
  listMcpScopes(): Array<{
    id: string;
    label: string;
    path: string;
    mcpJsonPath: string;
    serverCount: number;
    hasConfig: boolean;
  }> {
    return this._mcp.listMcpScopes();
  }
  getMcpScopeDetail(scopeId: string): {
    raw: string;
    servers: Array<{
      name: string;
      command: string;
      args: string[];
      envKeys: string[];
    }>;
  } | null {
    return this._mcp.getMcpScopeDetail(scopeId);
  }
  writeMcpScope(scopeId: string, content: string): { ok: boolean; error?: string } {
    return this._mcp.writeMcpScope(scopeId, content);
  }
  deleteMcpServer(scopeId: string, serverName: string): { ok: boolean; error?: string } {
    return this._mcp.deleteMcpServer(scopeId, serverName);
  }
  mergeMcpServers(scopeId: string, input: string): { ok: boolean; added: string[]; error?: string } {
    return this._mcp.mergeMcpServers(scopeId, input);
  }
}
