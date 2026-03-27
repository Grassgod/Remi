// components/missions/MissionListView.tsx
import { useState } from "react";
import { useLocation } from "wouter";
import { GitPullRequest, ChevronRight } from "lucide-react";
import type { MissionItem } from "../../api/types";
import {
  STATUS_ORDER,
  STEP_LABELS,
  formatRelative,
  formatCost,
} from "./mission-constants";

interface MissionListViewProps {
  missions: MissionItem[];
}

export function MissionListView({ missions }: MissionListViewProps) {
  const [, navigate] = useLocation();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const s of STATUS_ORDER) {
      if (s.defaultCollapsed) init[s.key] = true;
    }
    return init;
  });

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const groups = STATUS_ORDER
    .map(cfg => ({
      cfg,
      items: missions.filter(m => m.status === cfg.key),
    }))
    .filter(g => g.items.length > 0);

  return (
    <div className="space-y-5">
      {groups.map(({ cfg, items }) => (
        <div key={cfg.key}>
          <button
            onClick={() => toggleCollapse(cfg.key)}
            className="flex w-full items-center gap-2 px-1 py-1 text-left"
          >
            <span
              className="h-[7px] w-[7px] flex-shrink-0 rounded-full"
              style={{ background: cfg.color }}
            />
            <span
              className="text-[11px] font-medium uppercase tracking-wider"
              style={{ color: cfg.color }}
            >
              {cfg.label}
            </span>
            <span className="text-[10px] text-zinc-600">{items.length}</span>
            <span className="ml-1 flex-1 border-t border-zinc-800" />
            <span className="text-[10px] text-zinc-600">
              {collapsed[cfg.key] ? "▸" : "▾"}
            </span>
          </button>

          {!collapsed[cfg.key] && (
            <div className="mt-1 space-y-1">
              {items.map(mission => (
                <div
                  key={mission.id}
                  onClick={() => navigate(`/missions/${mission.id}`)}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-zinc-800/80 bg-zinc-900/60 px-4 py-3 transition-all hover:border-zinc-700 hover:bg-zinc-800/60"
                  style={{ borderLeftWidth: "3px", borderLeftColor: cfg.color }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-zinc-100">
                      {mission.title}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[10px] text-zinc-500">
                      <span className="text-zinc-400">{mission.projectId}</span>
                      <span>·</span>
                      <span>{STEP_LABELS[mission.currentStep] ?? mission.currentStep}</span>
                      {mission.createdByName && (
                        <>
                          <span>·</span>
                          <span>{mission.createdByName}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {mission.mrUrl && (
                    <span
                      className="flex items-center gap-1 rounded px-2 py-0.5 text-[9px] font-medium"
                      style={{
                        background: mission.mrStatus === "merged" ? "#052e16" : "#422006",
                        color: mission.mrStatus === "merged" ? "#4ade80" : "#fbbf24",
                      }}
                    >
                      <GitPullRequest className="h-2.5 w-2.5" />
                      {mission.mrStatus ?? "PR"}
                    </span>
                  )}

                  {mission.totalCost > 0 && (
                    <span className="text-[11px] tabular-nums text-zinc-500">
                      {formatCost(mission.totalCost)}
                    </span>
                  )}

                  <span className="text-[11px] text-zinc-600">
                    {formatRelative(mission.updatedAt)}
                  </span>

                  <ChevronRight className="h-3.5 w-3.5 text-zinc-700" />
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {groups.length === 0 && (
        <div className="py-20 text-center text-sm text-zinc-500">
          No missions yet
        </div>
      )}
    </div>
  );
}
