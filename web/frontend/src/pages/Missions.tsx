import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { KanbanSquare, Clock, MessageSquare, GitPullRequest, ChevronRight, User } from "lucide-react";
import { cn } from "@/lib/utils";
import * as api from "../api/client";
import type { MissionItem } from "../api/types";

const STATUS_COLUMNS = [
  { key: "inbox", label: "Inbox", color: "text-muted-foreground" },
  { key: "in_progress", label: "In Progress", color: "text-chart-1" },
  { key: "in_review", label: "In Review", color: "text-chart-4" },
  { key: "done", label: "Done", color: "text-success" },
] as const;

const STEP_LABELS: Record<string, string> = {
  intake: "Intake",
  rfc: "RFC",
  decompose: "Decompose",
  execute: "Execute",
  eval: "Eval",
  summary: "Summary",
};

export function Missions() {
  const [missions, setMissions] = useState<MissionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchMissions(); }, []);

  const fetchMissions = async () => {
    setLoading(true);
    try {
      const data = await api.getMissions();
      setMissions(data);
    } catch {}
    setLoading(false);
  };

  const handleMove = async (id: string, newStatus: string) => {
    // Optimistic update
    setMissions(prev => prev.map(m => m.id === id ? { ...m, status: newStatus } : m));
    try {
      await api.updateMission(id, { status: newStatus });
    } catch {
      fetchMissions(); // revert on failure
    }
  };

  const grouped = STATUS_COLUMNS.map(col => ({
    ...col,
    items: missions.filter(m => m.status === col.key),
  }));

  // Also gather items in other statuses (approved, rejected, blocked)
  const otherStatuses = missions.filter(m => !STATUS_COLUMNS.some(c => c.key === m.status));

  return (
    <Layout title="Missions" subtitle="Project Board">
      {/* Summary cards */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {grouped.map(col => (
          <Card key={col.key} className="transition-colors hover:bg-accent/30">
            <CardContent className="p-3">
              <div className={cn("text-[10px] font-medium uppercase tracking-wider", col.color)}>{col.label}</div>
              <div className="mt-1 text-2xl font-bold">{col.items.length}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Kanban Board */}
      {loading ? (
        <div className="p-10 text-center text-xs text-muted-foreground">Loading...</div>
      ) : missions.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center">
            <KanbanSquare className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <div className="text-sm text-muted-foreground">No missions yet</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Create missions from Feishu conversations to track them here.
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          {grouped.map(col => (
            <Card key={col.key}>
              <CardHeader className="pb-2">
                <CardTitle className={cn("flex items-center justify-between text-sm", col.color)}>
                  <span>{col.label}</span>
                  <Badge variant="secondary" className="text-[10px]">{col.items.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2">
                <ScrollArea className="max-h-[500px]">
                  {col.items.length === 0 ? (
                    <div className="p-4 text-center text-[10px] text-muted-foreground">Empty</div>
                  ) : (
                    col.items.map(mission => (
                      <MissionCard key={mission.id} mission={mission} />
                    ))
                  )}
                </ScrollArea>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Other statuses */}
      {otherStatuses.length > 0 && (
        <Card className="mt-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Other ({otherStatuses.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-2">
            {otherStatuses.map(m => <MissionCard key={m.id} mission={m} />)}
          </CardContent>
        </Card>
      )}
    </Layout>
  );
}

function MissionCard({ mission }: { mission: MissionItem }) {
  return (
    <div className="mb-2 rounded-md border border-border bg-card p-3 transition-colors hover:bg-accent/30">
      <div className="line-clamp-2 text-sm font-medium">{mission.title}</div>
      {mission.description && (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{mission.description}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="text-[8px]">{STEP_LABELS[mission.currentStep] ?? mission.currentStep}</Badge>
        {mission.mrUrl && (
          <Badge variant="secondary" className="text-[8px]">
            <GitPullRequest className="mr-0.5 h-2.5 w-2.5" />
            {mission.mrStatus ?? "MR"}
          </Badge>
        )}
        {mission.createdByName && (
          <span className="flex items-center gap-0.5 text-[9px] text-muted-foreground">
            <User className="h-2.5 w-2.5" /> {mission.createdByName}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[9px] text-muted-foreground">
        {mission.totalTokens > 0 && <span>{formatNum(mission.totalTokens)} tok</span>}
        {mission.totalCost > 0 && <span>${mission.totalCost.toFixed(2)}</span>}
        <span className="ml-auto flex items-center gap-0.5">
          <Clock className="h-2.5 w-2.5" /> {formatRelative(mission.updatedAt)}
        </span>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatNum(n: number): string {
  if (n > 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n > 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}
