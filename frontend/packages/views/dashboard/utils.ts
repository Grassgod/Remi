import type {
  DashboardUsageDaily,
  DashboardUsageByAgent,
  DashboardAgentRunTime,
  DashboardRunTimeDaily,
} from "@multiremi/core/types";
import {
  addDaysIso,
  estimateCost,
  formatDateLabel,
  formatShortDate,
  isModelPriced,
  todayIso,
  weekStartIso,
} from "../runtimes/utils";
import type {
  DailyTimeData,
  DailyTasksData,
  WeeklyTimeData,
  WeeklyTasksData,
} from "../runtimes/components/charts";

// ---------------------------------------------------------------------------
// Dashboard data aggregations
//
// The workspace dashboard returns the same per-(date, model) and
// per-(agent, model) shapes the runtime page does, so the daily cost / token
// aggregation and every piece of cost math come straight from the runtimes
// utils (`aggregateByDate`, `estimateCost`, `estimateCostBreakdown`). Only
// the run-time and task rollups below are dashboard-specific — the runtime
// page has no equivalent of those endpoints.
// ---------------------------------------------------------------------------

export interface DashboardTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  taskCount: number;
}

// Whole-window totals for the KPI tiles. taskCount sums DISTINCT task counts
// per row — these are already collapsed server-side per (date, model), so
// the value can over-count if the same task has tokens in two days; that's
// acceptable for a KPI ("rough volume") and the per-agent run-time card
// gives the precise figure.
export function computeDailyTotals(usage: DashboardUsageDaily[]): DashboardTokenTotals {
  return usage.reduce<DashboardTokenTotals>(
    (acc, u) => ({
      input: acc.input + u.input_tokens,
      output: acc.output + u.output_tokens,
      cacheRead: acc.cacheRead + u.cache_read_tokens,
      cacheWrite: acc.cacheWrite + u.cache_write_tokens,
      cost: acc.cost + estimateCost(u),
      taskCount: acc.taskCount + u.task_count,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, taskCount: 0 },
  );
}

export interface AgentCostRow {
  agentId: string;
  tokens: number;
  cost: number;
  taskCount: number;
  /** Tokens whose model didn't resolve to a price — they contribute $0 to
   *  `cost`, so a non-zero value here means `cost` under-reports. */
  unpricedTokens: number;
}

// Fold per-(agent, model) rows into one row per agent. Cost is the sum
// across this agent's models, which is the figure the user cares about.
// Sort by cost desc so the heaviest spender lands first.
export function aggregateAgentTokens(rows: DashboardUsageByAgent[]): AgentCostRow[] {
  const map = new Map<string, AgentCostRow>();
  for (const r of rows) {
    const entry = map.get(r.agent_id) ?? {
      agentId: r.agent_id,
      tokens: 0,
      cost: 0,
      taskCount: 0,
      unpricedTokens: 0,
    };
    const rowTokens =
      r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
    entry.tokens += rowTokens;
    entry.cost += estimateCost(r);
    if (!isModelPriced(r.model)) entry.unpricedTokens += rowTokens;
    entry.taskCount += r.task_count;
    map.set(r.agent_id, entry);
  }
  return Array.from(map.values()).toSorted((a, b) => b.cost - a.cost);
}

export interface AgentDashboardRow {
  agentId: string;
  tokens: number;
  cost: number;
  seconds: number;
  taskCount: number;
  /** True when `cost` cannot honestly be stated as a dollar figure (MUL-93):
   *  either every recorded token belongs to an unpriced model (cost would
   *  read $0.00 while spend clearly happened), or the agent ran tasks but no
   *  token usage was recorded at all, so cost is underivable. The UI renders
   *  "—" instead of $0.00 for these rows. */
  costUnavailable: boolean;
  /** True when a run-time rollup row backed this agent. Without one,
   *  `seconds: 0` means "no terminal run recorded" (e.g. tokens reported by
   *  an in-flight task) — rendering it as "<1m" would fabricate a duration,
   *  so the UI shows "—" instead. */
  hasRunTime: boolean;
}

// Merge per-agent token totals with per-agent run-time totals into one
// row per agent.
//
// taskCount comes from `runTimeRows` when available — that rollup is a
// true per-agent distinct count (`COUNT(*)` on (agent, terminal-task) in
// SQL). The token rollup's per-(agent, model) counts double-count a task
// when it spans multiple models, so we only fall back to it for agents
// with no terminal run yet (in-flight tasks reported tokens but haven't
// completed). Sorted by cost desc, then run time desc.
export function mergeAgentDashboardRows(
  tokenRows: AgentCostRow[],
  runTimeRows: DashboardAgentRunTime[],
): AgentDashboardRow[] {
  const runTimeByAgent = new Map(
    runTimeRows.map((r) => [r.agent_id, r] as const),
  );
  const merged = new Map<string, AgentDashboardRow>();
  for (const r of tokenRows) {
    const rt = runTimeByAgent.get(r.agentId);
    merged.set(r.agentId, {
      agentId: r.agentId,
      tokens: r.tokens,
      cost: r.cost,
      seconds: rt?.total_seconds ?? 0,
      taskCount: rt ? rt.task_count : r.taskCount,
      // Tokens recorded but every model unpriced → $0.00 would be fabricated.
      costUnavailable: r.tokens > 0 && r.cost === 0 && r.unpricedTokens > 0,
      hasRunTime: rt !== undefined,
    });
  }
  // Agents with run-time rows but zero tokens still belong on the list
  // (a task that errored before producing usage). Their token columns
  // stay at 0 — that's a factual "no usage recorded" — but cost is marked
  // unavailable because a dollar figure can't be derived from unrecorded
  // usage.
  for (const r of runTimeRows) {
    if (merged.has(r.agent_id)) continue;
    merged.set(r.agent_id, {
      agentId: r.agent_id,
      tokens: 0,
      cost: 0,
      seconds: r.total_seconds,
      taskCount: r.task_count,
      costUnavailable: r.task_count > 0,
      hasRunTime: true,
    });
  }
  return Array.from(merged.values()).toSorted((a, b) => {
    if (b.cost !== a.cost) return b.cost - a.cost;
    return b.seconds - a.seconds;
  });
}

// ---------------------------------------------------------------------------
// Weekly fold for run-time + tasks. Mirrors `aggregateByWeek` in
// `runtimes/utils.ts` which already covers cost / tokens — same calendar
// week semantics (Mon–Sun anchored at today-in-tz), same pre-zeroed buckets,
// same partial-week metadata. Workspace dashboard uses the user-chosen
// timezone here; the runtime page uses the runtime's IANA tz. Behaviour is
// identical apart from where the tz comes from.
// ---------------------------------------------------------------------------

interface WeekShell {
  weekStart: string;
  weekEnd: string;
  label: string;
  rangeLabel: string;
  partial: boolean;
  daysCovered: number;
}

// Build N trailing calendar week shells anchored at today-in-tz. Each shell
// carries the labels and partial-week metadata the chart components consume;
// downstream aggregators fold their own per-week values onto the matching
// shell.
function buildWeekShells(tz: string, weekCount: number): WeekShell[] {
  const count = Math.max(1, Math.floor(weekCount));
  const today = todayIso(tz);
  const currentWeekStart = weekStartIso(today);
  const firstWeekStart = addDaysIso(currentWeekStart, -(count - 1) * 7);
  const shells: WeekShell[] = [];
  for (let i = 0; i < count; i++) {
    const weekStart = addDaysIso(firstWeekStart, i * 7);
    const weekEnd = addDaysIso(weekStart, 6);
    const partial = today < weekEnd;
    // Inclusive count of how many days of this week have actually elapsed.
    // Closed weeks sit at 7; the current week reports 1..6.
    const clampedToday =
      today < weekStart ? weekStart : today < weekEnd ? today : weekEnd;
    const elapsed = Math.min(7, Math.max(1, diffDaysIso(weekStart, clampedToday) + 1));
    shells.push({
      weekStart,
      weekEnd,
      label: formatShortDate(weekStart),
      rangeLabel: `${formatShortDate(weekStart)} – ${formatShortDate(weekEnd)}`,
      partial,
      daysCovered: partial ? elapsed : 7,
    });
  }
  return shells;
}

function diffDaysIso(from: string, to: string): number {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const a = Date.UTC(y1 ?? 1970, (m1 ?? 1) - 1, d1 ?? 1);
  const b = Date.UTC(y2 ?? 1970, (m2 ?? 1) - 1, d2 ?? 1);
  return Math.round((b - a) / 86_400_000);
}

export function aggregateWeeklyTime(
  rows: DashboardRunTimeDaily[],
  tz: string,
  weekCount: number,
): WeeklyTimeData[] {
  const shells = buildWeekShells(tz, weekCount);
  const totals = new Map<string, number>();
  for (const shell of shells) totals.set(shell.weekStart, 0);
  for (const r of rows) {
    const wkStart = weekStartIso(r.date);
    if (!totals.has(wkStart)) continue;
    totals.set(wkStart, (totals.get(wkStart) ?? 0) + r.total_seconds);
  }
  return shells.map((s) => ({ ...s, totalSeconds: totals.get(s.weekStart) ?? 0 }));
}

export function aggregateWeeklyTasks(
  rows: DashboardRunTimeDaily[],
  tz: string,
  weekCount: number,
): WeeklyTasksData[] {
  const shells = buildWeekShells(tz, weekCount);
  const buckets = new Map<string, { completed: number; failed: number }>();
  for (const shell of shells)
    buckets.set(shell.weekStart, { completed: 0, failed: 0 });
  for (const r of rows) {
    const wkStart = weekStartIso(r.date);
    const bucket = buckets.get(wkStart);
    if (!bucket) continue;
    const failed = r.failed_count;
    const completed = Math.max(0, r.task_count - failed);
    bucket.completed += completed;
    bucket.failed += failed;
  }
  return shells.map((s) => {
    const b = buckets.get(s.weekStart) ?? { completed: 0, failed: 0 };
    return { ...s, completed: b.completed, failed: b.failed };
  });
}

// Per-date run-time rows → one row per date with `totalSeconds` for the
// DailyTimeChart. Sorted ascending so the x-axis reads oldest-to-newest,
// matching the cost / tokens aggregators.
export function aggregateDailyTime(rows: DashboardRunTimeDaily[]): DailyTimeData[] {
  return rows.toSorted((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      date: r.date,
      label: formatDateLabel(r.date),
      totalSeconds: r.total_seconds,
    }));
}

// Per-date run-time rows → one row per date with `completed` and `failed`
// counts for the DailyTasksChart's stacked bar (failed_count is a subset
// of task_count, so completed = task_count - failed_count).
export function aggregateDailyTasks(rows: DashboardRunTimeDaily[]): DailyTasksData[] {
  return rows.toSorted((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const failed = r.failed_count;
      const completed = Math.max(0, r.task_count - failed);
      return {
        date: r.date,
        label: formatDateLabel(r.date),
        completed,
        failed,
      };
    });
}

// Compact human duration: "1h 23m" / "12m 30s" / "45s" / "<1m". Used for
// the dashboard run-time KPI and the per-agent run-time column. Keeps two
// segments max — three segments adds visual noise without precision the
// dashboard actually needs.
export function formatDuration(seconds: number, lessThanMinuteLabel: string): string {
  if (seconds < 0 || !Number.isFinite(seconds)) return lessThanMinuteLabel;
  if (seconds < 60) {
    if (seconds < 1) return lessThanMinuteLabel;
    return `${Math.round(seconds)}s`;
  }
  const totalMinutes = Math.floor(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours === 0) {
    const secs = Math.floor(seconds) % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const h = hours % 24;
    return h > 0 ? `${days}d ${h}h` : `${days}d`;
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}
