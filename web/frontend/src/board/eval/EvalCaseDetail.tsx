import { useEffect, useState } from "react";
import { useRoute } from "wouter";
import { EvalLayout } from "./EvalLayout";
import { MarkdownFileViewer } from "../../components/MarkdownFileViewer";
import { CaseFormDialog } from "./components/CaseFormDialog";

interface EvalCase {
  id: string;
  prd_url: string;
  meego_url: string;
  platform: string;
  mr_list: string[];
  repo: string;
  gt: string;
  original_gt: string;
  revised_gt: string;
  code_snippets: string;
  status: string;
  tags: string[];
  notes: string;
  created_at: string;
  updated_at: string;
  completeness?: Record<string, boolean>;
}

interface CaseDetailResponse extends EvalCase {
  baseline?: {
    clarify?: any;
    rfc?: any;
  };
}

const STATUS_STYLES: Record<string, string> = {
  done: "bg-emerald-50 text-emerald-700 ring-emerald-200/60",
  doing: "bg-amber-50 text-amber-700 ring-amber-200/60",
  pending: "bg-gray-100 text-gray-500 ring-gray-200/60",
};

/* ── Score normalizers (preserved from original) ── */

function normalizeRfcDims(r: any) {
  const rawDims = r?.["\u6253\u5206\u7ef4\u5ea6"] || r?.dimensions || [];
  return rawDims.map((d: any) => ({
    name: d["\u7ef4\u5ea6\u540d\u79f0"] || d.name || "",
    score: d.score ?? 0,
    maxScore: d.max_score ?? d.maxScore ?? 0,
    reason: d.reason || "",
  }));
}

function normalizeClarifyDims(r: any) {
  const rawDims = r?.["\u6253\u5206\u7ef4\u5ea6/\u5206\u7c7b"] || r?.["\u6253\u5206\u7ef4\u5ea6"] || r?.dimensions || [];
  return rawDims.map((d: any) => ({
    name: d["\u7ef4\u5ea6\u540d\u79f0"] || d.name || "",
    score: d.score ?? 0,
    maxScore: d.max_score ?? d.maxScore ?? 100,
    reason: d.reason || "",
  }));
}

function ScoreSection({ title, result, normFn }: { title: string; result: any; normFn: (r: any) => any[] }) {
  if (!result) return null;
  const dims = normFn(result);

  return (
    <div className="rounded-xl border border-gray-200/80 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">{title}</h3>
        <span className="text-2xl font-bold tabular-nums text-gray-900">
          {result.total_score ?? 0}
          <span className="text-sm font-normal text-gray-300">
            /{result.max_total_score || 100}
          </span>
        </span>
      </div>

      <div className="space-y-3">
        {dims.map((d: any, i: number) => {
          const ratio = d.maxScore > 0 ? d.score / d.maxScore : 0;
          return (
            <div key={i}>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] text-gray-500">{d.name}</span>
                <span className="font-mono text-[11px] tabular-nums text-gray-700">
                  {d.score}/{d.maxScore}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    ratio >= 0.8
                      ? "bg-emerald-400"
                      : ratio >= 0.6
                        ? "bg-blue-400"
                        : "bg-amber-400"
                  }`}
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
              {d.reason && (
                <p className="mt-1 text-[10px] leading-relaxed text-gray-400">
                  {d.reason.slice(0, 200)}
                  {d.reason.length > 200 ? "..." : ""}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {result.improvement_suggestion && (
        <div className="mt-4 rounded-lg bg-blue-50/50 p-3">
          <p className="text-[10px] font-medium text-blue-600">Improvement</p>
          <p className="mt-1 text-[11px] leading-relaxed text-blue-700">
            {result.improvement_suggestion.slice(0, 500)}
          </p>
        </div>
      )}
    </div>
  );
}

/* ── External link icon ── */

const ExternalLinkIcon = () => (
  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6H18m0 0v4.5m0-4.5L10.5 13.5" />
  </svg>
);

/* ── Main component ── */

export function EvalCaseDetail() {
  const [, params] = useRoute("/eval/cases/:id");
  const caseId = params?.id ?? "";
  const [detail, setDetail] = useState<CaseDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("");
  const [showEdit, setShowEdit] = useState(false);

  const fetchDetail = () => {
    if (!caseId) return;
    fetch(`/api/v1/eval/cases/${caseId}`)
      .then((r) => r.json())
      .then((data) => {
        setDetail(data);
        // Auto-select first tab with content
        const tabs = buildTabs(data);
        if (tabs.length > 0 && !tabs.find((t) => t.key === activeTab)) {
          setActiveTab(tabs[0].key);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchDetail();
  }, [caseId]);

  if (loading) {
    return (
      <EvalLayout>
        <div className="flex h-[60vh] items-center justify-center">
          <p className="animate-pulse text-sm text-gray-300">Loading...</p>
        </div>
      </EvalLayout>
    );
  }

  if (!detail) {
    return (
      <EvalLayout>
        <div className="flex h-[60vh] items-center justify-center">
          <p className="text-sm text-gray-400">Case not found.</p>
        </div>
      </EvalLayout>
    );
  }

  const tabs = buildTabs(detail);
  const activeContent = tabs.find((t) => t.key === activeTab)?.content || tabs[0]?.content || "";

  return (
    <EvalLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-gray-800">{detail.id}</h2>
              <span
                className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
                  STATUS_STYLES[detail.status] || STATUS_STYLES.pending
                }`}
              >
                {detail.status}
              </span>
            </div>
            {detail.repo && (
              <p className="mt-0.5 font-mono text-xs text-gray-400">{detail.repo}</p>
            )}

            {/* Link row */}
            <div className="mt-2 flex flex-wrap items-center gap-3">
              {detail.prd_url && (
                <a
                  href={detail.prd_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-blue-500"
                >
                  <ExternalLinkIcon />
                  <span>PRD</span>
                </a>
              )}
              {detail.meego_url && (
                <a
                  href={detail.meego_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-blue-500"
                >
                  <ExternalLinkIcon />
                  <span>Meego</span>
                </a>
              )}
              {(detail.mr_list || []).map((mr, i) => (
                <a
                  key={i}
                  href={mr}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-blue-500"
                >
                  <ExternalLinkIcon />
                  <span>MR {detail.mr_list.length > 1 ? i + 1 : ""}</span>
                </a>
              ))}
            </div>
          </div>

          <button
            onClick={() => setShowEdit(true)}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-500 transition-colors hover:border-gray-300 hover:text-gray-700"
          >
            Edit
          </button>
        </div>

        {/* Tags */}
        {detail.tags && detail.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {detail.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[10px] font-medium text-blue-600 ring-1 ring-blue-200/60"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Content tabs */}
        {tabs.length > 0 && (
          <div className="rounded-xl border border-gray-200/80 bg-white shadow-sm">
            <div className="flex gap-1 border-b border-gray-100 px-4 pt-3">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`rounded-t-lg px-3 py-2 text-xs font-medium transition-colors ${
                    activeTab === t.key
                      ? "border-b-2 border-gray-800 text-gray-800"
                      : "text-gray-400 hover:text-gray-600"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="p-4">
              <MarkdownFileViewer content={activeContent} readOnly />
            </div>
          </div>
        )}

        {/* Notes */}
        {detail.notes && (
          <div className="rounded-xl border border-gray-200/80 bg-white p-5">
            <h3 className="mb-2 text-sm font-semibold text-gray-700">Notes</h3>
            <p className="text-xs leading-relaxed text-gray-500 whitespace-pre-wrap">{detail.notes}</p>
          </div>
        )}

        {/* Baseline scores */}
        {detail.baseline && (detail.baseline.clarify || detail.baseline.rfc) && (
          <div className="grid gap-4 lg:grid-cols-2">
            <ScoreSection
              title="Clarify Baseline"
              result={detail.baseline?.clarify}
              normFn={normalizeClarifyDims}
            />
            <ScoreSection
              title="RFC Baseline"
              result={detail.baseline?.rfc}
              normFn={normalizeRfcDims}
            />
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <CaseFormDialog
        open={showEdit}
        onClose={() => setShowEdit(false)}
        onSaved={fetchDetail}
        editCase={detail}
      />
    </EvalLayout>
  );
}

/* ── Tab builder: only show tabs that have content ── */

function buildTabs(detail: CaseDetailResponse) {
  // Support both flat fields and nested content object (backward compat)
  const contentMap: Record<string, { label: string; value: string | undefined }> = {
    gt: { label: "Ground Truth", value: detail.gt || (detail as any).content?.gt },
    original_gt: { label: "Original GT", value: detail.original_gt || (detail as any).content?.original_gt },
    revised_gt: { label: "Revised GT", value: detail.revised_gt || (detail as any).content?.revised_gt },
    clarify: { label: "Clarify", value: (detail as any).content?.clarify },
    design: { label: "Design", value: (detail as any).content?.design },
    tasks: { label: "Tasks", value: (detail as any).content?.tasks },
  };

  return Object.entries(contentMap)
    .filter(([, v]) => v.value)
    .map(([key, v]) => ({
      key,
      label: v.label,
      content: v.value!,
    }));
}
