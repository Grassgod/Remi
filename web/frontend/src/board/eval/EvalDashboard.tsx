import { useEffect, useState } from "react";
import { EvalLayout } from "./EvalLayout";
import { ScoreCard } from "./components/ScoreCard";
import { RadarChart } from "./components/RadarChart";
import { HeatmapTable } from "./components/HeatmapTable";
import { GapsSummary } from "./components/GapsSummary";

// Adapt API response to component-friendly format
function normalizeDims(dims: any[]): Array<{ name: string; score: number; maxScore: number }> {
  return (dims || []).map((d) => ({
    name: d.dimension || d.name || d["\u7ef4\u5ea6\u540d\u79f0"] || "",
    score: d.avg ?? d.score ?? 0,
    maxScore: d.maxAvg ?? d.maxScore ?? d.max_score ?? 100,
  }));
}

function normalizeRfcResult(r: any) {
  const rawDims = r["\u6253\u5206\u7ef4\u5ea6"] || r.dimensions || [];
  return {
    ...r,
    dimensions: rawDims.map((d: any) => ({
      name: d["\u7ef4\u5ea6\u540d\u79f0"] || d.name || "",
      score: d.score ?? 0,
      maxScore: d.max_score ?? d.maxScore ?? 0,
      reason: d.reason || "",
    })),
    critical_gaps: r.critical_gaps || [],
  };
}

export function EvalDashboard() {
  const [overview, setOverview] = useState<any>(null);
  const [baseline, setBaseline] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/v1/eval/overview").then((r) => r.json()),
      fetch("/api/v1/eval/baseline").then((r) => r.json()),
    ])
      .then(([ov, bl]) => {
        setOverview(ov);
        setBaseline(bl);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <EvalLayout>
        <div className="flex h-[60vh] items-center justify-center">
          <p className="animate-pulse text-sm text-gray-300">Loading...</p>
        </div>
      </EvalLayout>
    );
  }

  if (error || !overview) {
    return (
      <EvalLayout>
        <div className="flex h-[60vh] items-center justify-center">
          <p className="text-sm text-gray-400">
            {error || "No evaluation data found. Configure AIDEN_EVAL_ROOT."}
          </p>
        </div>
      </EvalLayout>
    );
  }

  // Extract from actual API shape: {baseline: {clarify: {...}, rfc: {...}}, gapsBySeverity}
  const bl = overview.baseline || overview;
  const clarifyData = bl.clarify || {};
  const rfcData = bl.rfc || {};

  const clarifyAvg = clarifyData.avgScore ?? 0;
  const rfcAvg = rfcData.avgScore ?? 0;
  const clarifyCount = clarifyData.count ?? 0;
  const rfcCount = rfcData.count ?? 0;

  const clarifyDims = normalizeDims(clarifyData.dimensions);
  const rfcDims = normalizeDims(rfcData.dimensions);

  // Build heatmap from baseline API: {clarify: {with_mr: {caseId: result}}, rfc: {caseId: result}}
  const rfcBaseline = baseline?.rfc || {};
  const rfcCases = Object.keys(rfcBaseline);
  const heatmapData: Record<string, Record<string, { score: number; maxScore: number }>> = {};
  const rfcDimNames: string[] = [];

  for (const [caseId, raw] of Object.entries(rfcBaseline)) {
    const r = normalizeRfcResult(raw);
    heatmapData[caseId] = {};
    for (const dim of r.dimensions) {
      if (!rfcDimNames.includes(dim.name)) rfcDimNames.push(dim.name);
      heatmapData[caseId][dim.name] = { score: dim.score, maxScore: dim.maxScore };
    }
  }

  // Collect all gaps
  const allGaps = Object.entries(rfcBaseline).flatMap(([caseId, raw]) => {
    const r = normalizeRfcResult(raw);
    return (r.critical_gaps || []).map((g: any) => ({ ...g, caseId }));
  });

  return (
    <EvalLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Score Cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <ScoreCard
            label="Clarify Avg"
            score={clarifyAvg}
            subtitle={`${clarifyCount} cases`}
            accent="from-violet-500 to-purple-400"
          />
          <ScoreCard
            label="RFC Avg"
            score={rfcAvg}
            subtitle={`${rfcCount} cases`}
            accent="from-blue-500 to-cyan-400"
          />
          <ScoreCard
            label="Total Cases"
            score={clarifyCount + rfcCount}
            maxScore={clarifyCount + rfcCount || 1}
            subtitle="clarify + rfc"
            accent="from-emerald-500 to-teal-400"
          />
        </div>

        {/* Radar Charts */}
        <div className="grid gap-4 sm:grid-cols-2">
          {clarifyDims.length >= 3 && (
            <div className="flex items-center justify-center rounded-xl border border-gray-200/80 bg-white p-6">
              <RadarChart
                title="Clarify Dimensions"
                dimensions={clarifyDims}
                size={220}
              />
            </div>
          )}
          {rfcDims.length >= 3 && (
            <div className="flex items-center justify-center rounded-xl border border-gray-200/80 bg-white p-6">
              <RadarChart
                title="RFC Dimensions"
                dimensions={rfcDims}
                size={220}
              />
            </div>
          )}
        </div>

        {/* Heatmap */}
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
      </div>
    </EvalLayout>
  );
}
