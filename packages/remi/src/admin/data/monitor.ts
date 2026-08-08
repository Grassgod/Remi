/**
 * RemiData — Monitor.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@shared/db/index.js";
import { RemiDataContext } from "./context.js";

export class MonitorData {
  constructor(private readonly ctx: RemiDataContext) {}

  getMonitorStats(): Record<string, unknown> {
    const today = new Date().toISOString().slice(0, 10);

    // Uptime from PM2
    let uptime = 0;
    let pm2Memory: number | null = null;
    let pm2Restarts: number | null = null;
    const remiApp = this.ctx._getPm2Apps().find(a => a.name === "remi");
    if (remiApp?.pm2_env?.pm_uptime) {
      uptime = Math.floor((Date.now() - remiApp.pm2_env.pm_uptime) / 1000);
      pm2Memory = remiApp.monit?.memory ?? null;
      pm2Restarts = remiApp.pm2_env.restart_time ?? null;
    } else {
      // Fallback: PID file mtime
      const pidFile = join(this.ctx.root, "remi.pid");
      if (existsSync(pidFile)) {
        try {
          const stat = statSync(pidFile);
          uptime = Math.floor((Date.now() - stat.mtimeMs) / 1000);
        } catch { /* ignore */ }
      }
    }

    // Active sessions
    let activeSessions = 0;
    const sessionsFile = join(this.ctx.root, "sessions.json");
    if (existsSync(sessionsFile)) {
      try {
        const data = JSON.parse(readFileSync(sessionsFile, "utf-8"));
        activeSessions = data.entries?.length ?? 0;
      } catch { /* ignore */ }
    }

    // Metrics for today
    const todayMetrics = this.ctx._metrics.readDay(today);
    const requestsToday = todayMetrics.length;

    // Requests in the last hour
    const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
    const requestsLastHour = todayMetrics.filter(m => m.ts >= oneHourAgo).length;

    // Trace stats from DB
    const convRows = getDb().query(`
      SELECT status, duration_ms, spans FROM conversations WHERE DATE(created_at) = ?
    `).all(today) as Array<{ status: string; duration_ms: number | null; spans: string | null }>;

    const traceTotal = convRows.length;
    const errorSpansCount = convRows.filter(r => r.status === "failed").length;
    const errorRate = traceTotal > 0 ? (errorSpansCount / traceTotal) * 100 : 0;

    const durations = convRows
      .map(r => r.duration_ms ?? 0)
      .filter(d => d > 0)
      .sort((a, b) => a - b);

    const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)] : null;
    const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)] : null;
    const avg = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

    // Top operations from spans JSON
    const opMap = new Map<string, { count: number; totalMs: number }>();
    for (const row of convRows) {
      let spanArr: Array<{ op: string; ms?: number }> = [];
      try { spanArr = JSON.parse(row.spans ?? "[]"); } catch { /* skip */ }
      for (const s of spanArr) {
        const existing = opMap.get(s.op);
        if (existing) {
          existing.count++;
          existing.totalMs += s.ms ?? 0;
        } else {
          opMap.set(s.op, { count: 1, totalMs: s.ms ?? 0 });
        }
      }
    }
    const topOperations = [...opMap.entries()]
      .map(([name, data]) => ({ name, count: data.count, avgMs: Math.round(data.totalMs / data.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Log count
    const logsDir = join(this.ctx.root, "logs");
    let logsCount = 0;
    const logFile = join(logsDir, `${today}.jsonl`);
    if (existsSync(logFile)) {
      try {
        logsCount = readFileSync(logFile, "utf-8").split("\n").filter(l => l.trim()).length;
      } catch { /* ignore */ }
    }

    return {
      uptime,
      activeSessions,
      requestsToday,
      requestsLastHour,
      errorsToday: errorSpansCount,
      errorRate: Math.round(errorRate * 10) / 10,
      latencyP50: p50,
      latencyP95: p95,
      latencyAvg: avg,
      tracesCount: traceTotal,
      logsCount,
      topOperations,
      pm2Memory,
      pm2Restarts,
    };
  }
}
