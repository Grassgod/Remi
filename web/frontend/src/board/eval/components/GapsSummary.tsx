interface Gap {
  gap_type: string;
  description: string;
  severity: string;
  mr_evidence?: string;
  caseId?: string;
}

interface GapsSummaryProps {
  gaps: Gap[];
}

const SEVERITY_CONFIG: Record<string, { dot: string; bg: string; text: string }> = {
  "\u9ad8": { dot: "bg-red-500", bg: "bg-red-50", text: "text-red-700" },
  "\u4e2d": { dot: "bg-amber-500", bg: "bg-amber-50", text: "text-amber-700" },
  "\u4f4e": { dot: "bg-green-500", bg: "bg-green-50", text: "text-green-700" },
};

export function GapsSummary({ gaps }: GapsSummaryProps) {
  if (!gaps.length) return null;

  const bySeverity = gaps.reduce(
    (acc, g) => {
      const s = g.severity || "\u4f4e";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">Critical Gaps</h3>
        <div className="flex items-center gap-3">
          {Object.entries(bySeverity).map(([severity, count]) => {
            const cfg = SEVERITY_CONFIG[severity] || SEVERITY_CONFIG["\u4f4e"];
            return (
              <span
                key={severity}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${cfg.bg} ${cfg.text}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
                {severity}: {count}
              </span>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        {gaps.map((gap, i) => {
          const cfg = SEVERITY_CONFIG[gap.severity] || SEVERITY_CONFIG["\u4f4e"];
          return (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg border border-gray-100 px-4 py-3"
            >
              <span className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${cfg.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-500">
                    {gap.gap_type}
                  </span>
                  {gap.caseId && (
                    <span className="font-mono text-[10px] text-gray-400">
                      {gap.caseId}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-gray-600">
                  {gap.description}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
