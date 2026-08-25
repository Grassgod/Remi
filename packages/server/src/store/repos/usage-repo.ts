// Usage / activity aggregation domain (token + runtime rollups), extracted verbatim from
// MultiremiStore (the facade delegates every public method here).
import { nullableString, parseTaskUsageEntries, type RuntimeUsageEntry } from "@multiremi/store/helpers.js";
import { type StoreContext } from "@multiremi/store/context.js";
import type {
  MultiremiAgentRuntime,
  MultiremiRuntimeDaily,
  MultiremiRuntimeUsage,
  MultiremiTaskActivityByHour,
  MultiremiUsageByAgent,
  MultiremiUsageByHour,
  MultiremiUsageDaily,
} from "@multiremi/contracts/types.js";

type Row = Record<string, unknown>;

export class UsageRepo {
  constructor(private ctx: StoreContext) {}

  listRuntimeUsage(runtimeId?: string | null): MultiremiRuntimeUsage[] {
    if (runtimeId !== undefined && runtimeId !== null && !this.ctx.runtimes().getRuntime(runtimeId)) {
      throw new Error(`Runtime not found: ${runtimeId}`);
    }
    const rows = runtimeId === undefined
      ? this.ctx.db.query("SELECT id, runtime_id, usage FROM multiremi_tasks WHERE runtime_id IS NOT NULL").all() as Row[]
      : runtimeId === null
        ? this.ctx.db.query("SELECT id, runtime_id, usage FROM multiremi_tasks WHERE runtime_id IS NULL").all() as Row[]
        : this.ctx.db.query("SELECT id, runtime_id, usage FROM multiremi_tasks WHERE runtime_id = ?").all(runtimeId) as Row[];
    const usage = new Map<string, MultiremiRuntimeUsage & { taskIds: Set<string> }>();
    for (const row of rows) {
      const rowRuntimeId = nullableString(row.runtime_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [rowRuntimeId ?? "", entry.provider, entry.model].join("\u0000");
        const current = usage.get(key) ?? {
          runtimeId: rowRuntimeId,
          provider: entry.provider,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        current.inputTokens += entry.inputTokens;
        current.outputTokens += entry.outputTokens;
        current.cacheReadTokens += entry.cacheReadTokens;
        current.cacheWriteTokens += entry.cacheWriteTokens;
        current.taskIds.add(String(row.id));
        usage.set(key, current);
      }
    }
    return [...usage.values()]
      .map(({ taskIds, ...entry }) => ({ ...entry, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.provider.localeCompare(right.provider) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiUsageDaily[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MultiremiUsageDaily & { taskIds: Set<string> }>();
    for (const row of rows) {
      const date = usageDate(row, input.tz);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [date, nullableString(row.runtime_id) ?? "", entry.provider, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          date,
          runtimeId: nullableString(row.runtime_id),
          provider: entry.provider,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.model.localeCompare(right.model));
  }

  listUsageByAgent(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiUsageByAgent[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MultiremiUsageByAgent & { taskIds: Set<string> }>();
    for (const row of rows) {
      const agentId = String(row.agent_id);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [agentId, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          agentId,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) =>
        (right.inputTokens + right.outputTokens + right.cacheReadTokens + right.cacheWriteTokens) -
        (left.inputTokens + left.outputTokens + left.cacheReadTokens + left.cacheWriteTokens) ||
        left.agentId.localeCompare(right.agentId) ||
        left.model.localeCompare(right.model),
      );
  }

  listUsageByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiUsageByHour[] {
    const rows = this.filteredUsageTaskRows(input);
    const buckets = new Map<string, MultiremiUsageByHour & { taskIds: Set<string> }>();
    for (const row of rows) {
      const hour = usageHour(row, input.tz);
      for (const entry of parseTaskUsageEntries(row.usage)) {
        const key = [hour, entry.model].join("\u0000");
        const current = buckets.get(key) ?? {
          hour,
          model: entry.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          taskCount: 0,
          taskIds: new Set<string>(),
        };
        addUsageTotals(current, entry);
        current.taskIds.add(String(row.id));
        buckets.set(key, current);
      }
    }
    return [...buckets.values()]
      .map(({ taskIds, ...row }) => ({ ...row, taskCount: taskIds.size }))
      .sort((left, right) => left.hour - right.hour || left.model.localeCompare(right.model));
  }

  listTaskActivityByHour(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiTaskActivityByHour[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const counts = new Map<number, number>();
    for (const row of rows) {
      const hour = usageHour(row, input.tz);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((left, right) => left.hour - right.hour);
  }

  listRuntimeDaily(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiRuntimeDaily[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const buckets = new Map<string, MultiremiRuntimeDaily>();
    for (const row of rows) {
      const date = usageDate(row, input.tz);
      const current = buckets.get(date) ?? { date, totalSeconds: 0, taskCount: 0, failedCount: 0 };
      current.taskCount += 1;
      if (String(row.status ?? "") === "failed") current.failedCount += 1;
      current.totalSeconds += taskRunSeconds(row);
      buckets.set(date, current);
    }
    return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date));
  }

  /** Per-agent run-time rollup for the dashboard leaderboard: every task in
   *  the window counts (usage-less tasks included), grouped by the agent that
   *  ran it — the same row set listRuntimeDaily buckets by date, so the
   *  leaderboard totals always reconcile with the overview cards. */
  listAgentRuntime(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  } = {}): MultiremiAgentRuntime[] {
    const rows = this.filteredUsageTaskRows(input, { includeTasksWithoutUsage: true });
    const buckets = new Map<string, MultiremiAgentRuntime>();
    for (const row of rows) {
      const agentId = String(row.agent_id ?? "");
      const current = buckets.get(agentId) ?? { agentId, totalSeconds: 0, taskCount: 0, failedCount: 0 };
      current.taskCount += 1;
      if (String(row.status ?? "") === "failed") current.failedCount += 1;
      current.totalSeconds += taskRunSeconds(row);
      buckets.set(agentId, current);
    }
    return [...buckets.values()].sort((left, right) =>
      right.totalSeconds - left.totalSeconds ||
      right.taskCount - left.taskCount ||
      left.agentId.localeCompare(right.agentId),
    );
  }


  private filteredUsageTaskRows(input: {
    workspaceId?: string | null;
    projectId?: string | null;
    runtimeId?: string | null;
    days?: number;
    tz?: string | null;
  }, options: { includeTasksWithoutUsage?: boolean } = {}): Row[] {
    const clauses = ["1 = 1"];
    const params: Array<string | number | null> = [];
    const workspaceId = input.workspaceId ?? "local";
    if (workspaceId) {
      clauses.push("t.workspace_id = ?");
      params.push(workspaceId);
    }
    if (input.projectId) {
      clauses.push("i.project_id = ?");
      params.push(input.projectId);
    }
    if (input.runtimeId !== undefined) {
      if (input.runtimeId === null) {
        clauses.push("t.runtime_id IS NULL");
      } else {
        if (!this.ctx.runtimes().getRuntime(input.runtimeId)) throw new Error(`Runtime not found: ${input.runtimeId}`);
        clauses.push("t.runtime_id = ?");
        params.push(input.runtimeId);
      }
    }
    const since = usageSince(input.days, input.tz);
    if (since) {
      clauses.push("COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) >= ?");
      params.push(since);
    }
    if (!options.includeTasksWithoutUsage) {
      clauses.push("t.usage IS NOT NULL AND t.usage != '[]' AND t.usage != ''");
    }
    return this.ctx.db.query(
      `SELECT t.*
       FROM multiremi_tasks t
       LEFT JOIN multiremi_issues i ON i.id = t.issue_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY COALESCE(t.completed_at, t.failed_at, t.cancelled_at, t.started_at, t.dispatched_at, t.updated_at, t.created_at) ASC`,
    ).all(...params) as Row[];
  }
}

function usageTimestamp(row: Row): string {
  return String(
    row.completed_at ??
    row.failed_at ??
    row.cancelled_at ??
    row.started_at ??
    row.dispatched_at ??
    row.updated_at ??
    row.created_at,
  );
}

function usageDate(row: Row, tz?: string | null): string {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return String(row.created_at ?? "").slice(0, 10);
  const formatter = tz ? tzFormatter(tz, "date") : null;
  if (formatter) return formatter.format(date);
  return date.toISOString().slice(0, 10);
}

function usageHour(row: Row, tz?: string | null): number {
  const date = new Date(usageTimestamp(row));
  if (!Number.isFinite(date.getTime())) return 0;
  const formatter = tz ? tzFormatter(tz, "hour") : null;
  if (formatter) {
    const hour = Number(formatter.format(date));
    // "24" appears for midnight under some ICU versions (h23 vs h24 quirks).
    if (Number.isFinite(hour)) return hour === 24 ? 0 : hour;
  }
  return date.getUTCHours();
}

// Day/hour bucketing follows the viewer's timezone (`tz` query param) so the
// "daily" chart cuts at the user's midnight, not UTC's. Invalid tz values are
// remembered as null so a bad client can't pay the try/catch cost per row.
const tzFormatters = new Map<string, Intl.DateTimeFormat | null>();

function tzFormatter(tz: string, kind: "date" | "hour"): Intl.DateTimeFormat | null {
  const key = `${kind} ${tz}`;
  if (tzFormatters.has(key)) return tzFormatters.get(key)!;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = kind === "date"
      // en-CA renders as YYYY-MM-DD, matching the UTC slice() format.
      ? new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      : new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" });
  } catch {
    formatter = null;
  }
  tzFormatters.set(key, formatter);
  return formatter;
}

/**
 * Cutoff for the "last N days" window. With a viewer tz this is the LOCAL
 * CALENDAR boundary — midnight (in tz) of the day (N-1) days before the
 * viewer's today — so `days=1` means "the viewer's today", matching how the
 * frontend slices the tz-bucketed daily rows. A rolling `now - N*24h` cutoff
 * would disagree with those buckets at the window edge and make the by-agent
 * leaderboard sum exceed the daily-chart totals. Without a (valid) tz the
 * cutoff falls back to UTC calendar days for the same consistency reason.
 */
function usageSince(days: number | undefined, tz?: string | null): string | null {
  const value = Number(days ?? 30);
  if (!Number.isFinite(value) || value <= 0) return null;
  const capped = Math.min(365, Math.floor(value));
  const now = new Date();
  const formatter = tz ? tzFormatter(tz, "date") : null;
  const today = formatter ? formatter.format(now) : now.toISOString().slice(0, 10);
  const [year, month, day] = today.split("-").map(Number);
  if (!year || !month || day === undefined) return new Date(now.getTime() - capped * 24 * 60 * 60 * 1000).toISOString();
  // Start of the window as a calendar date (Date.UTC normalizes a negative
  // day-of-month), then resolved to the FIRST VALID instant of that local
  // date. "Local midnight" is not safe to solve for directly: on DST
  // spring-forward days midnight may not exist (America/Santiago jumps
  // 23:59 → 01:00), and offset-refinement loops oscillate there. The local
  // date of an instant IS monotonic in the instant, so binary-search the
  // boundary instead: offsets span -12h..+14h, so the day boundary lies
  // strictly inside a ±15h bracket around the UTC midnight of the target.
  const windowStartUtc = Date.UTC(year, month - 1, day - (capped - 1));
  if (!formatter || !tz) return new Date(windowStartUtc).toISOString();
  const targetDate = new Date(windowStartUtc).toISOString().slice(0, 10);
  let below = windowStartUtc - 15 * 60 * 60 * 1000; // local date < targetDate here
  let atOrAfter = windowStartUtc + 15 * 60 * 60 * 1000; // local date >= targetDate here
  while (atOrAfter - below > 1) {
    const mid = Math.floor((below + atOrAfter) / 2);
    // en-CA YYYY-MM-DD compares lexicographically as a date.
    if (formatter.format(new Date(mid)) < targetDate) below = mid;
    else atOrAfter = mid;
  }
  return new Date(atOrAfter).toISOString();
}

function taskRunSeconds(row: Row): number {
  const start = Date.parse(String(row.started_at ?? row.dispatched_at ?? row.created_at));
  const end = Date.parse(String(row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.floor((end - start) / 1000);
}

function addUsageTotals(
  target: Pick<RuntimeUsageEntry, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"> & { totalTokens?: number },
  entry: RuntimeUsageEntry,
): void {
  target.inputTokens += entry.inputTokens;
  target.outputTokens += entry.outputTokens;
  target.cacheReadTokens += entry.cacheReadTokens;
  target.cacheWriteTokens += entry.cacheWriteTokens;
  if (target.totalTokens !== undefined) target.totalTokens += entry.totalTokens;
}
