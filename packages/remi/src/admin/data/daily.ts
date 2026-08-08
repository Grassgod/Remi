/**
 * RemiData — Memory: daily logs.
 *
 * Moved verbatim out of `admin/remi-data.ts`; `RemiData` delegates here.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DailyLogEntry } from "./types.js";
import { RemiDataContext } from "./context.js";

export class DailyLogsData {
  constructor(private readonly ctx: RemiDataContext) {}

  listDailyDates(): DailyLogEntry[] {
    const dailyDir = join(this.ctx.memoryDir, "daily");
    if (!existsSync(dailyDir)) return [];

    return readdirSync(dailyDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => {
        const stat = statSync(join(dailyDir, f));
        return { date: f.replace(".md", ""), size: stat.size };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  readDaily(date: string): string {
    const p = join(this.ctx.memoryDir, "daily", `${date}.md`);
    return existsSync(p) ? readFileSync(p, "utf-8") : "";
  }
}
