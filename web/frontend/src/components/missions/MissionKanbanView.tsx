import { useState } from "react";
import { useLocation } from "wouter";
import { GitPullRequest, User, Clock, CheckCircle, XCircle, MessageSquare, Send } from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import type { MissionItem } from "../../api/types";
import * as api from "../../api/client";
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
  onStatusChange?: () => void;
}

export function MissionKanbanView({ missions, onMissionClick, onStatusChange }: MissionKanbanViewProps) {
  const [, navigate] = useLocation();
  const [updating, setUpdating] = useState<string | null>(null);
  // Track which in_review card is showing the feedback form
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const [feedbackText, setFeedbackText] = useState("");

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

  const handleStatusChange = async (e: React.MouseEvent, missionId: string, status: string) => {
    e.stopPropagation();
    setUpdating(missionId);
    try {
      await api.updateMission(missionId, { status });
      onStatusChange?.();
    } catch {}
    setUpdating(null);
  };

  const handleRequestChanges = (e: React.MouseEvent, missionId: string) => {
    e.stopPropagation();
    setFeedbackFor(missionId);
    setFeedbackText("");
  };

  const handleSubmitFeedback = async (e: React.MouseEvent, missionId: string) => {
    e.stopPropagation();
    setUpdating(missionId);
    try {
      // Send back to in_progress with feedback appended to description
      const mission = missions.find(m => m.id === missionId);
      const existing = mission?.description ?? "";
      const feedback = feedbackText.trim();
      const newDesc = feedback
        ? `${existing}\n\n---\n**Review Feedback** (${new Date().toLocaleDateString()}):\n${feedback}`.trim()
        : existing;
      await api.updateMission(missionId, {
        status: "in_progress",
        ...(feedback ? { description: newDesc } : {}),
      });
      setFeedbackFor(null);
      setFeedbackText("");
      onStatusChange?.();
    } catch {}
    setUpdating(null);
  };

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
                  col.items.map(mission => {
                    const isUpdating = updating === mission.id;
                    const isInbox = col.key === "inbox";
                    const isReview = col.key === "in_review";
                    const showActions = isInbox || isReview;
                    const showingFeedback = feedbackFor === mission.id;

                    return (
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

                        {/* Actions */}
                        {showActions && (
                          <div className="mt-2.5 border-t border-border/50 pt-2.5">
                            {/* Feedback form for In Review */}
                            {isReview && showingFeedback ? (
                              <div className="space-y-2" onClick={e => e.stopPropagation()}>
                                <textarea
                                  value={feedbackText}
                                  onChange={e => setFeedbackText(e.target.value)}
                                  placeholder="Describe what needs to change..."
                                  rows={3}
                                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                  autoFocus
                                />
                                <div className="flex items-center gap-1.5">
                                  <button
                                    disabled={isUpdating}
                                    onClick={e => handleSubmitFeedback(e, mission.id)}
                                    className="flex flex-1 items-center justify-center gap-1 rounded-md border border-amber-800 bg-amber-950/50 px-2 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-900/50 disabled:opacity-50"
                                  >
                                    <Send className="h-3 w-3" />
                                    Send Back
                                  </button>
                                  <button
                                    onClick={e => { e.stopPropagation(); setFeedbackFor(null); }}
                                    className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <button
                                  disabled={isUpdating}
                                  onClick={e => handleStatusChange(
                                    e,
                                    mission.id,
                                    isInbox ? "approved" : "done"
                                  )}
                                  className="flex flex-1 items-center justify-center gap-1 rounded-md border border-emerald-800 bg-emerald-950/50 px-2 py-1 text-[10px] font-medium text-emerald-400 transition-colors hover:bg-emerald-900/50 disabled:opacity-50"
                                >
                                  <CheckCircle className="h-3 w-3" />
                                  Approve
                                </button>
                                {isInbox ? (
                                  <button
                                    disabled={isUpdating}
                                    onClick={e => handleStatusChange(e, mission.id, "rejected")}
                                    className="flex flex-1 items-center justify-center gap-1 rounded-md border border-red-800 bg-red-950/50 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-900/50 disabled:opacity-50"
                                  >
                                    <XCircle className="h-3 w-3" />
                                    Reject
                                  </button>
                                ) : (
                                  <button
                                    disabled={isUpdating}
                                    onClick={e => handleRequestChanges(e, mission.id)}
                                    className="flex flex-1 items-center justify-center gap-1 rounded-md border border-amber-800 bg-amber-950/50 px-2 py-1 text-[10px] font-medium text-amber-400 transition-colors hover:bg-amber-900/50 disabled:opacity-50"
                                  >
                                    <MessageSquare className="h-3 w-3" />
                                    Request Changes
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })
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
