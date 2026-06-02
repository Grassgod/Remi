import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { KanbanSquare, List } from "lucide-react";
import * as api from "../api/client";
import type { MissionItem, Project } from "../api/types";
import { MissionListView } from "../components/missions/MissionListView";
import { MissionKanbanView } from "../components/missions/MissionKanbanView";
import { BoardLayout } from "./BoardLayout";

type ViewMode = "list" | "kanban";

/**
 * Aggregated board across ALL projects.
 * Reached via /board path on the Board service.
 */
export function AllMissionsBoardPage() {
  const [, navigate] = useLocation();
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("kanban");

  const fetchAll = () => {
    // getMissions() with no projectId returns missions across all projects
    api.getMissions().then(setMissions).catch(() => {});
  };

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getMissions().then(setMissions).catch(() => {}),
      api.getProjects().then(setProjects).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  // Poll for updates
  useEffect(() => {
    const interval = setInterval(fetchAll, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleMissionClick = (mission: MissionItem) => {
    // Jump into the per-project board to view this issue
    const projectId = (mission as unknown as { projectId?: string }).projectId
      ?? (mission as unknown as { project_id?: string }).project_id
      ?? "";
    if (projectId) {
      navigate(`/board/${projectId}/issue/${mission.id}`);
    }
  };

  const subtitle =
    `${missions.length} mission${missions.length === 1 ? "" : "s"}` +
    (projects.length > 0
      ? ` · ${projects.length} project${projects.length === 1 ? "" : "s"}`
      : "");

  return (
    <BoardLayout title="All Boards" subtitle={subtitle}>
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
        {projects.length > 0 && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {projects.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/board/${p.id}`)}
                className="rounded-md border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground"
                title={`Jump into ${p.name}'s board`}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-muted-foreground animate-pulse">
          Loading…
        </div>
      ) : missions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card/30 py-16 text-center">
          <div className="text-sm text-muted-foreground">
            No missions yet across any project.
          </div>
          {projects.length === 0 && (
            <div className="mt-2 text-[12px] text-muted-foreground/70">
              Create a project first, then add missions from its board.
            </div>
          )}
        </div>
      ) : view === "list" ? (
        <MissionListView
          missions={missions}
          onMissionClick={handleMissionClick}
        />
      ) : (
        <MissionKanbanView
          missions={missions}
          onMissionClick={handleMissionClick}
          onStatusChange={fetchAll}
        />
      )}
    </BoardLayout>
  );
}
