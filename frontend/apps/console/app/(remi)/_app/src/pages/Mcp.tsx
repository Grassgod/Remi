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
import { PageHeader, EmptyState, SkeletonGrid, staggerStyle } from "../components/configkit";

const INPUT_CLASS = "w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-sm outline-none transition-colors focus:border-input focus:ring-2 focus:ring-ring/20";
const INPUT_MONO = INPUT_CLASS + " font-mono";

/** Compact form-field wrapper with label + helper text, used inside the Add Server dialog. */
function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <div className="flex items-baseline gap-1.5 text-[11px] font-medium text-foreground">
        <span>{label}</span>
        {required && <span className="text-destructive">*</span>}
        {hint && <span className="text-[10px] font-normal text-muted-foreground/80">— {hint}</span>}
      </div>
      {children}
    </label>
  );
}

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

interface McpListResponse {
  servers: McpServer[];
  available: boolean;
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
  const [addForm, setAddForm] = useState({
    id: "",
    name: "",
    transport: "stdio" as "stdio" | "http" | "sse",
    command: "",
    args: "",
    url: "",
    env: "",          // raw "KEY=value" lines
    description: "",
    apps: { claude: true, codex: false, gemini: false },
  });
  const [addError, setAddError] = useState<string | null>(null);

  const fetchServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await request<McpListResponse>("/api/v1/config-hub/mcp");
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
      await request(`/api/v1/config-hub/mcp/${encodeURIComponent(id)}/toggle`, {
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
      await request(`/api/v1/config-hub/mcp/${encodeURIComponent(id)}`, { method: "DELETE" });
      setServers(prev => prev.filter(s => s.id !== id));
      setDeleteConfirm(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const handleAdd = async () => {
    setAddError(null);
    if (!addForm.id) { setAddError("Server ID is required"); return; }
    if (addForm.transport === "stdio" && !addForm.command) {
      setAddError("Command is required for stdio transport"); return;
    }
    if (addForm.transport !== "stdio" && !addForm.url) {
      setAddError(`URL is required for ${addForm.transport} transport`); return;
    }
    // Parse env "KEY=value" per line → object
    const env: Record<string, string> = {};
    for (const line of addForm.env.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) { setAddError(`Bad env line (need KEY=value): ${trimmed}`); return; }
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    try {
      const body: any = {
        id: addForm.id,
        name: addForm.name || addForm.id,
        description: addForm.description,
        apps: addForm.apps,
      };
      if (addForm.transport === "stdio") {
        body.command = addForm.command;
        body.args = addForm.args ? addForm.args.split(/\s+/) : [];
        if (Object.keys(env).length) body.env = env;
      } else {
        // For http/sse transports the backend currently only persists command/args/env;
        // we still send the url + transport so future versions can leverage them.
        body.command = addForm.url; // stored in JSON for now
        body.transport = addForm.transport;
      }
      await request("/api/v1/config-hub/mcp", { method: "POST", body: JSON.stringify(body) });
      setAddOpen(false);
      setAddForm({
        id: "", name: "", transport: "stdio", command: "", args: "", url: "", env: "",
        description: "", apps: { claude: true, codex: false, gemini: false },
      });
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
            config-hub is not available. MCP management unavailable.
          </div>
        </Card>
      </Layout>
    );
  }

  return (
    <Layout title="MCP Servers" subtitle="CONFIG-HUB">
      <div className="flex flex-col gap-3 h-[calc(100vh-8rem)]">
        <PageHeader
          icon={Server}
          title="MCP Servers"
          subtitle="Cross-tool MCP servers — toggle per tool, syncs to native config files on save."
          count={servers.length}
          countLabel="servers"
          actions={
            <>
              <Button variant="outline" size="sm" onClick={fetchServers} className="h-7 text-xs">
                <RefreshCw className="mr-1 h-3 w-3" /> Refresh
              </Button>
              <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-xs">
                <Plus className="mr-1 h-3 w-3" /> Add Server
              </Button>
            </>
          }
        />

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5" /> {error}
          </div>
        )}

        {loading ? (
          <SkeletonGrid count={3} cols="grid-cols-1" />
        ) : servers.length === 0 ? (
          <EmptyState
            icon={Server}
            title="No MCP servers yet"
            description="Add an MCP server to connect tools — toggling it for Claude/Codex/Gemini writes to each tool's native config."
            action={
              <Button size="sm" onClick={() => setAddOpen(true)} className="h-7 text-xs">
                <Plus className="mr-1 h-3 w-3" /> Add Server
              </Button>
            }
          />
        ) : (
          <ScrollArea className="flex-1">
            <div className="space-y-2">
              {servers.map((server, i) => (
                <Card key={server.id} className="transition-all duration-200 hover:-translate-y-0.5 hover:bg-accent/10 hover:shadow-md" style={staggerStyle(i, 60, 40)}>
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
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add MCP Server</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Identity */}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Server ID" required>
                <input
                  value={addForm.id}
                  onChange={(e) => setAddForm(f => ({ ...f, id: e.target.value }))}
                  placeholder="my-server"
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Display name">
                <input
                  value={addForm.name}
                  onChange={(e) => setAddForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="defaults to ID"
                  className={INPUT_CLASS}
                />
              </Field>
            </div>

            {/* Transport */}
            <Field label="Transport" required>
              <div className="flex gap-1.5">
                {(["stdio", "http", "sse"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setAddForm(f => ({ ...f, transport: t }))}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      addForm.transport === t
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </Field>

            {/* stdio: command + args + env  /  http+sse: url */}
            {addForm.transport === "stdio" ? (
              <>
                <Field label="Command" required hint="The executable, e.g. npx, python, node">
                  <input
                    value={addForm.command}
                    onChange={(e) => setAddForm(f => ({ ...f, command: e.target.value }))}
                    placeholder="npx"
                    className={INPUT_MONO}
                  />
                </Field>
                <Field label="Args" hint="Space-separated arguments passed to the command">
                  <input
                    value={addForm.args}
                    onChange={(e) => setAddForm(f => ({ ...f, args: e.target.value }))}
                    placeholder="-y @scope/package@latest"
                    className={INPUT_MONO}
                  />
                </Field>
                <Field label="Env" hint="One KEY=value per line. Available as environment variables to the server.">
                  <textarea
                    value={addForm.env}
                    onChange={(e) => setAddForm(f => ({ ...f, env: e.target.value }))}
                    placeholder={"API_KEY=...\nDEBUG=1"}
                    rows={3}
                    className={INPUT_MONO}
                  />
                </Field>
              </>
            ) : (
              <Field label="URL" required hint={`Endpoint of the ${addForm.transport.toUpperCase()} server`}>
                <input
                  value={addForm.url}
                  onChange={(e) => setAddForm(f => ({ ...f, url: e.target.value }))}
                  placeholder="https://api.example.com/mcp"
                  className={INPUT_MONO}
                />
              </Field>
            )}

            {/* Apps */}
            <Field label="Enable for" hint="Which tools should this server be active in? Toggleable later.">
              <div className="grid grid-cols-3 gap-1.5">
                {(["claude", "codex", "gemini"] as const).map((a) => {
                  const on = addForm.apps[a];
                  return (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAddForm(f => ({ ...f, apps: { ...f.apps, [a]: !on } }))}
                      className={`flex items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                        on
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {on ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                      {APP_LABELS[a]}
                    </button>
                  );
                })}
              </div>
            </Field>

            {/* Description */}
            <Field label="Description">
              <input
                value={addForm.description}
                onChange={(e) => setAddForm(f => ({ ...f, description: e.target.value }))}
                placeholder="What does this server do? (optional)"
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          {addError && (
            <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" /> {addError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAdd}>Add Server</Button>
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
