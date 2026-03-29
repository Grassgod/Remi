# MCP Configuration Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independent MCP configuration page with left-right split layout — left panel lists scopes (Global + project directories), right panel shows MCP servers in hybrid mode (cards view + JSON editor toggle + paste-config shortcut).

**Architecture:** New `/mcp` route with dedicated page, Zustand store, backend handler, and `RemiData` methods. Left panel reads scope list from `readProjects()` + global `~/.mcp.json`. Right panel reads/writes `.mcp.json` per scope. Cards mode is default; JSON mode exposes raw file for bulk paste. The existing MCP table in Agents page is removed; agent detail links to the new MCP page instead.

**Tech Stack:** React + Zustand + Tailwind + shadcn/ui (frontend), Hono + RemiData filesystem (backend)

---

### Task 1: Backend — MCP Data Layer in RemiData

**Files:**
- Modify: `web/remi-data.ts` (add new methods near existing `listMcpServers` around line 1658)

- [ ] **Step 1: Add `listMcpScopes` method**

Returns all available scopes (global + registered projects) with their server counts.

```typescript
listMcpScopes(): Array<{
  id: string;
  label: string;
  path: string;
  mcpJsonPath: string;
  serverCount: number;
  hasConfig: boolean;
}> {
  const scopes: Array<{
    id: string; label: string; path: string;
    mcpJsonPath: string; serverCount: number; hasConfig: boolean;
  }> = [];

  // Global scope
  const globalMcpPath = join(homedir(), ".mcp.json");
  const globalExists = existsSync(globalMcpPath);
  let globalCount = 0;
  if (globalExists) {
    try {
      const cfg = JSON.parse(readFileSync(globalMcpPath, "utf-8"));
      globalCount = Object.keys(cfg.mcpServers ?? {}).length;
    } catch {}
  }
  scopes.push({
    id: "__global__",
    label: "Global (~)",
    path: homedir(),
    mcpJsonPath: globalMcpPath,
    serverCount: globalCount,
    hasConfig: globalExists,
  });

  // Project scopes
  const projects = this.readProjects();
  for (const [alias, projPath] of Object.entries(projects)) {
    const mcpJsonPath = join(projPath, ".mcp.json");
    const exists = existsSync(mcpJsonPath);
    let count = 0;
    if (exists) {
      try {
        const cfg = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
        count = Object.keys(cfg.mcpServers ?? {}).length;
      } catch {}
    }
    scopes.push({
      id: alias,
      label: alias,
      path: projPath,
      mcpJsonPath,
      serverCount: count,
      hasConfig: exists,
    });
  }

  return scopes;
}
```

- [ ] **Step 2: Add `getMcpScopeDetail` method**

Returns the full MCP config for a given scope, with env keys listed but values masked.

```typescript
getMcpScopeDetail(scopeId: string): {
  raw: string;
  servers: Array<{
    name: string;
    command: string;
    args: string[];
    envKeys: string[];
  }>;
} | null {
  const scopes = this.listMcpScopes();
  const scope = scopes.find(s => s.id === scopeId);
  if (!scope) return null;

  if (!existsSync(scope.mcpJsonPath)) {
    return { raw: '{\n  "mcpServers": {}\n}', servers: [] };
  }

  const raw = readFileSync(scope.mcpJsonPath, "utf-8");
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { raw, servers: [] }; }

  const servers = Object.entries(parsed.mcpServers ?? {}).map(([name, cfg]: [string, any]) => ({
    name,
    command: cfg.command ?? "",
    args: cfg.args ?? [],
    envKeys: Object.keys(cfg.env ?? {}),
  }));

  return { raw, servers };
}
```

- [ ] **Step 3: Add `writeMcpScope` method**

Writes the full raw JSON content to the scope's `.mcp.json`. Validates JSON and that `mcpServers` key exists.

```typescript
writeMcpScope(scopeId: string, content: string): { ok: boolean; error?: string } {
  const scopes = this.listMcpScopes();
  const scope = scopes.find(s => s.id === scopeId);
  if (!scope) return { ok: false, error: "scope not found" };

  let parsed: any;
  try { parsed = JSON.parse(content); } catch {
    return { ok: false, error: "invalid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "root must be an object" };
  }

  // Auto-wrap if user pastes bare servers (no mcpServers key)
  if (!parsed.mcpServers && !Array.isArray(parsed)) {
    // Check if it looks like server configs (each value has "command")
    const values = Object.values(parsed);
    if (values.length > 0 && values.every((v: any) => v && typeof v.command === "string")) {
      parsed = { mcpServers: parsed };
    }
  }

  if (existsSync(scope.mcpJsonPath)) {
    this._backup(scope.mcpJsonPath);
  }

  writeFileSync(scope.mcpJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  return { ok: true };
}
```

- [ ] **Step 4: Add `deleteMcpServer` method**

Removes a single server entry from a scope's `.mcp.json`.

```typescript
deleteMcpServer(scopeId: string, serverName: string): { ok: boolean; error?: string } {
  const scopes = this.listMcpScopes();
  const scope = scopes.find(s => s.id === scopeId);
  if (!scope) return { ok: false, error: "scope not found" };
  if (!existsSync(scope.mcpJsonPath)) return { ok: false, error: "no config file" };

  let parsed: any;
  try { parsed = JSON.parse(readFileSync(scope.mcpJsonPath, "utf-8")); } catch {
    return { ok: false, error: "invalid JSON in file" };
  }

  if (!parsed.mcpServers?.[serverName]) {
    return { ok: false, error: "server not found" };
  }

  this._backup(scope.mcpJsonPath);
  delete parsed.mcpServers[serverName];
  writeFileSync(scope.mcpJsonPath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
  return { ok: true };
}
```

- [ ] **Step 5: Add `mergeMcpServers` method**

Merges pasted server configs into existing `.mcp.json`. Handles both `{ "name": { command, args } }` and `{ "mcpServers": { ... } }` formats.

```typescript
mergeMcpServers(scopeId: string, input: string): { ok: boolean; added: string[]; error?: string } {
  const scopes = this.listMcpScopes();
  const scope = scopes.find(s => s.id === scopeId);
  if (!scope) return { ok: false, added: [], error: "scope not found" };

  let incoming: any;
  try { incoming = JSON.parse(input); } catch {
    return { ok: false, added: [], error: "invalid JSON" };
  }

  // Normalize: extract mcpServers if wrapped
  const servers: Record<string, any> = incoming.mcpServers ?? incoming;

  // Validate that entries look like server configs
  for (const [, cfg] of Object.entries(servers)) {
    if (!cfg || typeof (cfg as any).command !== "string") {
      return { ok: false, added: [], error: "each server must have a 'command' field" };
    }
  }

  // Load existing
  let existing: any = { mcpServers: {} };
  if (existsSync(scope.mcpJsonPath)) {
    try { existing = JSON.parse(readFileSync(scope.mcpJsonPath, "utf-8")); } catch {}
    if (!existing.mcpServers) existing.mcpServers = {};
    this._backup(scope.mcpJsonPath);
  }

  const added: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    existing.mcpServers[name] = cfg;
    added.push(name);
  }

  writeFileSync(scope.mcpJsonPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  return { ok: true, added };
}
```

- [ ] **Step 6: Commit**

```bash
git add web/remi-data.ts
git commit -m "feat(mcp): add data layer methods for MCP scope management"
```

---

### Task 2: Backend — MCP API Handler

**Files:**
- Create: `web/handlers/mcp.ts`
- Modify: `web/server.ts` (register handler)

- [ ] **Step 1: Create MCP handler file**

```typescript
// web/handlers/mcp.ts
import type { Hono } from "hono";
import type { RemiData } from "../remi-data.js";

export function registerMcpHandlers(app: Hono, data: RemiData) {
  // List all scopes
  app.get("/api/v1/mcp/scopes", (c) => {
    return c.json(data.listMcpScopes());
  });

  // Get scope detail (servers + raw JSON)
  app.get("/api/v1/mcp/scopes/:id", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const detail = data.getMcpScopeDetail(id);
    if (!detail) return c.json({ error: "scope not found" }, 404);
    return c.json(detail);
  });

  // Write full scope config (JSON editor save)
  app.put("/api/v1/mcp/scopes/:id", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { content } = await c.req.json();
    if (typeof content !== "string") return c.json({ error: "content required" }, 400);
    const result = data.writeMcpScope(id, content);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  // Delete a single server
  app.delete("/api/v1/mcp/scopes/:id/servers/:name", (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const name = decodeURIComponent(c.req.param("name"));
    const result = data.deleteMcpServer(id, name);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  // Merge/paste servers into scope
  app.post("/api/v1/mcp/scopes/:id/merge", async (c) => {
    const id = decodeURIComponent(c.req.param("id"));
    const { content } = await c.req.json();
    if (typeof content !== "string") return c.json({ error: "content required" }, 400);
    const result = data.mergeMcpServers(id, content);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true, added: result.added });
  });
}
```

- [ ] **Step 2: Register handler in server.ts**

Add import and registration call alongside existing handlers. Add after `registerAgentsHandlers`:

```typescript
// In imports section (around line 39):
import { registerMcpHandlers } from "./handlers/mcp.js";

// In registration section (around line 89):
registerMcpHandlers(app, data);
```

- [ ] **Step 3: Commit**

```bash
git add web/handlers/mcp.ts web/server.ts
git commit -m "feat(mcp): add REST API endpoints for MCP scope management"
```

---

### Task 3: Frontend — Types + API Client

**Files:**
- Modify: `web/frontend/src/api/types.ts`
- Modify: `web/frontend/src/api/client.ts`

- [ ] **Step 1: Add MCP types**

Add at the end of `types.ts`, after the existing `McpServerInfo`:

```typescript
// MCP Scopes
export interface McpScope {
  id: string;
  label: string;
  path: string;
  mcpJsonPath: string;
  serverCount: number;
  hasConfig: boolean;
}

export interface McpScopeDetail {
  raw: string;
  servers: Array<{
    name: string;
    command: string;
    args: string[];
    envKeys: string[];
  }>;
}
```

- [ ] **Step 2: Add API client functions**

Add at the end of `client.ts`:

```typescript
// MCP
export const getMcpScopes = () =>
  request<import("./types").McpScope[]>("/api/v1/mcp/scopes");

export const getMcpScopeDetail = (id: string) =>
  request<import("./types").McpScopeDetail>(`/api/v1/mcp/scopes/${encodeURIComponent(id)}`);

export const writeMcpScope = (id: string, content: string) =>
  request<{ ok: boolean }>(`/api/v1/mcp/scopes/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });

export const deleteMcpServer = (scopeId: string, serverName: string) =>
  request<{ ok: boolean }>(`/api/v1/mcp/scopes/${encodeURIComponent(scopeId)}/servers/${encodeURIComponent(serverName)}`, {
    method: "DELETE",
  });

export const mergeMcpServers = (scopeId: string, content: string) =>
  request<{ ok: boolean; added: string[] }>(`/api/v1/mcp/scopes/${encodeURIComponent(scopeId)}/merge`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/api/types.ts web/frontend/src/api/client.ts
git commit -m "feat(mcp): add frontend types and API client for MCP scopes"
```

---

### Task 4: Frontend — Zustand Store

**Files:**
- Create: `web/frontend/src/stores/mcp.ts`

- [ ] **Step 1: Create MCP store**

```typescript
import { create } from "zustand";
import * as api from "../api/client";
import type { McpScope, McpScopeDetail } from "../api/types";

interface McpState {
  scopes: McpScope[];
  selectedScope: string | null;
  detail: McpScopeDetail | null;
  loading: boolean;
  error: string | null;

  fetchScopes: () => Promise<void>;
  selectScope: (id: string | null) => Promise<void>;
  writeScope: (content: string) => Promise<void>;
  deleteServer: (serverName: string) => Promise<void>;
  mergeServers: (content: string) => Promise<{ added: string[] }>;
}

export const useMcpStore = create<McpState>((set, get) => ({
  scopes: [],
  selectedScope: null,
  detail: null,
  loading: false,
  error: null,

  fetchScopes: async () => {
    try {
      const scopes = await api.getMcpScopes();
      set({ scopes });
      // Auto-select first scope if none selected
      const { selectedScope } = get();
      if (!selectedScope && scopes.length > 0) {
        get().selectScope(scopes[0].id);
      }
    } catch { /* non-critical */ }
  },

  selectScope: async (id: string | null) => {
    set({ selectedScope: id, detail: null, error: null });
    if (!id) return;
    set({ loading: true });
    try {
      const detail = await api.getMcpScopeDetail(id);
      set({ detail, loading: false });
    } catch (e: any) {
      set({ loading: false, error: e.message ?? "failed to load" });
    }
  },

  writeScope: async (content: string) => {
    const { selectedScope } = get();
    if (!selectedScope) return;
    set({ error: null });
    try {
      await api.writeMcpScope(selectedScope, content);
      // Refresh detail + scope list (server counts may change)
      const [detail, scopes] = await Promise.all([
        api.getMcpScopeDetail(selectedScope),
        api.getMcpScopes(),
      ]);
      set({ detail, scopes });
    } catch (e: any) {
      set({ error: e.message ?? "failed to save" });
      throw e;
    }
  },

  deleteServer: async (serverName: string) => {
    const { selectedScope } = get();
    if (!selectedScope) return;
    set({ error: null });
    try {
      await api.deleteMcpServer(selectedScope, serverName);
      const [detail, scopes] = await Promise.all([
        api.getMcpScopeDetail(selectedScope),
        api.getMcpScopes(),
      ]);
      set({ detail, scopes });
    } catch (e: any) {
      set({ error: e.message ?? "failed to delete" });
    }
  },

  mergeServers: async (content: string) => {
    const { selectedScope } = get();
    if (!selectedScope) throw new Error("no scope selected");
    set({ error: null });
    try {
      const result = await api.mergeMcpServers(selectedScope, content);
      const [detail, scopes] = await Promise.all([
        api.getMcpScopeDetail(selectedScope),
        api.getMcpScopes(),
      ]);
      set({ detail, scopes });
      return { added: result.added };
    } catch (e: any) {
      set({ error: e.message ?? "failed to merge" });
      throw e;
    }
  },
}));
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/stores/mcp.ts
git commit -m "feat(mcp): add Zustand store for MCP scope state management"
```

---

### Task 5: Frontend — MCP Page Component

**Files:**
- Create: `web/frontend/src/pages/Mcp.tsx`

- [ ] **Step 1: Create page with left panel (scope list)**

```tsx
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
      const result = await mergeServers(pasteText);
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
```

- [ ] **Step 2: Commit**

```bash
git add web/frontend/src/pages/Mcp.tsx
git commit -m "feat(mcp): add MCP configuration page with hybrid cards/JSON view"
```

---

### Task 6: Frontend — Routing + Sidebar

**Files:**
- Modify: `web/frontend/src/App.tsx`
- Modify: `web/frontend/src/components/Sidebar.tsx`

- [ ] **Step 1: Add route in App.tsx**

Add import at top:

```typescript
import { Mcp } from "./pages/Mcp";
```

Add route in the "AI Engine" section (after `/skills`):

```tsx
<Route path="/mcp" component={Mcp} />
```

- [ ] **Step 2: Add sidebar nav item in Sidebar.tsx**

Import `Plug` icon from lucide-react (add to the import list):

```typescript
import {
  LayoutDashboard, MessageSquare, KanbanSquare, Brain, BookOpen,
  BarChart3, Activity, FileText, Clock, FolderOpen, Menu, Zap, Bot, Shield, Plug,
} from "lucide-react";
```

Add `MCP` entry in the "AI Engine" group in `navItems`:

```typescript
{ group: "AI Engine", items: [
  { path: "/agents", label: "Agents", icon: Bot },
  { path: "/skills", label: "Skills", icon: Zap },
  { path: "/mcp", label: "MCP", icon: Plug },
]},
```

- [ ] **Step 3: Commit**

```bash
git add web/frontend/src/App.tsx web/frontend/src/components/Sidebar.tsx
git commit -m "feat(mcp): add /mcp route and sidebar navigation entry"
```

---

### Task 7: Cleanup — Remove MCP from Agents Page

**Files:**
- Modify: `web/frontend/src/pages/Agents.tsx`
- Modify: `web/frontend/src/stores/agents.ts`

- [ ] **Step 1: Remove MCP table from Agents list view**

In `Agents.tsx`, remove the MCP Servers card section (the block starting with `{mcpServers.length > 0 && (` and ending with its closing `)}` — approximately lines 92-105). This is the `<Card>` containing `<McpTable>`.

Also remove:
- `fetchMcpServers` from the destructured store calls
- `fetchMcpServers()` from the `useEffect`
- The `McpTable` component definition (the entire `function McpTable` block)
- `Server` from the lucide-react import if no longer used elsewhere (check — it is used in AgentDetailView, so keep it)

- [ ] **Step 2: Remove MCP from agent detail view**

In the `AgentDetailView` component, remove:
- The `mcpServers` prop from the function signature and its type
- The `agentMcpServers` const and the MCP Servers subsection in the card that displays them
- The `mcpServers={mcpServers}` prop passed from the parent in the detail view render

- [ ] **Step 3: Clean up agents store**

In `stores/agents.ts`, remove:
- `mcpServers: McpServerInfo[]` from the state interface
- `fetchMcpServers: () => Promise<void>` from the interface
- `mcpServers: []` from initial state
- The `fetchMcpServers` action implementation
- The `McpServerInfo` import from types if no longer used

- [ ] **Step 4: Remove old `/api/v1/mcp` endpoint from agents handler**

In `web/handlers/agents.ts`, remove the `app.get("/api/v1/mcp", ...)` route (the one that calls `data.listMcpServers()`). The new MCP handler at `/api/v1/mcp/scopes` replaces it.

- [ ] **Step 5: Remove old `getMcpServers` from API client**

In `web/frontend/src/api/client.ts`, remove:

```typescript
export const getMcpServers = () =>
  request<import("./types").McpServerInfo[]>("/api/v1/mcp");
```

Also remove the old `McpServerInfo` type from `types.ts` if no longer referenced. Check first — if `AgentInfo` still references MCP, keep the type.

- [ ] **Step 6: Commit**

```bash
git add web/frontend/src/pages/Agents.tsx web/frontend/src/stores/agents.ts web/handlers/agents.ts web/frontend/src/api/client.ts web/frontend/src/api/types.ts
git commit -m "refactor(agents): remove MCP servers section, now in dedicated /mcp page"
```

---

### Task 8: Verify + Manual Test

- [ ] **Step 1: Build frontend**

```bash
cd web/frontend && bun run build
```

Expected: Build succeeds with no TypeScript errors. If there are unused import warnings, fix them.

- [ ] **Step 2: Start dev server and verify**

```bash
cd /data00/home/hehuajie/project/remi/.claude/worktrees/dashboard-redesign && bun run web/server.ts
```

Manual checks:
1. Navigate to `http://10.37.66.8:5199/#/mcp`
2. Left panel shows "Global (~)" + project scopes
3. Click Global — right panel shows server cards with name, command, args, env keys
4. Toggle to JSON view — raw `.mcp.json` displayed, editable
5. Switch back to Cards, click "Paste Config" — dialog opens, paste test JSON, servers merge
6. Delete a server — confirm dialog, server removed
7. Navigate to `/#/agents` — no MCP Servers section at bottom
8. Sidebar shows MCP entry under "AI Engine" group

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(mcp): address issues found during manual testing"
```
