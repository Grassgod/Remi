// pages/Missions.tsx
import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { KanbanSquare, List, Plus } from "lucide-react";
import { Select } from "../components/ui/select";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import * as api from "../api/client";
import type { MissionItem, Project } from "../api/types";
import { MissionListView } from "../components/missions/MissionListView";
import { MissionKanbanView } from "../components/missions/MissionKanbanView";

type ViewMode = "list" | "kanban";

export function Missions() {
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("kanban");
  const [projectId, setProjectId] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newProjectId, setNewProjectId] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.getProjects().then(list => {
      const arr = Array.isArray(list) ? list : [];
      setProjects(arr);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetchMissions();
  }, [projectId]);

  const fetchMissions = async () => {
    setLoading(true);
    try {
      const data = await api.getMissions(projectId || undefined);
      setMissions(data);
    } catch {}
    setLoading(false);
  };

  const handleCreate = async () => {
    const proj = projects.find(p => p.id === newProjectId);
    if (!newTitle || !newProjectId || !proj?.chatId) return;
    setCreating(true);
    try {
      await api.createMission({
        title: newTitle,
        projectId: newProjectId,
        chatId: proj.chatId,
        description: newDesc || undefined,
      });
      setShowCreate(false);
      setNewTitle("");
      setNewDesc("");
      setNewProjectId("");
      fetchMissions();
    } catch {}
    setCreating(false);
  };

  return (
    <Layout title="Missions" subtitle="Project Board">
      {/* Toolbar: view toggle + project filter + new mission */}
      <div className="mb-5 flex items-center gap-3 flex-wrap">
        {/* View toggle */}
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          <button
            onClick={() => setView("list")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-all ${
              view === "list"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <List className="h-3.5 w-3.5" />
            List
          </button>
          <button
            onClick={() => setView("kanban")}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-all ${
              view === "kanban"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <KanbanSquare className="h-3.5 w-3.5" />
            Kanban
          </button>
        </div>

        {/* Project filter */}
        {projects.length > 0 && (
          <Select
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
            placeholder="All Projects"
            options={projects.map(p => ({ value: p.id, label: p.name || p.id }))}
            className="h-8 w-[180px] text-[12px]"
          />
        )}

        {/* New Mission */}
        <Button
          size="sm"
          className="ml-auto h-8 gap-1.5 text-[12px]"
          onClick={() => setShowCreate(true)}
        >
          <Plus className="h-3.5 w-3.5" />
          New Mission
        </Button>
      </div>

      {/* Content */}
      {loading ? (
        <div className="py-20 text-center text-sm text-muted-foreground animate-pulse">
          Loading...
        </div>
      ) : view === "list" ? (
        <MissionListView missions={missions} />
      ) : (
        <MissionKanbanView missions={missions} onStatusChange={fetchMissions} />
      )}

      {/* Create Mission Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent onClose={() => setShowCreate(false)}>
          <DialogHeader>
            <DialogTitle>New Mission</DialogTitle>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                Title *
              </label>
              <Input
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                placeholder="Mission title"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                Description
              </label>
              <textarea
                value={newDesc}
                onChange={e => setNewDesc(e.target.value)}
                placeholder="Optional description"
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">
                Project *
              </label>
              <Select
                value={newProjectId}
                onChange={e => setNewProjectId(e.target.value)}
                placeholder="Select project"
                options={projects
                  .filter(p => p.chatId)
                  .map(p => ({ value: p.id, label: p.name || p.id }))}
                className="h-9 w-full text-sm"
              />
              {newProjectId && !projects.find(p => p.id === newProjectId)?.chatId && (
                <p className="mt-1 text-[11px] text-red-400">
                  This project has no linked chat group
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleCreate}
              disabled={!newTitle || !newProjectId || creating}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Layout>
  );
}
