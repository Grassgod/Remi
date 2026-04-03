import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { EvalLayout } from "./EvalLayout";
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

const STATUS_STYLES: Record<string, string> = {
  done: "bg-emerald-50 text-emerald-700 ring-emerald-200/60",
  doing: "bg-amber-50 text-amber-700 ring-amber-200/60",
  pending: "bg-gray-100 text-gray-500 ring-gray-200/60",
};

export function EvalCases() {
  const [, navigate] = useLocation();
  const [cases, setCases] = useState<EvalCase[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog state
  const [showForm, setShowForm] = useState(false);
  const [editCase, setEditCase] = useState<EvalCase | null>(null);

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchCases = () => {
    fetch("/api/v1/eval/cases")
      .then((r) => r.json())
      .then((data) => setCases(data.cases || data || []))
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchCases();
  }, []);

  const openCreate = () => {
    setEditCase(null);
    setShowForm(true);
  };

  const openEdit = (c: EvalCase, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditCase(c);
    setShowForm(true);
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deleteId === id) {
      // Confirmed - do the delete
      setDeleting(true);
      try {
        await fetch(`/api/v1/eval/cases/${id}`, { method: "DELETE" });
        fetchCases();
      } catch (err) {
        console.error(err);
      } finally {
        setDeleting(false);
        setDeleteId(null);
      }
    } else {
      setDeleteId(id);
    }
  };

  const cancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteId(null);
  };

  const ExternalLinkIcon = () => (
    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-4.5-6H18m0 0v4.5m0-4.5L10.5 13.5" />
    </svg>
  );

  return (
    <EvalLayout>
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Test Cases</h2>
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:border-gray-300 hover:bg-gray-50"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Case
          </button>
        </div>

        {loading ? (
          <div className="py-16 text-center text-sm text-gray-300 animate-pulse">
            Loading...
          </div>
        ) : cases.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-200 p-12 text-center text-sm text-gray-400">
            No cases found. Click "New Case" to create one.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200/80 bg-white shadow-sm">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/50">
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Case ID</th>
                  <th className="px-3 py-3 text-center font-medium text-gray-500">PRD</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Platform</th>
                  <th className="px-4 py-3 text-center font-medium text-gray-500">MRs</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-500">Tags</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/eval/cases/${c.id}`)}
                    className="cursor-pointer border-b border-gray-50 transition-colors hover:bg-blue-50/30 last:border-0"
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-gray-800">
                      {c.id}
                    </td>

                    {/* Links */}
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-center gap-2">
                        {c.prd_url && (
                          <a
                            href={c.prd_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-gray-400 transition-colors hover:text-blue-500"
                            title="PRD"
                          >
                            <ExternalLinkIcon />
                          </a>
                        )}
                        {c.meego_url && (
                          <a
                            href={c.meego_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-gray-400 transition-colors hover:text-blue-500"
                            title="Meego"
                          >
                            <ExternalLinkIcon />
                          </a>
                        )}
                      </div>
                    </td>

                    <td className="px-4 py-3 text-gray-500">{c.platform}</td>

                    <td className="px-4 py-3 text-center">
                      <span className="font-mono text-gray-500">
                        {c.mr_list?.length || 0}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${
                          STATUS_STYLES[c.status] || STATUS_STYLES.pending
                        }`}
                      >
                        {c.status}
                      </span>
                    </td>

                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {(c.tags || []).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>

                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={(e) => openEdit(c, e)}
                          className="rounded-md px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                        >
                          Edit
                        </button>
                        {deleteId === c.id ? (
                          <>
                            <button
                              onClick={(e) => handleDelete(c.id, e)}
                              disabled={deleting}
                              className="rounded-md px-2 py-1 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                            >
                              {deleting ? "..." : "Confirm"}
                            </button>
                            <button
                              onClick={cancelDelete}
                              className="rounded-md px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-gray-100"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={(e) => handleDelete(c.id, e)}
                            className="rounded-md px-2 py-1 text-[11px] text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create/Edit Dialog */}
      <CaseFormDialog
        open={showForm}
        onClose={() => setShowForm(false)}
        onSaved={fetchCases}
        editCase={editCase}
      />
    </EvalLayout>
  );
}
