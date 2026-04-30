interface ScoreCardProps {
  label: string;
  score: number;
  maxScore?: number;
  subtitle?: string;
  accent?: string;
}

export function ScoreCard({
  label,
  score,
  maxScore = 100,
  subtitle,
  accent = "from-blue-500 to-cyan-400",
}: ScoreCardProps) {
  const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
      <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${accent}`} />
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-2 text-3xl font-bold tabular-nums text-gray-900">
        {typeof score === "number" ? score.toFixed(1) : score}
        {maxScore !== 100 && (
          <span className="text-base font-normal text-gray-300">
            /{maxScore}
          </span>
        )}
      </p>
      {subtitle && (
        <p className="mt-1 text-[11px] text-gray-400">{subtitle}</p>
      )}
      {/* Progress bar */}
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${accent} transition-all duration-700`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}
