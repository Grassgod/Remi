import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { FolderOpen, Plus, Trash2, AlertTriangle, Check, X } from "lucide-react";
import * as api from "../api/client";
import type { ProjectMap } from "../api/types";

export function Projects() {
  const [projects, setProjects] = useState<ProjectMap>({});
  const [adding, setAdding] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [newPath, setNewPath] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editPath, setEditPath] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = async () => {
    try {
      setProjects(await api.getProjects());
      setError(null);
    } catch {
      setError("Failed to load projects");
    }
  };

  useEffect(() => { fetchProjects(); }, []);

  const entries = Object.entries(projects);

  const handleAdd = async () => {
    if (!newAlias.trim() || !newPath.trim()) return;
    const alias = newAlias.trim();
    if (alias in projects) {
      if (!confirm(`Alias "${alias}" already exists. Overwrite?`)) return;
    }
    try {
      await api.createProject(alias, newPath.trim());
      setNewAlias(""); setNewPath(""); setAdding(false);
      fetchProjects();
    } catch {
      setError(`Failed to create project "${alias}"`);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteProject(deleteTarget);
      setDeleteTarget(null);
      fetchProjects();
    } catch {
      setError(`Failed to delete project "${deleteTarget}"`);
      setDeleteTarget(null);
    }
  };

  const handleEdit = async (alias: string) => {
    if (!editPath.trim()) return;
    try {
      await api.updateProject(alias, editPath.trim());
      setEditing(null); setEditPath("");
      fetchProjects();
    } catch {
      setError(`Failed to update project "${alias}"`);
    }
  };

  const cancelAdd = () => { setAdding(false); setNewAlias(""); setNewPath(""); };

  return (
    <Layout title="Projects" subtitle="Workspace Management">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            Registered Projects
            <Badge variant="secondary" className="text-[10px]">{entries.length}</Badge>
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => setAdding(true)} className="h-7 text-xs">
            <Plus className="mr-1 h-3 w-3" /> Add
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {/* Error banner */}
          {error && (
            <div className="flex items-center justify-between border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 opacity-70 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* Add form */}
          {adding && (
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Input
                placeholder="Alias (e.g. remi)"
                value={newAlias}
                onChange={e => setNewAlias(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") cancelAdd(); }}
                className="h-8 w-[120px] text-xs"
                autoFocus
              />
              <Input
                placeholder="Path (e.g. /data00/home/...)"
                value={newPath}
                onChange={e => setNewPath(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") cancelAdd(); }}
                className="h-8 flex-1 text-xs"
              />
              <Button variant="default" size="sm" onClick={handleAdd} className="h-8 text-xs">
                <Check className="mr-1 h-3 w-3" /> Save
              </Button>
              <Button variant="ghost" size="sm" onClick={cancelAdd} className="h-8 text-xs">
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}

          {entries.length === 0 && !adding ? (
            <div className="p-10 text-center text-xs text-muted-foreground">No projects registered</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[120px]">Alias</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(([alias, path]) => (
                  <TableRow key={alias}>
                    <TableCell className="font-mono text-xs font-semibold">{alias}</TableCell>
                    <TableCell>
                      {editing === alias ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            value={editPath}
                            onChange={e => setEditPath(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleEdit(alias);
                              if (e.key === "Escape") { setEditing(null); setEditPath(""); }
                            }}
                            className="h-7 flex-1 text-xs"
                            autoFocus
                          />
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleEdit(alias)}>
                            <Check className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <span
                          className="cursor-pointer break-all font-mono text-xs text-muted-foreground hover:text-foreground"
                          onClick={() => { setEditing(alias); setEditPath(path); }}
                          title="Click to edit"
                        >{path}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setDeleteTarget(alias)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Usage hint */}
      <Card className="mt-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Usage</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 font-mono text-xs text-muted-foreground">
          <div><span className="text-foreground">/p &lt;alias&gt;</span> — switch to project directory</div>
          <div><span className="text-foreground">/p</span> — show current project and list</div>
          <div><span className="text-foreground">/p reset</span> — reset to default directory</div>
        </CardContent>
      </Card>

      {/* Delete dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent onClose={() => setDeleteTarget(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" /> Delete Project
            </DialogTitle>
            <DialogDescription>
              Delete project "{deleteTarget}"? This only removes the alias, not the actual directory.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
