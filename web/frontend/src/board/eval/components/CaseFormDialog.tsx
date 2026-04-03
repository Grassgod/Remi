import { useEffect, useState } from "react";

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

interface CaseFormDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editCase?: EvalCase | null;
}

const PLATFORMS = ["server", "client", "both"];
const STATUSES = ["pending", "doing", "done"];

export function CaseFormDialog({ open, onClose, onSaved, editCase }: CaseFormDialogProps) {
  const isEdit = !!editCase;

  const [caseId, setCaseId] = useState("");
  const [prdUrl, setPrdUrl] = useState("");
  const [meegoUrl, setMeegoUrl] = useState("");
  const [platform, setPlatform] = useState("server");
  const [repo, setRepo] = useState("");
  const [mrList, setMrList] = useState<string[]>([""]);
  const [tags, setTags] = useState("");
  const [status, setStatus] = useState("pending");
  const [gt, setGt] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Reset form when dialog opens or editCase changes
  useEffect(() => {
    if (!open) return;
    if (editCase) {
      setCaseId(editCase.id);
      setPrdUrl(editCase.prd_url || "");
      setMeegoUrl(editCase.meego_url || "");
      setPlatform(editCase.platform || "server");
      setRepo(editCase.repo || "");
      setMrList(editCase.mr_list?.length ? [...editCase.mr_list] : [""]);
      setTags((editCase.tags || []).join(", "));
      setStatus(editCase.status || "pending");
      setGt(editCase.gt || "");
      setNotes(editCase.notes || "");
    } else {
      setCaseId("");
      setPrdUrl("");
      setMeegoUrl("");
      setPlatform("server");
      setRepo("");
      setMrList([""]);
      setTags("");
      setStatus("pending");
      setGt("");
      setNotes("");
    }
    setError("");
  }, [open, editCase]);

  const handleMrChange = (index: number, value: string) => {
    const updated = [...mrList];
    updated[index] = value;
    setMrList(updated);
  };

  const addMr = () => setMrList([...mrList, ""]);

  const removeMr = (index: number) => {
    if (mrList.length <= 1) {
      setMrList([""]);
      return;
    }
    setMrList(mrList.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!caseId.trim()) {
      setError("Case ID is required");
      return;
    }
    setSaving(true);
    setError("");

    const payload = {
      id: caseId.trim(),
      prd_url: prdUrl.trim(),
      meego_url: meegoUrl.trim(),
      platform,
      repo: repo.trim(),
      mr_list: mrList.map((m) => m.trim()).filter(Boolean),
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      status,
      gt,
      notes,
    };

    try {
      const url = isEdit
        ? `/api/v1/eval/cases/${editCase!.id}`
        : "/api/v1/eval/cases";
      const method = isEdit ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || body.message || `Request failed (${res.status})`);
      }

      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const inputClass =
    "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder:text-gray-300 outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-200 transition-colors";
  const labelClass = "mb-1.5 block text-xs font-medium text-gray-500";
  const selectClass =
    "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none focus:border-gray-400 focus:ring-1 focus:ring-gray-200 transition-colors appearance-none cursor-pointer";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 backdrop-blur-sm">
      <div className="relative mx-4 my-8 w-full max-w-2xl rounded-2xl border border-gray-200/80 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-sm font-semibold text-gray-800">
            {isEdit ? "Edit Case" : "New Case"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[calc(100vh-12rem)] overflow-y-auto px-6 py-5">
          <div className="space-y-4">
            {/* Case ID */}
            <div>
              <label className={labelClass}>Case ID *</label>
              <input
                className={inputClass}
                value={caseId}
                onChange={(e) => setCaseId(e.target.value)}
                placeholder="e.g. case-001"
                disabled={isEdit}
              />
            </div>

            {/* PRD + Meego URLs side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>PRD URL</label>
                <input
                  className={inputClass}
                  value={prdUrl}
                  onChange={(e) => setPrdUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
              <div>
                <label className={labelClass}>Meego URL</label>
                <input
                  className={inputClass}
                  value={meegoUrl}
                  onChange={(e) => setMeegoUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
            </div>

            {/* Platform + Repo side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Platform</label>
                <select
                  className={selectClass}
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value)}
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass}>Repo</label>
                <input
                  className={inputClass}
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="e.g. org/repo-name"
                />
              </div>
            </div>

            {/* MR Links */}
            <div>
              <label className={labelClass}>MR Links</label>
              <div className="space-y-2">
                {mrList.map((mr, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      className={inputClass}
                      value={mr}
                      onChange={(e) => handleMrChange(i, e.target.value)}
                      placeholder="https://code.byted.org/..."
                    />
                    <button
                      type="button"
                      onClick={() => removeMr(i)}
                      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-400 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-500"
                    >
                      <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
                      </svg>
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addMr}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-600"
                >
                  <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                  </svg>
                  Add MR
                </button>
              </div>
            </div>

            {/* Tags + Status side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelClass}>Tags</label>
                <input
                  className={inputClass}
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="tag1, tag2, tag3"
                />
              </div>
              <div>
                <label className={labelClass}>Status</label>
                <select
                  className={selectClass}
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Ground Truth */}
            <div>
              <label className={labelClass}>Ground Truth</label>
              <textarea
                className={`${inputClass} min-h-[180px] resize-y font-mono text-xs leading-relaxed`}
                value={gt}
                onChange={(e) => setGt(e.target.value)}
                placeholder="Markdown content..."
                rows={8}
              />
            </div>

            {/* Notes */}
            <div>
              <label className={labelClass}>Notes</label>
              <textarea
                className={`${inputClass} resize-y`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Additional notes..."
                rows={3}
              />
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="rounded-lg bg-gray-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : isEdit ? "Save Changes" : "Create Case"}
          </button>
        </div>
      </div>
    </div>
  );
}
