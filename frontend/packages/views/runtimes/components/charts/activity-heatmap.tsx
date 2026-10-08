import { useMemo } from "react";
import type { UsageReport } from "@multiremi/contracts/usage-accounting";
import {
  heatmapRows,
  type UsageCalendarWindows,
} from "@multiremi/core/usage/view-model";
import { useT } from "../../../i18n";

const CELL_SIZE = 16,
  GAP = 3,
  LABEL_WIDTH = 28;
export function ActivityHeatmap({
  report,
  windows,
  currency,
}: {
  report: UsageReport;
  windows: UsageCalendarWindows;
  currency: string;
}) {
  const { t } = useT("usage");
  const cells = useMemo(
    () => heatmapRows(report, windows, currency),
    [report, windows, currency],
  );
  const values = cells
    .flatMap((c) => (c.value !== null && c.value > 0 ? [c.value] : []))
    .sort((a, b) => a - b);
  const known = cells.filter((c) => !c.future && c.value !== null);
  const complete = cells
    .filter((c) => !c.future)
    .every((c) => c.state === "known");
  const total = known.reduce((n, c) => n + c.value!, 0);
  const busiest = known.reduce<(typeof known)[number] | null>(
    (best, c) => (!best || c.value! > best.value! ? c : best),
    null,
  );
  const weekday = Array.from({ length: 7 }, (_, i) => {
    const days = known.filter((c) => c.dayOfWeek === i);
    return {
      index: i,
      amount: days.length
        ? days.reduce((n, c) => n + c.value!, 0) / days.length
        : null,
    };
  });
  const sortedWeekdays = weekday
    .filter((c) => c.amount !== null)
    .sort((a, b) => b.amount! - a.amount!);
  const weekName = (i: number) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 0, 5 + i)));
  const money = (v: number) => `${currency} ${v.toFixed(2)}`;
  const color = (c: (typeof cells)[number]) => {
    if (c.future) return "transparent";
    if (c.state === "empty") return "none";
    if (c.value === null) return "var(--color-warning)";
    if (c.value === 0) return "var(--color-muted)";
    const level =
      values.length <= 1
        ? 3
        : Math.min(
            3,
            Math.floor((values.indexOf(c.value) / values.length) * 4),
          );
    return `color-mix(in oklch, var(--color-chart-1) ${["20%", "45%", "70%", "100%"][level]}, transparent)`;
  };
  const caption = (c: (typeof cells)[number]) =>
    c.future
      ? t(($) => $.experience.future)
      : c.state === "empty"
        ? t(($) => $.experience.no_record)
        : c.value === null
          ? t(($) => $.experience.unknown)
          : `${money(c.value)}${c.state === "subtotal" ? ` · ${t(($) => $.experience.subtotal)}` : c.value === 0 ? ` · ${t(($) => $.experience.zero)}` : ""}`;
  const months = cells.filter(
    (c) =>
      c.dayOfWeek === 0 &&
      !c.future &&
      (c.week === 0 ||
        c.date.slice(5, 7) !== cells[(c.week - 1) * 7]?.date.slice(5, 7)),
  );
  const unknown = t(($) => $.experience.insight_unknown);
  return (
    <div className="min-w-0 space-y-4" data-testid="activity-heatmap">
      <div className="flex min-w-0 flex-col items-center gap-2">
        <div className="max-w-full overflow-x-auto">
          <svg
            role="img"
            aria-label={t(($) => $.experience.heatmap)}
            width={LABEL_WIDTH + 26 * (CELL_SIZE + GAP)}
            height={14 + 7 * (CELL_SIZE + GAP)}
            className="block"
          >
            {months.map((c) => (
              <text
                key={c.date}
                x={LABEL_WIDTH + c.week * (CELL_SIZE + GAP)}
                y={10}
                className="fill-muted-foreground"
                fontSize={9}
              >
                {new Intl.DateTimeFormat(undefined, {
                  month: "short",
                  timeZone: "UTC",
                }).format(new Date(`${c.date}T00:00:00Z`))}
              </text>
            ))}
            {[0, 2, 4].map((i) => (
              <text
                key={i}
                x={0}
                y={14 + i * (CELL_SIZE + GAP) + CELL_SIZE - 1}
                className="fill-muted-foreground"
                fontSize={9}
              >
                {weekName(i)}
              </text>
            ))}
            {cells.map((c) => (
              <rect
                key={c.date}
                data-state={c.future ? "future" : c.state}
                data-date={c.date}
                x={LABEL_WIDTH + c.week * (CELL_SIZE + GAP)}
                y={14 + c.dayOfWeek * (CELL_SIZE + GAP)}
                width={CELL_SIZE}
                height={CELL_SIZE}
                rx={3}
                fill={color(c)}
                stroke={
                  c.state === "empty" && !c.future
                    ? "var(--color-border)"
                    : undefined
                }
                strokeDasharray={
                  c.state === "empty" && !c.future ? "2 2" : undefined
                }
                fillOpacity={
                  c.value === null && c.state === "unknown" ? 0.35 : 1
                }
              >
                <title>
                  {c.date}: {caption(c)}
                </title>
              </rect>
            ))}
          </svg>
        </div>
        <div className="flex flex-wrap justify-center gap-3 text-[10px] text-muted-foreground">
          <span>□ {t(($) => $.experience.no_record)}</span>
          <span>■ {t(($) => $.experience.zero)}</span>
          <span className="text-warning">
            ■ {t(($) => $.experience.unknown)}
          </span>
          <span className="text-brand">
            ■ {t(($) => $.experience.subtotal)}
          </span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 sm:grid-cols-4">
        <Insight
          label={t(($) => $.experience.busiest)}
          value={complete && busiest ? busiest.date : unknown}
          sub={complete && busiest ? money(busiest.value!) : undefined}
        />
        <Insight
          label={t(($) => $.experience.busy_weekday)}
          value={
            complete && sortedWeekdays[0]
              ? weekName(sortedWeekdays[0].index)
              : unknown
          }
        />
        <Insight
          label={t(($) => $.experience.quiet_weekday)}
          value={
            complete && sortedWeekdays.at(-1)
              ? weekName(sortedWeekdays.at(-1)!.index)
              : unknown
          }
        />
        <Insight
          label={t(($) => $.experience.known_total)}
          value={known.length ? money(total) : "—"}
        />
      </dl>
    </div>
  );
}
function Insight({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
