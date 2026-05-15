import { useEffect, useState, useCallback } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import {
  Server, RefreshCw, Plus, Trash2, AlertCircle, ToggleLeft, ToggleRight,
} from "lucide-react";
import { request } from "../api/client";

interface McpServer {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  transport: string;
  apps: Record<string, boolean>;
}

const APP_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  hermes: "OpenClaw",
};

export function Mcp() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [available, setAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ id: "", name: "", command: "", args: "", description: "" });
  const [addError, setAddError] = useState<string | null>(null);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request("/api/v1/cc-switch/mcp");
      setServers(res.servers);
      setAvailable(res.available);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchServers(); }, []);

  const handleToggle = async (id: string, app: string, currentValue: boolean) => {
    try {
      await request(`/api/v1/cc-switch/mcp/${encodeURIComponent(id)}/toggle`, {
        method: "PUT",
        body: JSON.stringify({ app, enabled: !currentValue }),
      });
      setServers(prev => prev.map(s =>
        s.id === id ? { ...s, apps: { ...s.apps, [app]: !currentValue } } : s
      ));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await request(`/api/v1/cc-switch/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
      setServers(prev => prev.filter(s => s.id !== id));
      setDeleteConfirm(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleAdd = async () => {
    setAddError(null);
    if (!addForm.id || !addForm.command) {
      setAddError("ID and command are required");
      return;
    }
    try {
      await request("/api/v1/cc-switch/mcp", {
        method: "POST",
        body: JSON.stringify({
          id: addForm.id,
          name: addForm.name || addForm.id,
          command: addForm.command,
          args: addForm.args ? addForm.args.split(/\s+/) : [],
          description: addForm.description,
          apps: { claude: true },
        }),
      });
      setAddOpen(false);
      setAddForm({ id: "", name: "", command: "", args: "", description: "" });
      fetchServers();
    } catch (e: any) {
      setAddError(e.message);
    }
  };

  if (!available) {
    return (
      <Layout title="MCP Servers" subtitle="CONFIGURATION">
        <Card className="flex h-64 items-center justify-center">
          <div className="text-center text-sm text-muted-foreground">
            <AlertCircle className="mx-auto mb-2 h-5 w-5" />
            cc-switch is not installed. MCP management unavailable.
          </div>
        </Card>
      </Layout>
    );
  }

  return (
    <Layout title="MCP Servers" subtitle="CC-SWITCH">
      <div className="flex flex-col gap-3 h-[calc(100vh-8rem)]">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">{servers.length} MCP Servers</span>
            <Badge variant="secondary" className="text-[9px]">cc-switch</Badge>
          </div>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={fetchServers} className="h-7 text-xs">
              <RefreshCw className="mr-1 h-3 w-3" /> Refresh
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-xs">
              <Plus className="mr-1 h-3 w-3" /> Add Server
            </Button>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </div>
        )}

        {loading ? (
          <Card className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </Card>
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-2">
              {servers.map(server => (
                <Card key={server.id} className="transition-colors hover:bg-accent/10">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Server className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="font-mono text-sm font-medium">{server.name}</span>
                        {server.description && (
                          <span className="text-xs text-muted-foreground">{server.description}</span>
                        )}
                      </div>
                      <Button
                        variant="ghost" size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteConfirm(server.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>

                    <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                      <span className="text-foreground/80">{server.command}</span>
                      {server.args?.length > 0 && <span> {server.args.join(" ")}</span>}
                    </div>

                    {server.env && Object.keys(server.env).length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {Object.keys(server.env).map(k => (
                          <Badge key={k} variant="outline" className="text-[9px] font-mono">{k}</Badge>
                        ))}
                      </div>
                    )}

                    {/* Per-app toggles */}
                    <div className="mt-2 flex items-center gap-3 border-t border-border/50 pt-2">
                      {Object.entries(APP_LABELS).map(([app, label]) => (
                        <button
                          key={app}
                          onClick={() => handleToggle(server.id, app, server.apps[app])}
                          className="flex items-center gap-1 text-xs transition-colors"
                        >
                          {server.apps[app] ? (
                            <ToggleRight className="h-4 w-4 text-primary" />
                          ) : (
                            <ToggleLeft className="h-4 w-4 text-muted-foreground/40" />
                          )}
                          <span className={server.apps[app] ? "text-foreground" : "text-muted-foreground/50"}>
                            {label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* Add Server Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add MCP Server</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <input
              value={addForm.id} onChange={e => setAddForm(f => ({ ...f, id: e.target.value }))}
              placeholder="Server ID (e.g. my-server)" className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm outline-none focus:border-input"
            />
            <input
              value={addForm.command} onChange={e => setAddForm(f => ({ ...f, command: e.target.value }))}
              placeholder="Command (e.g. npx)" className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm outline-none focus:border-input"
            />
            <input
              value={addForm.args} onChange={e => setAddForm(f => ({ ...f, args: e.target.value }))}
              placeholder="Args (space-separated)" className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm outline-none focus:border-input"
            />
            <input
              value={addForm.description} onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
              placeholder="Description (optional)" className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none focus:border-input"
            />
          </div>
          {addError && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3 w-3" /> {addError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAdd}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Delete MCP Server</DialogTitle></DialogHeader>
          <div className="text-sm text-muted-foreground">
            Remove <span className="font-mono font-medium text-foreground">{deleteConfirm}</span>?
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
