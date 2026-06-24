import { useEffect, useState, useCallback } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import {
  FileText,
  RefreshCw,
  Plus,
  Trash2,
  AlertCircle,
  ToggleLeft,
  ToggleRight,
  AlertTriangle,
} from "lucide-react";
import { request } from "../api/client";
import { PageHeader, EmptyState, SkeletonGrid, staggerStyle } from "../components/configkit";

interface Prompt {
  id: string;
  name: string;
  content: string;
  description: string | null;
  enabled: boolean;
}

interface SyncResponse {
  sync?: { conflicts?: string[] };
}

interface PromptsListResponse {
  prompts: Prompt[];
}

export function Prompts() {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [form, setForm] = useState({ id: "", name: "", description: "", content: "" });
  const [formError, setFormError] = useState<string | null>(null);

  const fetchPrompts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request<PromptsListResponse>("/api/v1/config-hub/prompts");
      setPrompts(res.prompts ?? []);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchPrompts();
  }, []);

  const collectConflicts = (sync: any): string[] =>
    Array.isArray(sync?.conflicts) ? sync.conflicts : [];

  const handleToggle = async (id: string, current: boolean) => {
    try {
      const res = await request<SyncResponse>(
        `/api/v1/config-hub/prompts/${encodeURIComponent(id)}/toggle`,
        { method: "PUT", body: JSON.stringify({ enabled: !current }) },
      );
      setConflicts(collectConflicts(res.sync));
      fetchPrompts();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await request<SyncResponse>(`/api/v1/config-hub/prompts/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      setConflicts(collectConflicts(res.sync));
      setDeleteConfirm(null);
      fetchPrompts();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const openAdd = () => {
    setForm({ id: "", name: "", description: "", content: "" });
    setFormError(null);
    setEditing(null);
    setAddOpen(true);
  };

  const openEdit = (p: Prompt) => {
    setForm({ id: p.id, name: p.name, description: p.description ?? "", content: p.content });
    setFormError(null);
    setEditing(p);
    setAddOpen(true);
  };

  const handleSave = async () => {
    setFormError(null);
    if (!form.id || !form.name || !form.content) {
      setFormError("ID, name and content are required");
      return;
    }
    try {
      const res = await request<SyncResponse>("/api/v1/config-hub/prompts", {
        method: "POST",
        body: JSON.stringify({
          id: form.id,
          name: form.name,
          description: form.description,
          content: form.content,
          enabled: editing?.enabled ?? true,
        }),
      });
      setConflicts(collectConflicts(res.sync));
      setAddOpen(false);
      fetchPrompts();
    } catch (e: any) {
      setFormError(e.message);
    }
  };

  const handleSync = async () => {
    try {
      const res = await request<SyncResponse>(`/api/v1/config-hub/prompts/sync`, { method: "POST" });
      setConflicts(collectConflicts(res.sync));
      fetchPrompts();
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <Layout title="Prompts" subtitle="CLAUDE.md ↔ AGENTS.md ↔ GEMINI.md">
      <div className="flex flex-col gap-3 h-[calc(100vh-8rem)]">
        <PageHeader
          icon={FileText}
          title="Prompts"
          subtitle="Single canonical instruction fanned out into CLAUDE.md / AGENTS.md / GEMINI.md managed blocks."
          count={prompts.length}
          countLabel="prompts"
          actions={
            <>
              <Button variant="outline" size="sm" onClick={handleSync} className="h-7 text-xs">
                <RefreshCw className="mr-1 h-3 w-3" /> Sync
              </Button>
              <Button size="sm" onClick={openAdd} className="h-7 text-xs">
                <Plus className="mr-1 h-3 w-3" /> Add Prompt
              </Button>
            </>
          }
        />

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </div>
        )}

        {conflicts.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Sync conflicts (file & DB both changed):</div>
              <ul className="mt-0.5 list-disc pl-4">
                {conflicts.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {loading ? (
          <SkeletonGrid count={2} cols="grid-cols-1" />
        ) : prompts.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="No prompts yet"
            description="Write a canonical instruction once — it fans out to every tool's CLAUDE.md/AGENTS.md/GEMINI.md as a managed block. User prose outside the block stays untouched."
            action={
              <Button size="sm" onClick={openAdd} className="h-7 text-xs">
                <Plus className="mr-1 h-3 w-3" /> Add Prompt
              </Button>
            }
          />
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-2">
              {prompts.map((p, i) => (
                <Card
                  key={p.id}
                  className="cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/10 hover:shadow-md"
                  style={staggerStyle(i, 60, 40)}
                  onClick={() => openEdit(p)}
                >
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-sm font-medium">{p.name}</span>
                        {p.enabled && (
                          <Badge className="text-[9px]" variant="default">
                            active
                          </Badge>
                        )}
                        {p.description && (
                          <span className="text-xs text-muted-foreground">{p.description}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => handleToggle(p.id, p.enabled)}
                          className="flex items-center gap-1 px-2 text-xs transition-colors"
                          title={p.enabled ? "Disable" : "Enable"}
                        >
                          {p.enabled ? (
                            <ToggleRight className="h-4 w-4 text-primary" />
                          ) : (
                            <ToggleLeft className="h-4 w-4 text-muted-foreground/40" />
                          )}
                        </button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteConfirm(p.id)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    <pre className="mt-2 max-h-24 overflow-hidden rounded bg-muted/30 p-2 font-mono text-[11px] text-muted-foreground">
                      {p.content.length > 240 ? p.content.slice(0, 240) + "…" : p.content}
                    </pre>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Add / Edit Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Prompt" : "Add Prompt"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <input
              value={form.id}
              disabled={!!editing}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="ID (e.g. tone-guide)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm outline-none disabled:opacity-60 focus:border-input"
            />
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Name"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
            <input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
            <textarea
              value={form.content}
              onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
              placeholder="Canonical content — fanned out into the managed block of CLAUDE.md / AGENTS.md / GEMINI.md"
              rows={10}
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs outline-none focus:border-input"
            />
          </div>
          {formError && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3 w-3" /> {formError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Prompt</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Remove <span className="font-mono font-medium text-foreground">{deleteConfirm}</span>?
            Its block will be cleared from all three tool files (user prose outside the block stays untouched).
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
