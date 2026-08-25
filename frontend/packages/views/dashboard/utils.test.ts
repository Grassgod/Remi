import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardUsageDaily } from "@multiremi/core/types";
import { aggregateByDate } from "../runtimes/utils";
import {
  aggregateAgentTokens,
  aggregateWeeklyTasks,
  aggregateWeeklyTime,
  computeDailyTotals,
  formatDuration,
  mergeAgentDashboardRows,
} from "./utils";

// The dashboard shares the runtimes page's daily rollup — these cases pin the
// cost stack it reads out of it against the dashboard's own row shape (which
// carries no `provider`).
describe("aggregateByDate on dashboard rows", () => {
  it("collapses multiple rows per day into one stack and sorts by date asc", () => {
    const rows: DashboardUsageDaily[] = [
      {
        date: "2026-05-10",
        model: "claude-sonnet-4-6",
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 3,
      },
      {
        date: "2026-05-09",
        model: "claude-sonnet-4-6",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 1,
      },
    ];
    const { dailyCostStack: result } = aggregateByDate(rows);

    // Sort: oldest day first.
    expect(result.map((r) => r.date)).toEqual(["2026-05-09", "2026-05-10"]);
    // claude-sonnet-4-6: input $3/M, output $15/M.
    // 2026-05-09 → 1M input × $3 = $3 input, $0 output, $0 cache.
    expect(result[0]).toMatchObject({ input: 3, output: 0, cacheWrite: 0, total: 3 });
    // 2026-05-10 → $3 input + (0.5M × $15) = $7.5 output. Total $10.5.
    expect(result[1]).toMatchObject({ input: 3, output: 7.5, cacheWrite: 0, total: 10.5 });
  });

  it("treats unmapped models as zero-cost", () => {
    const rows: DashboardUsageDaily[] = [
      {
        date: "2026-05-10",
        model: "made-up-model",
        input_tokens: 999_999_999,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 0,
      },
    ];
    const { dailyCostStack: result } = aggregateByDate(rows);
    expect(result[0]?.total).toBe(0);
  });
});

describe("aggregateAgentTokens", () => {
  it("folds per-(agent, model) rows into per-agent totals and sorts by cost desc", () => {
    const rows = aggregateAgentTokens([
      {
        agent_id: "small-spender",
        model: "claude-sonnet-4-6",
        input_tokens: 100_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 1,
      },
      {
        agent_id: "big-spender",
        model: "claude-sonnet-4-6",
        input_tokens: 5_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 3,
      },
      {
        agent_id: "big-spender",
        model: "claude-haiku-4-5",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 2,
      },
    ]);

    expect(rows.map((r) => r.agentId)).toEqual(["big-spender", "small-spender"]);
    expect(rows[0]?.taskCount).toBe(5);
    // big-spender across two models — verify cost > small-spender's.
    expect(rows[0]!.cost).toBeGreaterThan(rows[1]!.cost);
  });
});

describe("computeDailyTotals", () => {
  it("sums tokens across rows and adds estimated cost", () => {
    const totals = computeDailyTotals([
      {
        date: "2026-05-10",
        model: "claude-sonnet-4-6",
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 2,
      },
      {
        date: "2026-05-09",
        model: "claude-sonnet-4-6",
        input_tokens: 2_000_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 3,
      },
    ]);
    expect(totals.input).toBe(3_000_000);
    expect(totals.cost).toBe(9); // 3M × $3/M
    expect(totals.taskCount).toBe(5);
  });
});

describe("mergeAgentDashboardRows", () => {
  it("uses run-time rollup's per-agent task count, not the token sum", () => {
    // Token rollup returns two (agent, model) rows for the same task
    // (the agent ran one task that touched two models). The token-side
    // aggregator sums per-row task_count and lands at 2; the run-time
    // rollup correctly reports the underlying distinct count of 1.
    const tokenRows = [
      {
        agentId: "agent-a",
        tokens: 3_000_000,
        cost: 12,
        taskCount: 2, // overcounted because (model-1: 1) + (model-2: 1)
        unpricedTokens: 0,
      },
    ];
    const runTimeRows = [
      {
        agent_id: "agent-a",
        total_seconds: 600,
        task_count: 1, // truth: one task touched both models
        failed_count: 0,
      },
    ];
    const merged = mergeAgentDashboardRows(tokenRows, runTimeRows);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.taskCount).toBe(1);
    expect(merged[0]!.seconds).toBe(600);
  });

  it("falls back to token count when no run-time row exists (in-flight task)", () => {
    // Tokens reported mid-run; task hasn't terminated yet so the run-time
    // rollup is silent on this agent. Keep the token-side estimate
    // instead of dropping the agent from the table entirely.
    const merged = mergeAgentDashboardRows(
      [{ agentId: "agent-b", tokens: 100, cost: 0.5, taskCount: 1, unpricedTokens: 0 }],
      [],
    );
    expect(merged[0]!.taskCount).toBe(1);
    expect(merged[0]!.seconds).toBe(0);
  });

  it("includes agents that have run-time but no tokens", () => {
    // Task errored before reporting any usage — run-time row exists but
    // there's no corresponding token row. Agent must still appear on the
    // list with zeroed-out token columns.
    const merged = mergeAgentDashboardRows(
      [],
      [{ agent_id: "agent-c", total_seconds: 30, task_count: 1, failed_count: 1 }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.tokens).toBe(0);
    expect(merged[0]!.cost).toBe(0);
    expect(merged[0]!.taskCount).toBe(1);
  });

  it("sorts by cost desc with run-time as a tiebreaker", () => {
    const merged = mergeAgentDashboardRows(
      [
        { agentId: "low", tokens: 100, cost: 1, taskCount: 1, unpricedTokens: 0 },
        { agentId: "high", tokens: 100, cost: 9, taskCount: 1, unpricedTokens: 0 },
        { agentId: "zero-cost-long", tokens: 0, cost: 0, taskCount: 0, unpricedTokens: 0 },
      ],
      [
        { agent_id: "zero-cost-long", total_seconds: 1000, task_count: 5, failed_count: 0 },
      ],
    );
    expect(merged.map((r) => r.agentId)).toEqual(["high", "low", "zero-cost-long"]);
  });
});

describe("formatDuration", () => {
  it("formats seconds-only durations", () => {
    expect(formatDuration(45, "<1m")).toBe("45s");
  });
  it("formats minutes and seconds when under one hour", () => {
    expect(formatDuration(150, "<1m")).toBe("2m 30s");
    expect(formatDuration(60, "<1m")).toBe("1m");
  });
  it("formats hours and minutes when under one day", () => {
    expect(formatDuration(3 * 3600 + 17 * 60, "<1m")).toBe("3h 17m");
    expect(formatDuration(3600, "<1m")).toBe("1h");
  });
  it("formats days and hours when more than 24 hours", () => {
    expect(formatDuration(2 * 86400 + 5 * 3600, "<1m")).toBe("2d 5h");
  });
  it("falls back to the supplied label for sub-second durations", () => {
    expect(formatDuration(0, "<1m")).toBe("<1m");
    expect(formatDuration(0.4, "<1m")).toBe("<1m");
  });
});

// ---------------------------------------------------------------------------
// Weekly run-time / tasks aggregation. Mirrors the runtimes-side
// aggregateByWeek tests: trailing N calendar weeks anchored at today-in-tz,
// pre-zeroed buckets, partial-week metadata, and rows outside the window
// dropped. We assert the same invariants on the workspace dashboard helpers
// so all four metrics behave consistently when the user toggles Weekly.
// ---------------------------------------------------------------------------

describe("aggregateWeeklyTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("folds per-day run-time rows into Mon-anchored weekly totals", () => {
    // 2026-05-19 is a Tuesday → current week is Mon=05-18..Sun=05-24.
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    const rows = [
      { date: "2026-05-11", total_seconds: 100, task_count: 0, failed_count: 0 },
      { date: "2026-05-17", total_seconds: 50, task_count: 0, failed_count: 0 },
      { date: "2026-05-18", total_seconds: 25, task_count: 0, failed_count: 0 },
    ];
    const result = aggregateWeeklyTime(rows, "UTC", 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      weekStart: "2026-05-11",
      weekEnd: "2026-05-17",
      totalSeconds: 150,
      partial: false,
      daysCovered: 7,
    });
    expect(result[1]).toMatchObject({
      weekStart: "2026-05-18",
      totalSeconds: 25,
      partial: true,
      daysCovered: 2, // Mon + Tue
    });
  });

  it("drops rows that fall outside the trailing window and keeps empty buckets", () => {
    // Same MUL-2382 sparse-data regression we caught on the runtimes side:
    // an old populated week must not surface when the requested window
    // doesn't include it; in-range empty weeks must remain as zero buckets.
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    const rows = [
      // 2026-04-13 is a Monday — exactly one week earlier than the oldest
      // in-range week (Mon=04-20) for a 5-week trailing window.
      { date: "2026-04-13", total_seconds: 999, task_count: 0, failed_count: 0 },
    ];
    const result = aggregateWeeklyTime(rows, "UTC", 5);
    expect(result.map((w) => w.weekStart)).toEqual([
      "2026-04-20",
      "2026-04-27",
      "2026-05-04",
      "2026-05-11",
      "2026-05-18",
    ]);
    for (const w of result) expect(w.totalSeconds).toBe(0);
  });
});

describe("aggregateWeeklyTasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("splits completed and failed counts per calendar week", () => {
    vi.setSystemTime(new Date("2026-05-19T12:00:00Z"));
    const rows = [
      { date: "2026-05-12", total_seconds: 0, task_count: 5, failed_count: 1 },
      { date: "2026-05-18", total_seconds: 0, task_count: 3, failed_count: 0 },
    ];
    const result = aggregateWeeklyTasks(rows, "UTC", 2);
    expect(result[0]).toMatchObject({
      weekStart: "2026-05-11",
      completed: 4,
      failed: 1,
    });
    expect(result[1]).toMatchObject({
      weekStart: "2026-05-18",
      completed: 3,
      failed: 0,
      partial: true,
    });
  });
});

// ---------------------------------------------------------------------------
// MUL-93 — display honesty flags. A metric value of 0 must be a measurement,
// never a fallback: rows track when cost / run-time cannot honestly be
// stated so the UI can render "—" instead of a fabricated 0.
// ---------------------------------------------------------------------------

describe("usage availability flags (MUL-93)", () => {
  it("aggregateAgentTokens tracks tokens whose model has no price", () => {
    const rows = aggregateAgentTokens([
      {
        agent_id: "agent-a",
        model: "some-unknown-model",
        input_tokens: 1_000,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 1,
      },
      {
        agent_id: "agent-a",
        model: "claude-sonnet-4-6",
        input_tokens: 2_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        task_count: 1,
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unpricedTokens).toBe(1_500);
    expect(rows[0]!.tokens).toBe(3_500);
  });

  it("marks cost unavailable when every recorded token is unpriced", () => {
    const merged = mergeAgentDashboardRows(
      [
        {
          agentId: "agent-a",
          tokens: 5_000,
          cost: 0,
          taskCount: 1,
          unpricedTokens: 5_000,
        },
      ],
      [],
    );
    expect(merged[0]!.costUnavailable).toBe(true);
  });

  it("keeps cost available for a genuine $0-with-pricing row", () => {
    // All models priced, zero tokens → $0.00 is a real measurement.
    const merged = mergeAgentDashboardRows(
      [
        {
          agentId: "agent-a",
          tokens: 0,
          cost: 0,
          taskCount: 0,
          unpricedTokens: 0,
        },
      ],
      [],
    );
    expect(merged[0]!.costUnavailable).toBe(false);
    expect(merged[0]!.tokensUnavailable).toBe(false);
  });

  it("marks cost unavailable for run-time-only agents that ran tasks", () => {
    // Tasks ran but no usage rows were recorded — a dollar figure cannot be
    // derived from unrecorded usage, so $0.00 would be fabricated.
    const merged = mergeAgentDashboardRows(
      [],
      [{ agent_id: "agent-c", total_seconds: 30, task_count: 2, failed_count: 0 }],
    );
    expect(merged[0]!.costUnavailable).toBe(true);
    expect(merged[0]!.hasRunTime).toBe(true);
    // tokens: 0 here means "not collected", not a measured zero — the UI
    // renders "—" for the token column off this flag.
    expect(merged[0]!.tokensUnavailable).toBe(true);
  });

  it("flags rows without a run-time rollup so 0s isn't rendered as <1m", () => {
    const merged = mergeAgentDashboardRows(
      [
        {
          agentId: "agent-b",
          tokens: 100,
          cost: 0.5,
          taskCount: 1,
          unpricedTokens: 0,
        },
      ],
      [],
    );
    expect(merged[0]!.hasRunTime).toBe(false);
    expect(merged[0]!.seconds).toBe(0);
  });
});
