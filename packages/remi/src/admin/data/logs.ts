/**
 * RemiData — Logs.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { join } from "node:path";
import { readLogEntries, type LogEntry } from "@shared/logger.js";
import { RemiDataContext } from "./context.js";

export class LogsData {
  constructor(private readonly ctx: RemiDataContext) {}

  getLogs(query: { date: string; level?: string | null; module?: string | null; traceId?: string | null; search?: string | null; limit: number; offset: number }): { entries: LogEntry[]; total: number; hasMore: boolean } {
    const logsDir = join(this.ctx.root, "logs");
    let entries = readLogEntries(query.date, logsDir);

    // Apply filters
    if (query.level) {
      const lvl = query.level.toUpperCase();
      entries = entries.filter(e => e.level === lvl);
    }
    if (query.module) {
      entries = entries.filter(e => e.module === query.module);
    }
    if (query.traceId) {
      entries = entries.filter(e => e.traceId === query.traceId);
    }
    if (query.search) {
      const s = query.search.toLowerCase();
      entries = entries.filter(e => e.msg.toLowerCase().includes(s));
    }

    const total = entries.length;
    // Reverse to show most recent first, then apply offset+limit
    entries.reverse();
    const sliced = entries.slice(query.offset, query.offset + query.limit);
    return { entries: sliced, total, hasMore: query.offset + query.limit < total };
  }

  getLogModules(date?: string): string[] {
    const logsDir = join(this.ctx.root, "logs");
    const d = date ?? new Date().toISOString().slice(0, 10);
    const entries = readLogEntries(d, logsDir);
    return [...new Set(entries.map(e => e.module))].sort();
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
    const logsDir = join(this.ctx.root, "logs");
    const d = query?.date ?? new Date().toISOString().slice(0, 10);
    let entries = readLogEntries(d, logsDir);

    // Apply same filters as getLogs
    if (query?.level) {
      const lvl = query.level.toUpperCase();
      entries = entries.filter(e => e.level === lvl);
    }
    if (query?.module) {
      entries = entries.filter(e => e.module === query.module);
    }
    if (query?.traceId) {
      entries = entries.filter(e => e.traceId === query.traceId);
    }
    if (query?.search) {
      const s = query.search.toLowerCase();
      entries = entries.filter(e => e.msg.toLowerCase().includes(s));
    }

    const levels = { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 };
    const hourly: Array<{ hour: number; count: number; errors: number }> = Array.from(
      { length: 24 }, (_, i) => ({ hour: i, count: 0, errors: 0 })
    );
    const moduleCounts: Record<string, number> = {};
    let lastError: string | null = null;
    let lastErrorModule: string | null = null;

    for (const e of entries) {
      if (e.level in levels) levels[e.level as keyof typeof levels]++;
      try {
        const hour = new Date(e.ts).getHours();
        if (hour >= 0 && hour < 24) {
          hourly[hour].count++;
          if (e.level === "ERROR") hourly[hour].errors++;
        }
      } catch { /* skip entries with unparseable timestamps */ }
      moduleCounts[e.module] = (moduleCounts[e.module] ?? 0) + 1;
      if (e.level === "ERROR") {
        if (!lastError || e.ts > lastError) {
          lastError = e.ts;
          lastErrorModule = e.module;
        }
      }
    }

    const topModules = Object.entries(moduleCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);

    return {
      total: entries.length,
      levels,
      hourly,
      moduleCount: Object.keys(moduleCounts).length,
      topModules,
      lastError,
      lastErrorModule,
    };
  }
}
