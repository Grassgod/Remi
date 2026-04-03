interface RadarChartProps {
  dimensions: Array<{ name: string; score: number; maxScore: number }>;
  title: string;
  size?: number;
}

export function RadarChart({ dimensions, title, size = 200 }: RadarChartProps) {
  const n = dimensions.length;
  if (n < 3) return null;

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;

  const angleStep = (2 * Math.PI) / n;
  const startAngle = -Math.PI / 2;

  const getPoint = (i: number, ratio: number) => ({
    x: cx + r * ratio * Math.cos(startAngle + i * angleStep),
    y: cy + r * ratio * Math.sin(startAngle + i * angleStep),
  });

  // Grid rings
  const rings = [0.25, 0.5, 0.75, 1.0];

  // Data polygon
  const dataPoints = dimensions.map((d, i) => {
    const ratio = d.maxScore > 0 ? d.score / d.maxScore : 0;
    return getPoint(i, ratio);
  });
  const dataPath = dataPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ") + " Z";

  return (
    <div className="flex flex-col items-center">
      <p className="mb-2 text-xs font-medium text-gray-500">{title}</p>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Grid */}
        {rings.map((ringR) => (
          <polygon
            key={ringR}
            points={Array.from({ length: n }, (_, i) => {
              const p = getPoint(i, ringR);
              return `${p.x},${p.y}`;
            }).join(" ")}
            fill="none"
            stroke="#e5e7eb"
            strokeWidth={0.5}
          />
        ))}

        {/* Axes */}
        {dimensions.map((_, i) => {
          const p = getPoint(i, 1);
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={p.x}
              y2={p.y}
              stroke="#e5e7eb"
              strokeWidth={0.5}
            />
          );
        })}

        {/* Data */}
        <polygon
          points={dataPoints.map((p) => `${p.x},${p.y}`).join(" ")}
          fill="rgba(59, 130, 246, 0.15)"
          stroke="rgb(59, 130, 246)"
          strokeWidth={1.5}
        />
        {dataPoints.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3} fill="rgb(59, 130, 246)" />
        ))}

        {/* Labels */}
        {dimensions.map((d, i) => {
          const p = getPoint(i, 1.25);
          const pct = d.maxScore > 0 ? Math.round((d.score / d.maxScore) * 100) : 0;
          return (
            <text
              key={i}
              x={p.x}
              y={p.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-gray-500"
              fontSize={9}
            >
              {d.name.length > 6 ? d.name.slice(0, 6) + ".." : d.name}
              <tspan dx={2} className="fill-gray-400" fontSize={8}>
                {pct}%
              </tspan>
            </text>
          );
        })}
      </svg>
    </div>
  );
}
