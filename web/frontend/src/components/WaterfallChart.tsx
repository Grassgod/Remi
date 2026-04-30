import type { SpanData } from "../api/types";

interface WaterfallChartProps {
  spans: SpanData[];
  totalDurationMs: number;
}

const COLORS: Record<string, string> = {
  "core": "var(--glow-primary, #06b6d4)",
  "memory": "var(--glow-green, #22c55e)",
  "provider": "var(--glow-amber, #f59e0b)",
  "tool": "var(--glow-purple, #a855f7)",
  "connector": "var(--glow-blue, #3b82f6)",
};

function getColor(opName: string): string {
  const prefix = opName.split(".")[0];
  return COLORS[prefix] ?? "var(--text-muted, #64748b)";
}

function shortName(opName: string): string {
  const parts = opName.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : opName;
}

export function WaterfallChart({ spans, totalDurationMs }: WaterfallChartProps) {
  if (spans.length === 0 || totalDurationMs === 0) {
    return (
      <div style={{ padding: "24px 16px", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
        NO SPAN DATA
      </div>
    );
  }

  const rowH = 28;
  const labelW = 160;
  const barAreaW = 500;
  const durLabelW = 70;
  const totalW = labelW + barAreaW + durLabelW;
  const totalH = spans.length * rowH + 32;
  const traceStart = new Date(spans[0].startTime).getTime();

  // Time scale ticks (4 ticks)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(frac => ({
    x: labelW + frac * barAreaW,
    label: `${(frac * totalDurationMs).toFixed(0)}ms`,
  }));

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`} style={{ display: "block", minWidth: totalW }}>
        {/* Time axis */}
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={t.x} y1={0} x2={t.x} y2={totalH} stroke="var(--border-glow, rgba(255,255,255,0.06))" strokeWidth={0.5} />
            <text x={t.x} y={12} fill="var(--text-dim, #64748b)" fontSize={8} fontFamily="var(--font-mono)" textAnchor="middle">
              {t.label}
            </text>
          </g>
        ))}

        {/* Rows */}
        {spans.map((span, i) => {
          const y = i * rowH + 22;
          const start = new Date(span.startTime).getTime() - traceStart;
          const dur = span.durationMs ?? 0;
          const x = labelW + (start / totalDurationMs) * barAreaW;
          const w = Math.max((dur / totalDurationMs) * barAreaW, 2);
          const color = getColor(span.operationName);
          const depth = span.parentSpanId ? (span.operationName.split(".").length - 1) : 0;
          const indent = Math.min(depth * 10, 60);
          const isError = span.status === "ERROR";

          return (
            <g key={span.spanId}>
              {/* Row hover bg */}
              <rect x={0} y={y - 4} width={totalW} height={rowH} fill="transparent" rx={2}>
                <title>{`${span.operationName}\n${dur}ms\n${span.statusMessage ?? ""}`}</title>
              </rect>

              {/* Label */}
              <text
                x={4 + indent}
                y={y + 10}
                fill={isError ? "var(--glow-red, #ef4444)" : "var(--text-primary, #e2e8f0)"}
                fontSize={10}
                fontFamily="var(--font-mono)"
                style={{ cursor: "default" }}
              >
                {shortName(span.operationName)}
              </text>

              {/* Bar */}
              <rect
                x={x}
                y={y + 2}
                width={w}
                height={14}
                rx={3}
                fill={isError ? "var(--glow-red, #ef4444)" : color}
                opacity={0.75}
              />
              <rect
                x={x}
                y={y + 2}
                width={w}
                height={14}
                rx={3}
                fill="none"
                stroke={isError ? "var(--glow-red, #ef4444)" : color}
                strokeWidth={0.5}
                opacity={0.4}
              />

              {/* Duration label */}
              <text
                x={labelW + barAreaW + 8}
                y={y + 10}
                fill="var(--text-dim, #64748b)"
                fontSize={9}
                fontFamily="var(--font-mono)"
              >
                {dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`}
              </text>

              {/* Error events */}
              {span.events?.filter(e => e.name === "error" || e.name === "exception").map((ev, j) => {
                const evTime = new Date(ev.timestamp).getTime() - traceStart;
                const evX = labelW + (evTime / totalDurationMs) * barAreaW;
                return (
                  <circle key={j} cx={evX} cy={y + 9} r={3} fill="var(--glow-red, #ef4444)" opacity={0.9}>
                    <title>{`${ev.name}: ${ev.attributes?.message ?? ""}`}</title>
                  </circle>
                );
              })}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
