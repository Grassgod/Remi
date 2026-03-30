import { useEffect, useState, useCallback } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { ScrollArea } from "../components/ui/scroll-area";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../components/ui/table";
import { InitStepper } from "../components/ui/init-stepper";
import {
  FolderOpen, Plus, Trash2, AlertTriangle, Check, X, Pencil, ChevronRight,
  Folder, CornerLeftUp, Loader2, RotateCcw, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "../api/client";
import type { Project, InitStep, ProjectInitInput } from "../api/types";

// ── Directory Picker Dialog ────────────────────────────

function DirPicker({ open, onClose, onSelect }: {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const [currentPath, setCurrentPath] = useState("");
  const [dirs, setDirs] = useState<{ name: string; path: string }[]>([]);
  const [loading, setLoading] = useState(false);

  const browse = async (path?: string) => {
    setLoading(true);
    try {
      const res = await api.browseDirs(path);
      setCurrentPath(res.path);
      setDirs(res.dirs);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { if (open) browse(currentPath || undefined); }, [open]);

  const parentPath = currentPath.replace(/\/[^/]+$/, "") || "/";

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent onClose={onClose} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-4 w-4" /> Select Directory
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
          <span className="truncate">{currentPath}</span>
        </div>

        <ScrollArea className="h-[300px] rounded-md border border-border">
          {loading ? (
            <div className="p-6 text-center text-xs text-muted-foreground animate-pulse">Loading...</div>
          ) : (
            <div className="divide-y divide-border/50">
              {currentPath !== "/" && (
                <button
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-accent transition-colors"
                  onClick={() => browse(parentPath)}
                >
                  <CornerLeftUp className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground">..</span>
                </button>
              )}
              {dirs.map(d => (
                <button
                  key={d.path}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-accent transition-colors"
                  onClick={() => browse(d.path)}
                >
                  <Folder className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="flex-1 truncate font-medium">{d.name}</span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
                </button>
              ))}
              {dirs.length === 0 && currentPath !== "/" && (
                <div className="p-4 text-center text-[11px] text-muted-foreground">No subdirectories</div>
              )}
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onSelect(currentPath); onClose(); }}>
            <Check className="mr-1 h-3 w-3" /> Select
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Init Dialog (3 phases: form → progress → result) ──

type InitPhase = "form" | "progress" | "result";

function InitDialog({ open, onClose, onDone }: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<InitPhase>("form");

  // Form state
  const [alias, setAlias] = useState("");
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [dirMode, setDirMode] = useState<"clone" | "existing">("existing");
  const [parentDir, setParentDir] = useState("/data00/home/hehuajie/project");
  const [existingPath, setExistingPath] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<"parent" | "existing">("existing");
  const [error, setError] = useState("");

  // Progress state
  const [steps, setSteps] = useState<InitStep[]>([]);
  const [initStatus, setInitStatus] = useState<string>("");
  const [projectId, setProjectId] = useState("");

  const reset = useCallback(() => {
    setPhase("form");
    setAlias(""); setName(""); setRepoUrl("");
    setDirMode("existing"); setExistingPath("");
    setError(""); setSteps([]); setInitStatus(""); setProjectId("");
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // Auto-fill name from alias
  const handleAliasChange = (v: string) => {
    setAlias(v);
    if (!name || name === alias) setName(v);
  };

  // Submit form → start init
  const handleSubmit = async () => {
    if (!alias.trim() || !name.trim()) { setError("Alias and name are required"); return; }
    if (dirMode === "clone" && !repoUrl.trim()) { setError("Repo URL required for clone mode"); return; }
    if (dirMode === "existing" && !existingPath.trim()) { setError("Directory path required"); return; }
    setError("");

    const input: ProjectInitInput = {
      alias: alias.trim(),
      name: name.trim(),
      repoUrl: repoUrl.trim() || undefined,
      dirMode,
      parentDir: dirMode === "clone" ? parentDir : undefined,
      existingPath: dirMode === "existing" ? existingPath.trim() : undefined,
    };

    try {
      const res = await api.initProject(input);
      setProjectId(res.id);
      setPhase("progress");

      // Connect SSE
      const unsub = api.subscribeInitStream(res.id, (event) => {
        if (event.type === "state") {
          setSteps(event.data as InitStep[]);
        } else if (event.type === "step") {
          setSteps(prev => prev.map(s =>
            s.name === event.data.step ? { ...s, ...event.data } : s
          ));
        } else if (event.type === "done") {
          setInitStatus("completed");
          setPhase("result");
          unsub();
        } else if (event.type === "error") {
          setInitStatus("failed");
          setPhase("result");
          unsub();
        }
      });
    } catch (err: any) {
      setError(err.message || "Failed to start init");
    }
  };

  // Retry
  const handleRetry = async () => {
    try {
      setPhase("progress");
      setInitStatus("");
      await api.retryInit(projectId);

      const unsub = api.subscribeInitStream(projectId, (event) => {
        if (event.type === "state") {
          setSteps(event.data as InitStep[]);
        } else if (event.type === "step") {
          setSteps(prev => prev.map(s =>
            s.name === event.data.step ? { ...s, ...event.data } : s
          ));
        } else if (event.type === "done") {
          setInitStatus("completed");
          setPhase("result");
          unsub();
        } else if (event.type === "error") {
          setInitStatus("failed");
          setPhase("result");
          unsub();
        }
      });
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
        <DialogContent onClose={handleClose} className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {phase === "form" && "New Project"}
              {phase === "progress" && `Initializing: ${name}`}
              {phase === "result" && (initStatus === "completed" ? "Project Ready" : "Init Failed")}
            </DialogTitle>
            {phase === "form" && (
              <DialogDescription className="text-xs">
                Create a Feishu group, setup directory, and register project.
              </DialogDescription>
            )}
          </DialogHeader>

          {/* ── Form Phase ── */}
          {phase === "form" && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">Alias *</label>
                <Input
                  placeholder="larkparser-ts"
                  value={alias}
                  onChange={e => handleAliasChange(e.target.value)}
                  className="h-8 text-xs"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">Display Name *</label>
                <Input
                  placeholder="LarkParser TS"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[11px] font-medium text-muted-foreground">Repo URL</label>
                <Input
                  placeholder="https://github.com/..."
                  value={repoUrl}
                  onChange={e => setRepoUrl(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>

              {/* Directory Mode */}
              <div className="space-y-2">
                <label className="text-[11px] font-medium text-muted-foreground">Directory</label>
                <div className="flex gap-2">
                  <Button
                    variant={dirMode === "existing" ? "default" : "outline"}
                    size="sm"
                    className="h-7 text-[11px] flex-1"
                    onClick={() => setDirMode("existing")}
                  >
                    Use existing
                  </Button>
                  <Button
                    variant={dirMode === "clone" ? "default" : "outline"}
                    size="sm"
                    className={cn("h-7 text-[11px] flex-1", !repoUrl && "opacity-50")}
                    onClick={() => repoUrl && setDirMode("clone")}
                    disabled={!repoUrl}
                  >
                    Clone from GitHub
                  </Button>
                </div>

                {dirMode === "existing" && (
                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder="/data00/home/..."
                      value={existingPath}
                      onChange={e => setExistingPath(e.target.value)}
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      variant="outline" size="sm"
                      className="h-8"
                      onClick={() => { setPickerTarget("existing"); setPickerOpen(true); }}
                    >
                      <FolderOpen className="h-3 w-3" />
                    </Button>
                  </div>
                )}

                {dirMode === "clone" && (
                  <div className="flex items-center gap-1.5">
                    <Input
                      placeholder="Parent directory"
                      value={parentDir}
                      onChange={e => setParentDir(e.target.value)}
                      className="h-8 flex-1 text-xs"
                    />
                    <Button
                      variant="outline" size="sm"
                      className="h-8"
                      onClick={() => { setPickerTarget("parent"); setPickerOpen(true); }}
                    >
                      <FolderOpen className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </div>

              {error && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" size="sm" onClick={handleClose}>Cancel</Button>
                <Button size="sm" onClick={handleSubmit}>
                  <Plus className="mr-1 h-3 w-3" /> Create
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* ── Progress Phase ── */}
          {phase === "progress" && (
            <div className="py-2">
              <InitStepper steps={steps} />
            </div>
          )}

          {/* ── Result Phase ── */}
          {phase === "result" && (
            <div className="space-y-4">
              <InitStepper steps={steps} />

              {initStatus === "completed" && (
                <div className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
                  Project "{alias}" is ready!
                </div>
              )}

              {initStatus === "failed" && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  Initialization failed. You can retry from the failed step.
                </div>
              )}

              <DialogFooter>
                {initStatus === "failed" && (
                  <Button variant="outline" size="sm" onClick={handleRetry}>
                    <RotateCcw className="mr-1 h-3 w-3" /> Retry
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => { handleClose(); onDone(); }}
                >
                  Close
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <DirPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => {
          if (pickerTarget === "parent") setParentDir(path);
          else setExistingPath(path);
        }}
      />
    </>
  );
}

// ── Status Badge ──

function InitStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return <Badge variant="success" className="text-[9px]">Ready</Badge>;
    case "running":
      return (
        <Badge variant="warning" className="text-[9px]">
          <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" /> Initializing
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive" className="text-[9px]">Failed</Badge>;
    default:
      return <Badge variant="secondary" className="text-[9px]">{status}</Badge>;
  }
}

// ── Main Page ──

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [initOpen, setInitOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editPath, setEditPath] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Resume dialog for running/failed projects
  const [resumeProject, setResumeProject] = useState<Project | null>(null);

  const fetchProjects = async () => {
    try {
      setProjects(await api.getProjects());
      setError(null);
    } catch {
      setError("Failed to load projects");
    }
  };

  useEffect(() => { fetchProjects(); }, []);

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

  return (
    <Layout title="Projects" subtitle="Workspace Management">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-4 w-4 text-muted-foreground" />
            Projects
            <Badge variant="secondary" className="text-[10px]">{projects.length}</Badge>
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => setInitOpen(true)} className="h-7 text-xs">
            <Plus className="mr-1 h-3 w-3" /> New Project
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <div className="flex items-center justify-between border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="ml-2 opacity-70 hover:opacity-100">
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {projects.length === 0 ? (
            <div className="p-10 text-center text-xs text-muted-foreground">No projects registered</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">Alias</TableHead>
                  <TableHead className="w-[140px]">Name</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="w-[90px]">Status</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p) => (
                  <TableRow
                    key={p.id}
                    className={cn(
                      (p.initStatus === "running" || p.initStatus === "failed") && "cursor-pointer hover:bg-accent/50",
                    )}
                    onClick={() => {
                      if (p.initStatus === "running" || p.initStatus === "failed") {
                        setResumeProject(p);
                      }
                    }}
                  >
                    <TableCell className="font-mono text-xs font-semibold">{p.id}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{p.name}</TableCell>
                    <TableCell>
                      {editing === p.id ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            value={editPath}
                            onChange={e => setEditPath(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") handleEdit(p.id);
                              if (e.key === "Escape") { setEditing(null); setEditPath(""); }
                            }}
                            className="h-7 flex-1 text-xs"
                            autoFocus
                            onClick={e => e.stopPropagation()}
                          />
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7"
                            onClick={(e) => { e.stopPropagation(); setPickerOpen(true); }}
                          >
                            <FolderOpen className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost" size="icon" className="h-7 w-7"
                            onClick={(e) => { e.stopPropagation(); handleEdit(p.id); }}
                          >
                            <Check className="h-3 w-3" />
                          </Button>
                        </div>
                      ) : (
                        <span className="select-all break-all font-mono text-xs text-muted-foreground">
                          {p.cwd || "—"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <InitStatusBadge status={p.initStatus} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-foreground"
                          onClick={() => { setEditing(p.id); setEditPath(p.cwd || ""); }}
                          title="Edit path"
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost" size="icon"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setDeleteTarget(p.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
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
          <div><span className="text-foreground">/project &lt;alias&gt;</span> — switch to project directory</div>
          <div><span className="text-foreground">/project</span> — show current project and list</div>
          <div><span className="text-foreground">/project reset</span> — reset to default directory</div>
        </CardContent>
      </Card>

      {/* Init dialog */}
      <InitDialog
        open={initOpen}
        onClose={() => setInitOpen(false)}
        onDone={fetchProjects}
      />

      {/* Resume dialog for running/failed projects */}
      {resumeProject && (
        <ResumeDialog
          project={resumeProject}
          onClose={() => { setResumeProject(null); fetchProjects(); }}
        />
      )}

      {/* Delete dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent onClose={() => setDeleteTarget(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-warning" /> Delete Project
            </DialogTitle>
            <DialogDescription>
              Delete project "{deleteTarget}"? This removes the registration only, not the actual directory or Feishu group.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Directory picker for edit */}
      <DirPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(path) => setEditPath(path)}
      />
    </Layout>
  );
}

// ── Resume Dialog (for running/failed projects) ──

function ResumeDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const [steps, setSteps] = useState<InitStep[]>(project.initSteps);
  const [status, setStatus] = useState(project.initStatus);

  useEffect(() => {
    if (project.initStatus !== "running") return;

    const unsub = api.subscribeInitStream(project.id, (event) => {
      if (event.type === "state") {
        setSteps(event.data as InitStep[]);
      } else if (event.type === "step") {
        setSteps(prev => prev.map(s =>
          s.name === event.data.step ? { ...s, ...event.data } : s
        ));
      } else if (event.type === "done") {
        setStatus("completed");
        unsub();
      } else if (event.type === "error") {
        setStatus("failed");
        unsub();
      }
    });

    return () => unsub();
  }, [project.id, project.initStatus]);

  const handleRetry = async () => {
    setStatus("running");
    await api.retryInit(project.id);

    const unsub = api.subscribeInitStream(project.id, (event) => {
      if (event.type === "state") {
        setSteps(event.data as InitStep[]);
      } else if (event.type === "step") {
        setSteps(prev => prev.map(s =>
          s.name === event.data.step ? { ...s, ...event.data } : s
        ));
      } else if (event.type === "done") {
        setStatus("completed");
        unsub();
      } else if (event.type === "error") {
        setStatus("failed");
        unsub();
      }
    });
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent onClose={onClose} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {status === "running" && `Initializing: ${project.name}`}
            {status === "completed" && "Project Ready"}
            {status === "failed" && "Init Failed"}
          </DialogTitle>
        </DialogHeader>

        <div className="py-2">
          <InitStepper steps={steps} />
        </div>

        {status === "completed" && (
          <div className="rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-500">
            Project "{project.name}" is ready!
          </div>
        )}

        <DialogFooter>
          {status === "failed" && (
            <Button variant="outline" size="sm" onClick={handleRetry}>
              <RotateCcw className="mr-1 h-3 w-3" /> Retry
            </Button>
          )}
          <Button size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
