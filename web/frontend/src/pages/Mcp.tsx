import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import {
  Server, RefreshCw, Code2, LayoutList, Plus, Trash2,
  FolderOpen, Globe, AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useMcpStore } from "../stores/mcp";

export function Mcp() {
  const {
    scopes, selectedScope, detail, loading, error,
    fetchScopes, selectScope, writeScope, deleteServer, mergeServers,
  } = useMcpStore();

  const [viewMode, setViewMode] = useState<"cards" | "json">("cards");
  const [jsonText, setJsonText] = useState("");
  const [jsonDirty, setJsonDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => { fetchScopes(); }, []);

  // Sync JSON text when detail loads or scope changes
  useEffect(() => {
    if (detail?.raw) {
      try {
        setJsonText(JSON.stringify(JSON.parse(detail.raw), null, 2));
      } catch {
        setJsonText(detail.raw);
      }
      setJsonDirty(false);
    }
  }, [detail?.raw]);

  const currentScope = scopes.find(s => s.id === selectedScope);

  const handleSaveJson = async () => {
    setSaving(true);
    try {
      await writeScope(jsonText);
      setJsonDirty(false);
      setViewMode("cards");
    } catch {}
    setSaving(false);
  };

  const handleDelete = async (name: string) => {
    await deleteServer(name);
    setDeleteConfirm(null);
  };

  const handlePaste = async () => {
    setPasteError(null);
    try {
      await mergeServers(pasteText);
      setPasteOpen(false);
      setPasteText("");
    } catch (e: any) {
      setPasteError(e.message ?? "Failed to merge");
    }
  };

  return (
    <Layout title="MCP Servers" subtitle="CONFIGURATION">
      <div className="grid h-[calc(100vh-8rem)] grid-cols-[220px_1fr] gap-4">
        {/* Left Panel — Scope List */}
        <Card className="flex flex-col overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Scopes
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={fetchScopes} className="h-6 w-6 p-0 text-muted-foreground">
              <RefreshCw className="h-3 w-3" />
            </Button>
          </CardHeader>
          <CardContent className="flex-1 overflow-hidden p-0">
            <ScrollArea className="h-full px-2 pb-2">
              {scopes.map(scope => (
                <div
                  key={scope.id}
                  onClick={() => selectScope(scope.id)}
                  className={cn(
                    "relative cursor-pointer rounded-md px-3 py-2.5 text-sm transition-colors",
                    scope.id === selectedScope
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  {scope.id === selectedScope && (
                    <div className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-primary" />
                  )}
                  <div className="flex items-center gap-2">
                    {scope.id === "__global__"
                      ? <Globe className="h-3.5 w-3.5 opacity-60" />
                      : <FolderOpen className="h-3.5 w-3.5 opacity-60" />
                    }
                    <span className="truncate font-medium">{scope.label}</span>
                    {scope.serverCount > 0 && (
                      <Badge variant="secondary" className="ml-auto text-[9px]">
                        {scope.serverCount}
                      </Badge>
                    )}
                  </div>
                  {!scope.hasConfig && (
                    <div className="mt-0.5 pl-5.5 text-[10px] text-muted-foreground/60">
                      no config
                    </div>
                  )}
                </div>
              ))}
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Right Panel — Server Detail */}
        <div className="flex flex-col gap-3 overflow-hidden">
          {!selectedScope ? (
            <Card className="flex flex-1 items-center justify-center">
              <div className="text-center text-sm text-muted-foreground">
                Select a scope from the left panel
              </div>
            </Card>
          ) : (
            <>
              {/* Header */}
              <Card>
                <CardContent className="flex items-center justify-between p-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{currentScope?.label}</span>
                      <Badge variant="secondary" className="text-[10px]">
                        {detail?.servers.length ?? 0} servers
                      </Badge>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                      {currentScope?.mcpJsonPath}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      variant={viewMode === "cards" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setViewMode("cards")}
                      className="h-7 text-xs"
                    >
                      <LayoutList className="mr-1 h-3 w-3" /> Cards
                    </Button>
                    <Button
                      variant={viewMode === "json" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setViewMode("json")}
                      className="h-7 text-xs"
                    >
                      <Code2 className="mr-1 h-3 w-3" /> JSON
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Error Banner */}
              {error && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" /> {error}
                </div>
              )}

              {/* Content */}
              {loading ? (
                <Card className="flex flex-1 items-center justify-center">
                  <div className="text-sm text-muted-foreground">Loading...</div>
                </Card>
              ) : viewMode === "cards" ? (
                /* Cards View */
                <ScrollArea className="flex-1">
                  <div className="space-y-2">
                    {detail?.servers.map(server => (
                      <Card key={server.name} className="transition-colors hover:bg-accent/10">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <Server className="h-3.5 w-3.5 text-muted-foreground" />
                              <span className="font-mono text-sm font-medium">{server.name}</span>
                            </div>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => setDeleteConfirm(server.name)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <div className="mt-1.5 font-mono text-xs text-muted-foreground">
                            <span className="text-foreground/80">{server.command}</span>
                            {server.args.length > 0 && (
                              <span> {server.args.join(" ")}</span>
                            )}
                          </div>
                          {server.envKeys.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {server.envKeys.map(k => (
                                <Badge key={k} variant="outline" className="text-[9px] font-mono">
                                  {k}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    ))}

                    {/* Paste Config Button */}
                    <Button
                      variant="outline"
                      className="w-full border-dashed text-xs text-muted-foreground"
                      onClick={() => setPasteOpen(true)}
                    >
                      <Plus className="mr-1.5 h-3.5 w-3.5" /> Paste Config
                    </Button>
                  </div>
                </ScrollArea>
              ) : (
                /* JSON View */
                <Card className="flex flex-1 flex-col overflow-hidden">
                  <CardContent className="flex flex-1 flex-col p-0">
                    <textarea
                      value={jsonText}
                      onChange={e => { setJsonText(e.target.value); setJsonDirty(true); }}
                      className="flex-1 resize-none bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground outline-none"
                      spellCheck={false}
                      placeholder='{ "mcpServers": { } }'
                    />
                    {jsonDirty && (
                      <div className="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (detail?.raw) {
                              try { setJsonText(JSON.stringify(JSON.parse(detail.raw), null, 2)); }
                              catch { setJsonText(detail.raw); }
                            }
                            setJsonDirty(false);
                          }}
                          className="h-7 text-xs"
                        >
                          Discard
                        </Button>
                        <Button
                          size="sm"
                          onClick={handleSaveJson}
                          disabled={saving}
                          className="h-7 text-xs"
                        >
                          {saving ? "Saving..." : "Save"}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>

      {/* Paste Config Dialog */}
      <Dialog open={pasteOpen} onOpenChange={setPasteOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Paste MCP Config</DialogTitle>
          </DialogHeader>
          <textarea
            value={pasteText}
            onChange={e => { setPasteText(e.target.value); setPasteError(null); }}
            className="min-h-[200px] w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-input"
            spellCheck={false}
            placeholder={'{\n  "server-name": {\n    "command": "npx",\n    "args": ["@example/mcp-server"]\n  }\n}'}
          />
          {pasteError && (
            <div className="flex items-center gap-2 text-xs text-destructive">
              <AlertCircle className="h-3 w-3" /> {pasteError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPasteOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handlePaste} disabled={!pasteText.trim()}>
              Add Servers
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete MCP Server</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            Remove <span className="font-mono font-medium text-foreground">{deleteConfirm}</span> from this scope?
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
