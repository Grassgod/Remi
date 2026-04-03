interface HeatmapTableProps {
  cases: string[];
  dimensions: string[];
  data: Record<string, Record<string, { score: number; maxScore: number }>>;
}

function getColor(ratio: number): string {
  if (ratio >= 0.9) return "bg-emerald-100 text-emerald-700";
  if (ratio >= 0.7) return "bg-blue-50 text-blue-700";
  if (ratio >= 0.5) return "bg-amber-50 text-amber-700";
  return "bg-red-50 text-red-700";
}

export function HeatmapTable({ cases, dimensions, data }: HeatmapTableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200/80 bg-white">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100">
            <th className="px-4 py-3 text-left font-medium text-gray-400">
              Case
            </th>
            {dimensions.map((dim) => (
              <th
                key={dim}
                className="px-3 py-3 text-center font-medium text-gray-400"
              >
                {dim}
              </th>
            ))}
            <th className="px-4 py-3 text-center font-semibold text-gray-500">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {cases.map((caseId) => {
            const row = data[caseId] || {};
            let totalScore = 0;
            let totalMax = 0;
            return (
              <tr key={caseId} className="border-b border-gray-50 last:border-0">
                <td className="px-4 py-2.5 font-mono font-medium text-gray-700">
                  {caseId}
                </td>
                {dimensions.map((dim) => {
                  const cell = row[dim];
                  if (!cell) return <td key={dim} className="px-3 py-2.5 text-center text-gray-300">-</td>;
                  const ratio = cell.maxScore > 0 ? cell.score / cell.maxScore : 0;
                  totalScore += cell.score;
                  totalMax += cell.maxScore;
                  return (
                    <td key={dim} className="px-3 py-2.5 text-center">
                      <span
                        className={`inline-block rounded-md px-2 py-0.5 font-mono tabular-nums ${getColor(ratio)}`}
                      >
                        {cell.score}/{cell.maxScore}
                      </span>
                    </td>
                  );
                })}
                <td className="px-4 py-2.5 text-center font-mono font-bold tabular-nums text-gray-800">
                  {totalScore}/{totalMax}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
