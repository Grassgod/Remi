import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { KanbanSquare, List, Plus } from "lucide-react";
import * as api from "../api/client";
import type { MissionItem, Project } from "../api/types";
import { MissionListView } from "../components/missions/MissionListView";
import { MissionKanbanView } from "../components/missions/MissionKanbanView";
import { BoardLayout } from "./BoardLayout";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Button } from "../components/ui/button";

type ViewMode = "list" | "kanban";

export function BoardPage() {
  const [, params] = useRoute("/board/:slug");
  const [, navigate] = useLocation();
  const slug = params?.slug ?? "";

  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("kanban");
  const [project, setProject] = useState<Project | null>(null);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    api.getMissions(slug).then(setMissions).catch(() => {}).finally(() => setLoading(false));
    // Fetch project info to get chatId
    api.getProjects().then(list => {
      const found = list.find(p => p.id === slug);
      setProject(found ?? null);
    }).catch(() => {});
  }, [slug]);

  // Poll for updates
  useEffect(() => {
    if (!slug) return;
    const interval = setInterval(() => {
      api.getMissions(slug).then(setMissions).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [slug]);

  const handleMissionClick = (mission: MissionItem) => {
    navigate(`/board/${slug}/issue/${mission.id}`);
  };

  const handleCreate = async () => {
    if (!newTitle || !project?.chatId) return;
    setCreating(true);
    try {
      await api.createMission({
        title: newTitle,
        projectId: slug,
        chatId: project.chatId,
        description: newDesc || undefined,
      });
      setShowCreate(false);
      setNewTitle("");
      setNewDesc("");
      api.getMissions(slug).then(setMissions).catch(() => {});
    } catch {}
    setCreating(false);
  };

  return (
    <BoardLayout title={slug} subtitle={`${missions.length} missions`}>
      {/* View toggle + New Mission */}
      <div className="mb-5 flex items-center gap-3">
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

        <button
          onClick={() => setShowCreate(true)}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-[12px] text-foreground transition-all hover:border-primary/50 hover:bg-accent/30"
        >
          <Plus className="h-3.5 w-3.5" />
          New Mission
        </button>
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-muted-foreground animate-pulse">
          Loading...
        </div>
      ) : view === "list" ? (
        <MissionListView missions={missions} onMissionClick={handleMissionClick} />
      ) : (
        <MissionKanbanView missions={missions} onMissionClick={handleMissionClick} onStatusChange={() => api.getMissions(slug).then(setMissions).catch(() => {})} />
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
                Project
              </label>
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground">
                {slug}
              </div>
              {project && !project.chatId && (
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
              disabled={!newTitle || !project?.chatId || creating}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BoardLayout>
  );
}
