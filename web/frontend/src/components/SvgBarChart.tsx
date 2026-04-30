import { useState, useRef } from "react";
import type { DailySummary } from "../api/types";

interface SvgBarChartProps {
  data: DailySummary[];
  height?: number;
}

interface TooltipData {
  date: string;
  totalIn: number;
  totalOut: number;
  totalCacheCreate: number;
  total: number;
  x: number;
  y: number;
}

export function SvgBarChart({ data, height = 200 }: SvgBarChartProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  if (data.length === 0) {
    return (
      <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--muted-foreground)" }}>
        NO DATA
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  const margin = { top: 10, right: 10, bottom: 30, left: 50 };
  const w = 500;
  const chartW = w - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;

  const maxVal = Math.max(1, ...sorted.map(d => d.totalIn + d.totalOut + d.totalCacheCreate));
  const barW = Math.max(4, (chartW / sorted.length) * 0.7);
  const gap = (chartW / sorted.length) * 0.3;

  const yTicks = 4;
  const gridLines = Array.from({ length: yTicks + 1 }, (_, i) => {
    const val = (maxVal / yTicks) * i;
    const y = chartH - (val / maxVal) * chartH;
    return { val, y };
  });

  const handleBarHover = (d: DailySummary, barIndex: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const svgW = rect.width;
    const scale = svgW / w;
    const x = (margin.left + barIndex * (barW + gap) + barW / 2) * scale;
    const total = d.totalIn + d.totalOut + d.totalCacheCreate;
    const barTop = chartH - (total / maxVal) * chartH;
    const y = (margin.top + barTop) * scale;
    setTooltip({ date: d.date, totalIn: d.totalIn, totalOut: d.totalOut, totalCacheCreate: d.totalCacheCreate, total, x, y });
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }} onClick={() => setTooltip(null)}>
      <svg viewBox={`0 0 ${w} ${height}`} style={{ width: "100%", height }}>
        <g transform={`translate(${margin.left},${margin.top})`}>
          {/* Grid lines */}
          {gridLines.map((g, i) => (
            <g key={i}>
              <line x1={0} y1={g.y} x2={chartW} y2={g.y} stroke="var(--border)" strokeWidth={0.5} />
              <text x={-8} y={g.y + 3} textAnchor="end" fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">
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

            return (
              <g
                key={d.date}
                onMouseEnter={() => handleBarHover(d, i)}
                onMouseLeave={() => setTooltip(null)}
                onClick={(e) => { e.stopPropagation(); handleBarHover(d, i); }}
                style={{ cursor: "pointer" }}
              >
                {/* Invisible hit area for easier hovering */}
                <rect x={x - gap / 2} y={0} width={barW + gap} height={chartH} fill="transparent" />
                {/* Cache create (bottom) */}
                <rect x={x} y={chartH - cacheH} width={barW} height={Math.max(0, cacheH)} fill="rgba(245,158,11,0.7)" rx={1} />
                {/* Input (middle) */}
                <rect x={x} y={chartH - cacheH - inH} width={barW} height={Math.max(0, inH)} fill="rgba(6,182,212,0.7)" rx={1} />
                {/* Output (top) */}
                <rect x={x} y={chartH - cacheH - inH - outH} width={barW} height={Math.max(0, outH)} fill="rgba(34,197,94,0.7)" rx={1} />

                {/* X label */}
                {(i % Math.max(1, Math.floor(sorted.length / 7)) === 0 || i === sorted.length - 1) && (
                  <text x={x + barW / 2} y={chartH + 16} textAnchor="middle" fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">
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
          <text x={12} y={1} fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">Input</text>
          <rect x={50} y={-6} width={8} height={8} fill="rgba(34,197,94,0.7)" rx={1} />
          <text x={62} y={1} fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">Output</text>
          <rect x={110} y={-6} width={8} height={8} fill="rgba(245,158,11,0.7)" rx={1} />
          <text x={122} y={1} fill="var(--muted-foreground)" fontSize={8} fontFamily="var(--font-mono)">Cache Create</text>
        </g>
      </svg>

      {/* Custom Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: tooltip.x,
            top: tooltip.y,
            transform: "translate(-50%, -100%) translateY(-8px)",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div
            style={{
              background: "var(--popover)",
              color: "var(--popover-foreground)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              lineHeight: 1.6,
              whiteSpace: "nowrap",
              boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 2 }}>{tooltip.date}</div>
            <div><span style={{ color: "rgba(6,182,212,0.9)" }}>Input:</span> {tooltip.totalIn.toLocaleString()}</div>
            <div><span style={{ color: "rgba(34,197,94,0.9)" }}>Output:</span> {tooltip.totalOut.toLocaleString()}</div>
            <div><span style={{ color: "rgba(245,158,11,0.9)" }}>Cache:</span> {tooltip.totalCacheCreate.toLocaleString()}</div>
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 2, paddingTop: 2, fontWeight: 600 }}>
              Total: {tooltip.total.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
