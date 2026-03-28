// pages/Missions.tsx
import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { KanbanSquare, List } from "lucide-react";
import * as api from "../api/client";
import type { MissionItem } from "../api/types";
import { MissionListView } from "../components/missions/MissionListView";
import { MissionKanbanView } from "../components/missions/MissionKanbanView";

type ViewMode = "list" | "kanban";

export function Missions() {
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>("list");

  useEffect(() => {
    fetchMissions();
  }, []);

  const fetchMissions = async () => {
    setLoading(true);
    try {
      const data = await api.getMissions();
      setMissions(data);
    } catch {}
    setLoading(false);
  };

  return (
    <Layout title="Missions" subtitle="Project Board">
      {/* View toggle */}
      <div className="mb-5 flex items-center gap-1 rounded-lg border border-border bg-card p-1 w-fit">
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

      {/* Content */}
      {loading ? (
        <div className="py-20 text-center text-sm text-muted-foreground animate-pulse">
          Loading...
        </div>
      ) : view === "list" ? (
        <MissionListView missions={missions} />
      ) : (
        <MissionKanbanView missions={missions} />
      )}
    </Layout>
  );
}
