import { useEffect, useState, useCallback, Fragment } from "react";
import { Layout } from "../components/Layout";
import { HudPanel } from "../components/HudPanel";
import { useAppStore } from "../stores/app";
import type { TokenStatus, SyncRule } from "../api/types";
import * as api from "../api/client";
import { cn } from "@/lib/utils";
import { Pencil, Trash2, X, Save, ArrowRight, RefreshCw, ChevronDown, Eye } from "lucide-react";

// ── Token Progress ──────────────────────────────────────

const MAX_TTL: Record<string, number> = {
  feishu: 2 * 60 * 60 * 1000,
  "bytedance-sso": 14 * 24 * 60 * 60 * 1000,
};

function tokenProgress(t: TokenStatus): number {
  if (!t.valid) return 0;
  const remaining = t.expiresAt - Date.now();
  if (remaining <= 0) return 0;
  const total = MAX_TTL[t.service] ?? remaining;
  return Math.min(100, Math.max(0, (remaining / total) * 100));
}

function progressColor(pct: number, valid: boolean): string {
  if (!valid) return "bg-destructive";
  if (pct < 20) return "bg-warning";
  return "bg-success";
}

function statusColor(pct: number, valid: boolean) {
  if (!valid) return { border: "border-destructive/40", bg: "bg-destructive/[0.08]", text: "text-destructive", bar: "border-l-destructive" };
  if (pct < 20) return { border: "border-warning/40", bg: "bg-warning/[0.08]", text: "text-warning", bar: "border-l-warning" };
  return { border: "border-success/40", bg: "bg-success/[0.08]", text: "text-success", bar: "border-l-success" };
}

// ── Formats ─────────────────────────────────────────────

const FORMATS = ["mirror", "json_kv", "bytedcli_token", "raw", "env"] as const;
const FORMAT_LABELS: Record<string, string> = {
  mirror: "Mirror (full JSON)",
  json_kv: "JSON Key-Value",
  bytedcli_token: "BytedCLI Token",
  raw: "Raw Value",
  env: "ENV File",
};

const EMPTY_RULE: SyncRule = { name: "", source: "", target: "", format: "mirror" };

// ── Component ───────────────────────────────────────────

export function Auth() {
  const { tokens, fetchTokens } = useAppStore();
  const [rules, setRules] = useState<SyncRule[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState<SyncRule>({ ...EMPTY_RULE });
  const [saving, setSaving] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ sourceContent: string | null; targetContent: string | null } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const fetchRules = useCallback(async () => {
    try { setRules(await api.getSyncRules()); } catch {}
  }, []);

  useEffect(() => {
    fetchTokens();
    fetchRules();
    const id = setInterval(fetchTokens, 30000);
    return () => clearInterval(id);
  }, []);

  const openNew = () => {
    setEditIdx(null);
    setDraft({ ...EMPTY_RULE });
    setDrawerOpen(true);
  };

  const openEdit = (idx: number) => {
    setEditIdx(idx);
    setDraft({ ...rules[idx] });
    setDrawerOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    const next = [...rules];
    if (editIdx !== null) {
      next[editIdx] = draft;
    } else {
      next.push(draft);
    }
    try {
      await api.updateSyncRules(next);
      setRules(next);
      setDrawerOpen(false);
    } catch {}
    setSaving(false);
  };

  const togglePreview = async (idx: number) => {
    if (expandedIdx === idx) {
      setExpandedIdx(null);
      setPreview(null);
      return;
    }
    setExpandedIdx(idx);
    setPreviewLoading(true);
    try {
      const data = await api.getSyncPreview(rules[idx].source, rules[idx].target);
      setPreview(data);
    } catch {
      setPreview({ sourceContent: null, targetContent: null });
    }
    setPreviewLoading(false);
  };

  const handleDelete = async (idx: number) => {
    const next = rules.filter((_, i) => i !== idx);
    try {
      await api.updateSyncRules(next);
      setRules(next);
    } catch {}
  };

  return (
    <Layout title="1Passport" subtitle="AUTH & SYNC">
      {/* ── Token Status ─────────────────────────────── */}
      <HudPanel title="Authentication Tokens" action={{ label: "Refresh", onClick: fetchTokens }} maxHeight={480}>
        {tokens.length === 0 ? (
          <div className="p-10 text-center font-mono text-xs text-muted-foreground">NO TOKENS CONFIGURED</div>
        ) : (
          <div className="grid gap-3 p-4">
            {tokens.map((t, i) => {
              const pct = tokenProgress(t);
              const sc = statusColor(pct, t.valid);
              return (
                <div
                  key={i}
                  className={cn(
                    "rounded-lg border border-l-[3px] bg-card/50 px-4 py-3 transition-colors hover:bg-accent/20",
                    sc.bar,
                  )}
                >
                  <div className="mb-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <span className="text-sm font-semibold text-foreground">{t.service}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{t.type}</span>
                      {t.refreshable && (
                        <RefreshCw className="h-3 w-3 text-muted-foreground" title="Auto-refreshable" />
                      )}
                    </div>
                    <span className={cn("rounded-sm border px-2.5 py-0.5 font-mono text-[9px] uppercase tracking-wide", sc.border, sc.bg, sc.text)}>
                      {!t.valid ? "EXPIRED" : pct < 20 ? "EXPIRING" : "VALID"}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full transition-[width] duration-700", progressColor(pct, t.valid))}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className={cn("min-w-[64px] text-right font-mono text-xs font-medium", sc.text)}>
                      {t.expiresIn}
                    </span>
                  </div>

                  <div className="mt-1.5 font-mono text-[9px] text-muted-foreground">
                    EXPIRES {t.expiresAt ? new Date(t.expiresAt).toLocaleString() : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </HudPanel>

      {/* ── Token Sync Rules ─────────────────────────── */}
      <div className="mt-5">
        <HudPanel
          title="Token Sync Rules"
          action={{ label: "+ Add Rule", onClick: openNew }}
          maxHeight={480}
        >
          {rules.length === 0 ? (
            <div className="p-10 text-center font-mono text-xs text-muted-foreground">NO SYNC RULES CONFIGURED</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-2.5">Name</th>
                    <th className="px-4 py-2.5">Source</th>
                    <th className="px-4 py-2.5">Target</th>
                    <th className="px-4 py-2.5">Format</th>
                    <th className="w-20 px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <Fragment key={i}>
                      <tr className={cn("border-b border-border/50 transition-colors hover:bg-accent/20", expandedIdx === i && "bg-accent/10")}>
                        <td className="px-4 py-3 font-medium text-foreground">{r.name}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center gap-1.5 font-mono text-xs">
                            <span className="text-chart-1">{r.source.split("/")[0]}</span>
                            <span className="text-muted-foreground">/</span>
                            <span className="text-chart-2">{r.source.split("/").slice(1).join("/")}</span>
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{r.target}</td>
                        <td className="px-4 py-3">
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{r.format}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1">
                            <button onClick={() => togglePreview(i)} className={cn("rounded p-1 transition-colors", expandedIdx === i ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground")} title="Preview">
                              <Eye className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => openEdit(i)} className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="Edit">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => handleDelete(i)} className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title="Delete">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expandedIdx === i && (
                        <tr>
                          <td colSpan={5} className="border-b border-border/50 bg-muted/20 p-0">
                            <div className="grid grid-cols-2 gap-0 divide-x divide-border">
                              <div className="p-3">
                                <div className="mb-2 flex items-center gap-2">
                                  <div className="h-2 w-2 rounded-full bg-chart-1" />
                                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Source Token</span>
                                  <span className="font-mono text-[10px] text-chart-1">{r.source}</span>
                                </div>
                                {previewLoading ? (
                                  <div className="py-4 text-center text-xs text-muted-foreground">Loading...</div>
                                ) : (
                                  <pre className="max-h-[200px] overflow-auto rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
                                    {preview?.sourceContent ?? <span className="text-muted-foreground italic">No data</span>}
                                  </pre>
                                )}
                              </div>
                              <div className="p-3">
                                <div className="mb-2 flex items-center gap-2">
                                  <div className="h-2 w-2 rounded-full bg-chart-2" />
                                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Synced File</span>
                                  <span className="font-mono text-[10px] text-chart-2">{r.target}</span>
                                </div>
                                {previewLoading ? (
                                  <div className="py-4 text-center text-xs text-muted-foreground">Loading...</div>
                                ) : (
                                  <pre className="max-h-[200px] overflow-auto rounded-md bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
                                    {preview?.targetContent ?? <span className="text-muted-foreground italic">No data</span>}
                                  </pre>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </HudPanel>
      </div>

      {/* ── Drawer Overlay ───────────────────────────── */}
      {drawerOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/40" onClick={() => setDrawerOpen(false)} />
          <div className="fixed bottom-0 right-0 top-0 z-50 flex w-[420px] flex-col border-l border-border bg-background shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <h3 className="text-sm font-semibold">{editIdx !== null ? "Edit Sync Rule" : "New Sync Rule"}</h3>
              <button onClick={() => setDrawerOpen(false)} className="rounded p-1 text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Form */}
            <div className="flex-1 space-y-4 overflow-y-auto p-5">
              {/* Preview */}
              <div className="flex items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3">
                <span className="font-mono text-xs text-chart-1">{draft.source || "source"}</span>
                <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-mono text-xs text-chart-2">{draft.target || "target"}</span>
              </div>

              <Field label="Name" hint="Human-readable identifier">
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary"
                  placeholder="e.g. lark-mcp-server"
                />
              </Field>

              <Field label="Source" hint="adapter/tokenType or adapter/*">
                <input
                  value={draft.source}
                  onChange={(e) => setDraft({ ...draft, source: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary"
                  placeholder="e.g. feishu/* or bytedance-sso/access"
                />
              </Field>

              <Field label="Target" hint="File path (~ supported)">
                <input
                  value={draft.target}
                  onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary"
                  placeholder="e.g. ~/.lark_auth/tokens.json"
                />
              </Field>

              <Field label="Format">
                <select
                  value={draft.format}
                  onChange={(e) => setDraft({ ...draft, format: e.target.value })}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary"
                >
                  {FORMATS.map(f => (
                    <option key={f} value={f}>{FORMAT_LABELS[f] ?? f}</option>
                  ))}
                </select>
              </Field>

              {(draft.format === "json_kv" || draft.format === "env") && (
                <Field label="Key" hint="Key name in output">
                  <input
                    value={draft.key ?? ""}
                    onChange={(e) => setDraft({ ...draft, key: e.target.value || undefined })}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-primary"
                    placeholder="e.g. token"
                  />
                </Field>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 border-t border-border px-5 py-4">
              <button
                onClick={handleSave}
                disabled={saving || !draft.name || !draft.source || !draft.target}
                className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={() => setDrawerOpen(false)}
                className="rounded-md border border-border px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
    </Layout>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-foreground">{label}</span>
      {hint && <span className="mb-1.5 block text-[10px] text-muted-foreground">{hint}</span>}
      {children}
    </label>
  );
}
