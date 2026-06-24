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
  Boxes,
  RefreshCw,
  Plus,
  Trash2,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";
import { request } from "../api/client";
import { PageHeader, EmptyState, SkeletonGrid, staggerStyle } from "../components/configkit";

interface Provider {
  id: string;
  appType: "claude" | "codex" | "gemini";
  name: string;
  settingsConfig: any;
  category: string | null;
  isCurrent: boolean;
}

interface ProvidersListResponse {
  providers: Provider[];
}

interface ProviderSwitchResponse {
  applied?: {
    files?: string[];
    notes?: string[];
  };
}

const APPS: ("claude" | "codex" | "gemini")[] = ["claude", "codex", "gemini"];
const APP_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

export function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<Provider | null>(null);
  const [form, setForm] = useState({
    id: "",
    appType: "claude" as Provider["appType"],
    name: "",
    category: "",
    settingsJson: '{\n  "baseUrl": "",\n  "model": ""\n}',
  });
  const [formError, setFormError] = useState<string | null>(null);

  const fetchProviders = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request<ProvidersListResponse>("/api/v1/config-hub/providers");
      setProviders(res.providers ?? []);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchProviders();
  }, []);

  const handleSwitch = async (p: Provider) => {
    setError(null);
    setApplied(null);
    try {
      const res = await request<ProviderSwitchResponse>(`/api/v1/config-hub/providers/${encodeURIComponent(p.id)}/switch`, {
        method: "PUT",
        body: JSON.stringify({ app: p.appType }),
      });
      const files: string[] = res?.applied?.files ?? [];
      const notes: string[] = res?.applied?.notes ?? [];
      setApplied(
        files.length
          ? `Switched to ${p.name}. Wrote: ${files.map((f) => f.replace(/^\/home\/[^/]+/, "~")).join(", ")}${notes.length ? " — " + notes.join(" ") : ""}`
          : `Switched to ${p.name} (no auth file writer for this tool).`,
      );
      fetchProviders();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (p: Provider) => {
    try {
      await request(
        `/api/v1/config-hub/providers/${encodeURIComponent(p.id)}?app=${encodeURIComponent(p.appType)}`,
        { method: "DELETE" },
      );
      setDeleteConfirm(null);
      fetchProviders();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleAdd = async () => {
    setFormError(null);
    if (!form.id || !form.name) {
      setFormError("ID and name are required");
      return;
    }
    let settings: unknown = {};
    try {
      settings = form.settingsJson.trim() ? JSON.parse(form.settingsJson) : {};
    } catch (e: any) {
      setFormError(`settings JSON invalid: ${e.message}`);
      return;
    }
    try {
      await request("/api/v1/config-hub/providers", {
        method: "POST",
        body: JSON.stringify({
          id: form.id,
          appType: form.appType,
          name: form.name,
          category: form.category || undefined,
          settingsConfig: settings,
        }),
      });
      setAddOpen(false);
      setForm({
        id: "",
        appType: "claude",
        name: "",
        category: "",
        settingsJson: '{\n  "baseUrl": "",\n  "model": ""\n}',
      });
      fetchProviders();
    } catch (e: any) {
      setFormError(e.message);
    }
  };

  const byApp = (app: Provider["appType"]) => providers.filter((p) => p.appType === app);

  return (
    <Layout title="Providers" subtitle="API ENDPOINTS PER TOOL">
      <div className="flex flex-col gap-3 h-[calc(100vh-8rem)]">
        <PageHeader
          icon={Boxes}
          title="Providers"
          subtitle="API endpoint presets grouped by tool — flip which one each tool uses."
          count={providers.length}
          countLabel="providers"
          actions={
            <>
              <Button variant="outline" size="sm" onClick={fetchProviders} className="h-7 text-xs">
                <RefreshCw className="mr-1 h-3 w-3" /> Refresh
              </Button>
              <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-xs">
                <Plus className="mr-1 h-3 w-3" /> Add Provider
              </Button>
            </>
          }
        />

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </div>
        )}
        {applied && (
          <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{applied}</span>
          </div>
        )}

        {loading ? (
          <SkeletonGrid count={3} cols="grid-cols-1" />
        ) : providers.length === 0 ? (
          <EmptyState
            icon={Boxes}
            title="No providers yet"
            description="Save an API endpoint preset (key, base URL, model) per tool. The 'current' one is what that tool will use."
            action={
              <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-xs">
                <Plus className="mr-1 h-3 w-3" /> Add Provider
              </Button>
            }
          />
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-4">
              {APPS.map((app) => {
                const list = byApp(app);
                return (
                  <div key={app}>
                    <div className="mb-1.5 flex items-center gap-2 px-1">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {APP_LABELS[app]}
                      </span>
                      <span className="text-[10px] text-muted-foreground/70">
                        ({list.length})
                      </span>
                    </div>
                    {list.length === 0 ? (
                      <div className="rounded-md border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground/70">
                        No providers for {APP_LABELS[app]} yet.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {list.map((p) => (
                          <Card key={`${p.appType}:${p.id}`} className="transition-colors hover:bg-accent/10">
                            <CardContent className="p-3">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
                                  <span className="font-mono text-sm font-medium">{p.name}</span>
                                  {p.isCurrent && (
                                    <Badge className="text-[9px]" variant="default">
                                      <CheckCircle2 className="mr-1 h-2.5 w-2.5" /> current
                                    </Badge>
                                  )}
                                  {p.category && (
                                    <Badge variant="outline" className="text-[9px]">
                                      {p.category}
                                    </Badge>
                                  )}
                                </div>
                                <div className="flex items-center gap-1">
                                  {!p.isCurrent && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => handleSwitch(p)}
                                      className="h-6 text-[11px]"
                                    >
                                      Switch
                                    </Button>
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                                    onClick={() => setDeleteConfirm(p)}
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                              <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted/30 p-2 font-mono text-[10px] text-muted-foreground">
                                {JSON.stringify(p.settingsConfig, null, 2)}
                              </pre>
                            </CardContent>
                          </Card>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Add Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Provider</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <input
              value={form.id}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="ID (e.g. anthropic-primary)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm outline-none focus:border-input"
            />
            <select
              value={form.appType}
              onChange={(e) => setForm((f) => ({ ...f, appType: e.target.value as any }))}
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            >
              {APPS.map((a) => (
                <option key={a} value={a}>
                  {APP_LABELS[a]}
                </option>
              ))}
            </select>
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Name"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
            <input
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              placeholder="Category (optional)"
              className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
            <textarea
              value={form.settingsJson}
              onChange={(e) => setForm((f) => ({ ...f, settingsJson: e.target.value }))}
              placeholder='Settings JSON ({"baseUrl":"...","model":"..."})'
              rows={6}
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
            <Button size="sm" onClick={handleAdd}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Provider</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Remove{" "}
            <span className="font-mono font-medium text-foreground">
              {deleteConfirm?.name} ({deleteConfirm && APP_LABELS[deleteConfirm.appType]})
            </span>
            ?
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
