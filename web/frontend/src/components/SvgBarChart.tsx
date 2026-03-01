import type { DailySummary } from "../api/types";

interface SvgBarChartProps {
  data: DailySummary[];
  height?: number;
}

export function SvgBarChart({ data, height = 200 }: SvgBarChartProps) {
  if (data.length === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
        NO DATA
      </div>
    );
  }

  // Sort ascending by date
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  const margin = { top: 10, right: 10, bottom: 30, left: 50 };
  const w = 500;
  const chartW = w - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;

  // Stack: input (cyan) + output (green) + cacheCreate (amber)
  const maxVal = Math.max(1, ...sorted.map(d => d.totalIn + d.totalOut + d.totalCacheCreate));
  const barW = Math.max(4, (chartW / sorted.length) * 0.7);
  const gap = (chartW / sorted.length) * 0.3;

  // Y-axis gridlines
  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = (maxVal / yTicks) * i;
    const y = chartH - (val / maxVal) * chartH;
    return { val, y };
  });

  return (
    <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }}>
      <g transform={`translate(${margin.left},${margin.top})`}>
        {/* Grid lines */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={0} y1={g.y} x2={chartW} y2={g.y} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} />
            <text x={-8} y={g.y + 3} textAnchor="end" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="var(--font-mono)">
              {formatTokenCount(g.val)}
            </text>
          </g>
        ))}

        {/* Bars */}
        {sorted.map((d, i) => {
          const x = i * (barW + gap);
          const inH = (d.totalIn / maxVal) * chartH;
          const outH = (d.totalOut / maxVal) * chartH;
          const cacheH = (d.totalCacheCreate / maxVal) * chartH;
          const total = d.totalIn + d.totalOut + d.totalCacheCreate;

          return (
            <g key={d.date}>
              {/* Cache create (bottom) */}
              <rect x={x} y={chartH - cacheH} width={barW} height={Math.max(0, cacheH)} fill="rgba(245,158,11,0.7)" rx={1}>
                <title>{`${d.date}\nInput: ${d.totalIn.toLocaleString()}\nOutput: ${d.totalOut.toLocaleString()}\nCache Create: ${d.totalCacheCreate.toLocaleString()}\nTotal: ${total.toLocaleString()}`}</title>
              </rect>
              {/* Input (middle) */}
              <rect x={x} y={chartH - cacheH - inH} width={barW} height={Math.max(0, inH)} fill="rgba(6,182,212,0.7)" rx={1}>
                <title>{`${d.date}\nInput: ${d.totalIn.toLocaleString()}\nOutput: ${d.totalOut.toLocaleString()}\nCache Create: ${d.totalCacheCreate.toLocaleString()}\nTotal: ${total.toLocaleString()}`}</title>
              </rect>
              {/* Output (top) */}
              <rect x={x} y={chartH - cacheH - inH - outH} width={barW} height={Math.max(0, outH)} fill="rgba(34,197,94,0.7)" rx={1}>
                <title>{`${d.date}\nInput: ${d.totalIn.toLocaleString()}\nOutput: ${d.totalOut.toLocaleString()}\nCache Create: ${d.totalCacheCreate.toLocaleString()}\nTotal: ${total.toLocaleString()}`}</title>
              </rect>

              {/* X label */}
              {(i % Math.max(1, Math.floor(sorted.length / 7)) === 0 || i === sorted.length - 1) && (
                <text x={x + barW / 2} y={chartH + 16} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="var(--font-mono)">
                  {d.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </g>

      {/* Legend */}
      <g transform={`translate(${margin.left}, ${height - 6})`}>
        <rect x={0} y={-6} width={8} height={8} fill="rgba(6,182,212,0.7)" rx={1} />
        <text x={12} y={1} fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--font-mono)">Input</text>
        <rect x={50} y={-6} width={8} height={8} fill="rgba(34,197,94,0.7)" rx={1} />
        <text x={62} y={1} fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--font-mono)">Output</text>
        <rect x={110} y={-6} width={8} height={8} fill="rgba(245,158,11,0.7)" rx={1} />
        <text x={122} y={1} fill="rgba(255,255,255,0.4)" fontSize={8} fontFamily="var(--font-mono)">Cache Create</text>
      </g>
    </svg>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
