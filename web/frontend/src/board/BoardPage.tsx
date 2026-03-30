import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { KanbanSquare, List } from "lucide-react";
import * as api from "../api/client";
import type { MissionItem } from "../api/types";
import { MissionListView } from "../components/missions/MissionListView";
import { MissionKanbanView } from "../components/missions/MissionKanbanView";
import { BoardLayout } from "./BoardLayout";

type ViewMode = "list" | "kanban";

export function BoardPage() {
  const [, params] = useRoute("/mission/:slug");
  const [, navigate] = useLocation();
  const slug = params?.slug ?? "";

  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("kanban");

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    api.getMissions(slug).then(setMissions).catch(() => {}).finally(() => setLoading(false));
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
    navigate(`/mission/${slug}/issue/${mission.id}`);
  };

  return (
    <BoardLayout title={slug} subtitle={`${missions.length} missions`}>
      {/* View toggle */}
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
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm text-muted-foreground animate-pulse">
          Loading...
        </div>
      ) : view === "list" ? (
        <MissionListView missions={missions} onMissionClick={handleMissionClick} />
      ) : (
        <MissionKanbanView missions={missions} onMissionClick={handleMissionClick} />
      )}
    </BoardLayout>
  );
}
