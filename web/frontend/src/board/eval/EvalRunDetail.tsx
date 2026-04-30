import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { EvalLayout } from "./EvalLayout";
import { ScoreCard } from "./components/ScoreCard";
import { HeatmapTable } from "./components/HeatmapTable";
import { GapsSummary } from "./components/GapsSummary";

interface RunResult {
  date: string;
  runId: string;
  meta?: any;
  clarify: Record<string, any>;
  rfc: Record<string, any>;
  report?: string;
}

export function EvalRunDetail() {
  const [, params] = useRoute("/eval/run/:runId");
  const runId = params?.runId ?? "";
  const [result, setResult] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!runId) return;
    fetch(`/api/v1/eval/runs/${runId}`)
      .then((r) => r.json())
      .then(setResult)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [runId]);

  if (loading) {
    return (
      <EvalLayout>
        <div className="flex h-[60vh] items-center justify-center">
          <p className="animate-pulse text-sm text-gray-300">Loading...</p>
        </div>
      </EvalLayout>
    );
  }

  if (!result) {
    return (
      <EvalLayout>
        <div className="flex h-[60vh] items-center justify-center">
          <p className="text-sm text-gray-400">Run not found.</p>
        </div>
      </EvalLayout>
    );
  }

  // Aggregate scores
  const rfcEntries = Object.entries(result.rfc || {});
  const clarifyEntries = Object.entries(result.clarify || {});
  const rfcAvg =
    rfcEntries.length > 0
      ? rfcEntries.reduce((s, [, r]: any) => s + (r.total_score || 0), 0) / rfcEntries.length
      : 0;
  const clarifyAvg =
    clarifyEntries.length > 0
      ? clarifyEntries.reduce((s, [, r]: any) => s + (r.total_score || 0), 0) / clarifyEntries.length
      : 0;

  // Heatmap for RFC
  const rfcCases = Object.keys(result.rfc || {});
  const rfcDimNames: string[] = [];
  const heatmapData: Record<string, Record<string, { score: number; maxScore: number }>> = {};

  for (const [caseId, r] of rfcEntries) {
    const dims = (r as any).dimensions || (r as any)["\u6253\u5206\u7ef4\u5ea6"] || [];
    heatmapData[caseId] = {};
    for (const d of dims) {
      const name = d.name || d["\u7ef4\u5ea6\u540d\u79f0"];
      if (!rfcDimNames.includes(name)) rfcDimNames.push(name);
      heatmapData[caseId][name] = {
        score: d.score,
        maxScore: d.maxScore || d.max_score || 0,
      };
    }
  }

  // Collect gaps
  const allGaps = rfcEntries.flatMap(([caseId, r]: any) =>
    (r.critical_gaps || []).map((g: any) => ({ ...g, caseId }))
  );

  return (
    <EvalLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <div>
          <h2 className="text-lg font-semibold text-gray-800">
            Run: {result.date}
          </h2>
          <p className="font-mono text-xs text-gray-400">{result.runId}</p>
        </div>

        {/* Score cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          {clarifyEntries.length > 0 && (
            <ScoreCard
              label="Clarify Avg"
              score={clarifyAvg}
              accent="from-violet-500 to-purple-400"
              subtitle={`${clarifyEntries.length} cases`}
            />
          )}
          {rfcEntries.length > 0 && (
            <ScoreCard
              label="RFC Avg"
              score={rfcAvg}
              accent="from-blue-500 to-cyan-400"
              subtitle={`${rfcEntries.length} cases`}
            />
          )}
          <ScoreCard
            label="Total Cases"
            score={rfcEntries.length + clarifyEntries.length}
            maxScore={rfcEntries.length + clarifyEntries.length}
            accent="from-emerald-500 to-teal-400"
          />
        </div>

        {/* RFC Heatmap */}
        {rfcCases.length > 0 && rfcDimNames.length > 0 && (
          <div>
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              RFC Score Matrix
            </h3>
            <HeatmapTable
              cases={rfcCases}
              dimensions={rfcDimNames}
              data={heatmapData}
            />
          </div>
        )}

        {/* Gaps */}
        {allGaps.length > 0 && <GapsSummary gaps={allGaps} />}

        {/* Report */}
        {result.report && (
          <div className="rounded-xl border border-gray-200/80 bg-white p-5">
            <h3 className="mb-3 text-sm font-semibold text-gray-700">
              Report
            </h3>
            <pre className="max-h-[400px] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-gray-600">
              {result.report}
            </pre>
          </div>
        )}
      </div>
    </EvalLayout>
  );
}
