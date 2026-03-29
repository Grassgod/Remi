import { useLocation } from "wouter";
import { GitPullRequest, User, Clock } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import type { MissionItem } from "../../api/types";
import {
  KANBAN_COLUMNS,
  STEP_LABELS,
  getStatusConfig,
  formatRelative,
  formatNum,
} from "./mission-constants";

interface MissionKanbanViewProps {
  missions: MissionItem[];
  onMissionClick?: (mission: MissionItem) => void;
}

export function MissionKanbanView({ missions, onMissionClick }: MissionKanbanViewProps) {
  const [, navigate] = useLocation();

  const columns = KANBAN_COLUMNS.map(key => {
    const cfg = getStatusConfig(key);
    return {
      ...cfg,
      items: missions.filter(m => m.status === key),
    };
  });

  const otherItems = missions.filter(
    m => !KANBAN_COLUMNS.includes(m.status as any)
  );

  return (
    <div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        {columns.map(col => (
          <div key={col.key} className="rounded-lg border border-border bg-card">
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
              <span
                className="h-[7px] w-[7px] rounded-full"
                style={{ background: col.color }}
              />
              <span className="text-[12px] font-medium" style={{ color: col.color }}>
                {col.label}
              </span>
              <span className="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {col.items.length}
              </span>
            </div>

            <ScrollArea className="max-h-[500px]">
              <div className="space-y-1.5 p-2">
                {col.items.length === 0 ? (
                  <div className="py-8 text-center text-[10px] text-muted-foreground">Empty</div>
                ) : (
                  col.items.map(mission => (
                    <div
                      key={mission.id}
                      onClick={() => onMissionClick ? onMissionClick(mission) : navigate(`/missions/${mission.id}`)}
                      className="cursor-pointer rounded-md border border-border bg-card p-3 transition-all hover:border-primary/30 hover:bg-accent/30"
                    >
                      <div className="line-clamp-2 text-[13px] font-medium text-foreground">
                        {mission.title}
                      </div>
                      {mission.description && (
                        <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                          {mission.description}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground border border-border/50">
                          {STEP_LABELS[mission.currentStep] ?? mission.currentStep}
                        </span>
                        {mission.mrUrl && (
                          <span
                            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9px] font-medium"
                            style={{
                              background: mission.mrStatus === "merged" ? "#052e16" : "#422006",
                              color: mission.mrStatus === "merged" ? "#4ade80" : "#fbbf24",
                            }}
                          >
                            <GitPullRequest className="h-2.5 w-2.5" />
                            {mission.mrStatus ?? "MR"}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center gap-2 text-[9px] text-muted-foreground">
                        {mission.createdByName && (
                          <span className="flex items-center gap-0.5">
                            <User className="h-2.5 w-2.5" /> {mission.createdByName}
                          </span>
                        )}
                        {mission.totalTokens > 0 && (
                          <span>{formatNum(mission.totalTokens)} tok</span>
                        )}
                        {mission.totalCost > 0 && (
                          <span>${mission.totalCost.toFixed(2)}</span>
                        )}
                        <span className="ml-auto flex items-center gap-0.5">
                          <Clock className="h-2.5 w-2.5" />
                          {formatRelative(mission.updatedAt)}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          </div>
        ))}
      </div>

      {otherItems.length > 0 && (
        <div className="mt-3 rounded-lg border border-border bg-card p-3">
          <div className="mb-2 text-[12px] font-medium text-muted-foreground">
            Other ({otherItems.length})
          </div>
          <div className="space-y-1.5">
            {otherItems.map(mission => (
              <div
                key={mission.id}
                onClick={() => onMissionClick ? onMissionClick(mission) : navigate(`/missions/${mission.id}`)}
                className="flex cursor-pointer items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 transition-all hover:border-primary/30 hover:bg-accent/30"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: getStatusConfig(mission.status).color }}
                />
                <span className="flex-1 text-[13px] font-medium text-foreground">{mission.title}</span>
                <span
                  className="rounded px-2 py-0.5 text-[9px] font-medium"
                  style={{
                    background: getStatusConfig(mission.status).bgColor,
                    color: getStatusConfig(mission.status).textColor,
                  }}
                >
                  {getStatusConfig(mission.status).label}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
