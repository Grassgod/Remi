/**
 * RemiData — Status (aggregate).
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { getDb } from "@shared/db/index.js";
import { RemiDataContext } from "./context.js";

export class StatusData {
  constructor(private readonly ctx: RemiDataContext) {}

  getStatus() {
    const pid = this.ctx.host.getDaemonPid();
    const alive = this.ctx.host.isDaemonAlive();
    const tokens = this.ctx.host.readTokenStatus();
    const entities = this.ctx.host.listEntities();
    const dailyLogs = this.ctx.host.listDailyDates();

    // Session counts from DB
    let sessionTotal = 0, sessionMain = 0, sessionThreads = 0;
    try {
      const db = getDb();
      const rows = db.query("SELECT session_key FROM sessions").all() as { session_key: string }[];
      sessionTotal = rows.length;
      sessionThreads = rows.filter(r => r.session_key.includes(":thread:")).length;
      sessionMain = sessionTotal - sessionThreads;
    } catch {}

    return {
      daemon: { pid, alive },
      sessions: {
        total: sessionTotal,
        main: sessionMain,
        threads: sessionThreads,
      },
      tokens: {
        total: tokens.length,
        valid: tokens.filter(t => t.valid).length,
        nextExpiry: tokens.length > 0
          ? tokens.reduce((min, t) => t.expiresAt < min.expiresAt ? t : min).expiresIn
          : null,
      },
      memory: {
        entities: entities.length,
        entityTypes: [...new Set(entities.map(e => e.type))],
        dailyLogs: dailyLogs.length,
        latestLog: dailyLogs[0]?.date ?? null,
      },
    };
  }
}
