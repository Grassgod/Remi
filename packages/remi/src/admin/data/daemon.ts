/**
 * RemiData — Daemon (PM2-based detection).
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RemiDataContext } from "./context.js";

export class DaemonData {
  constructor(private readonly ctx: RemiDataContext) {}

  getDaemonPid(): number | null {
    const remi = this.ctx._getPm2Apps().find(a => a.name === "remi");
    if (remi?.pid && remi.pm2_env?.status === "online") return remi.pid;

    // Fallback: PID file
    const p = join(this.ctx.root, "remi.pid");
    if (!existsSync(p)) return null;
    try { return parseInt(readFileSync(p, "utf-8").trim(), 10); } catch { return null; }
  }

  isDaemonAlive(): boolean {
    const remi = this.ctx._getPm2Apps().find(a => a.name === "remi");
    if (remi) return remi.pm2_env?.status === "online";

    // Fallback: PID file + kill(0)
    const pid = this.getDaemonPid();
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
}
