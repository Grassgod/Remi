interface DonutSegment {
  label: string;
  value: number;
  color: string;
}

interface SvgDonutProps {
  segments: DonutSegment[];
  centerLabel: string;
  centerValue: string;
  size?: number;
}

export function SvgDonut({ segments, centerLabel, centerValue, size = 160 }: SvgDonutProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) {
    return (
      <div style={{ height: size, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-dim)" }}>
        NO DATA
      </div>
    );
  }

  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.35;
  const strokeWidth = size * 0.12;
  const circumference = 2 * Math.PI * radius;

  let offset = 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background ring */}
        <circle cx={cx} cy={cy} r={radius} fill="none" stroke="rgba(255,255,255,0.04)" strokeWidth={strokeWidth} />

        {/* Segments */}
        {segments.map((seg, i) => {
          const pct = seg.value / total;
          const dash = pct * circumference;
          const currentOffset = offset;
          offset += dash;

          return (
            <circle
              key={i}
              cx={cx} cy={cy} r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-currentOffset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: "stroke-dasharray 0.5s ease" }}
            >
              <title>{`${seg.label}: ${seg.value.toLocaleString()} (${(pct * 100).toFixed(1)}%)`}</title>
            </circle>
          );
        })}

        {/* Center text */}
        <text x={cx} y={cy - 6} textAnchor="middle" fill="rgba(255,255,255,0.3)" fontSize={8} fontFamily="var(--font-mono)" letterSpacing={1}>
          {centerLabel}
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="var(--text-bright)" fontSize={16} fontFamily="var(--font-display)" fontWeight={700}>
          {centerValue}
        </text>
      </svg>

      {/* Legend */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", justifyContent: "center" }}>
        {segments.filter(s => s.value > 0).map((seg, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: seg.color, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--text-muted)" }}>
              {seg.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
