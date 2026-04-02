import { useState } from "react";
import { useLocation } from "wouter";
import { GitPullRequest, User, Clock, CheckCircle, XCircle, Send } from "lucide-react";
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

type PendingAction = {
  missionId: string;
  targetStatus: string;
  label: string;
};

const STORAGE_KEY = "remi_approver_email";

export function MissionKanbanView({ missions, onMissionClick, onStatusChange }: MissionKanbanViewProps) {
  const [, navigate] = useLocation();
  const [updating, setUpdating] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [email, setEmail] = useState(() => localStorage.getItem(STORAGE_KEY) ?? "");
  const [reason, setReason] = useState("");

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

  const startAction = (e: React.MouseEvent, missionId: string, targetStatus: string, label: string) => {
    e.stopPropagation();
    setPending({ missionId, targetStatus, label });
    setReason("");
  };

  const cancelAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPending(null);
    setReason("");
  };

  const confirmAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pending || !email.trim()) return;

    localStorage.setItem(STORAGE_KEY, email.trim());
    setUpdating(pending.missionId);

    try {
      const mission = missions.find(m => m.id === pending.missionId);
      const existing = mission?.description ?? "";
      const note = `\n\n---\n**${pending.label}** by ${email.trim()} (${new Date().toLocaleDateString()})${reason.trim() ? `:\n${reason.trim()}` : ""}`;
      await api.updateMission(pending.missionId, {
        status: pending.targetStatus,
        description: (existing + note).trim(),
      });
      setPending(null);
      setReason("");
      onStatusChange?.();
    } catch {}
    setUpdating(null);
  };

  const renderConfirmForm = (missionId: string) => {
    if (pending?.missionId !== missionId) return null;

    const isDestructive = pending.targetStatus === "rejected" || pending.targetStatus === "blocked";
    const isChanges = pending.targetStatus === "in_progress";
    const borderColor = isDestructive ? "border-red-800" : isChanges ? "border-amber-800" : "border-emerald-800";
    const bgColor = isDestructive ? "bg-red-950/50" : isChanges ? "bg-amber-950/50" : "bg-emerald-950/50";
    const textColor = isDestructive ? "text-red-400" : isChanges ? "text-amber-400" : "text-emerald-400";

    return (
      <div className="mt-2 space-y-2 rounded-md border border-border bg-background p-2.5" onClick={e => e.stopPropagation()}>
        <div className="text-[10px] font-medium text-muted-foreground">
          Confirm: {pending.label}
        </div>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="Your email"
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <textarea
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="Reason (optional)"
          rows={2}
          className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          autoFocus
        />
        <div className="flex items-center gap-1.5">
          <button
            disabled={!email.trim() || updating === missionId}
            onClick={confirmAction}
            className={`flex flex-1 items-center justify-center gap-1 rounded-md border ${borderColor} ${bgColor} px-2 py-1 text-[10px] font-medium ${textColor} transition-colors hover:opacity-80 disabled:opacity-50`}
          >
            <Send className="h-3 w-3" />
            Confirm
          </button>
          <button
            onClick={cancelAction}
            className="rounded-md px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    );
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
                    const showActions = isInbox;
                    const hasPending = pending?.missionId === mission.id;

                    return (
                      <div
                        key={mission.id}
                        onClick={() => onMissionClick ? onMissionClick(mission) : navigate(`/missions/${mission.id}`)}
                        className="cursor-pointer rounded-md border border-border bg-card p-3 transition-all hover:border-primary/30 hover:bg-accent/30"
                      >
                        <div className="line-clamp-2 text-[13px] font-medium text-foreground">
                          {mission.title}
                        </div>
                        <span className="text-xs text-zinc-500 font-mono">{mission.id}</span>
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
                        {showActions && !hasPending && (
                          <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/50 pt-2.5">
                            <button
                              disabled={isUpdating}
                              onClick={e => startAction(e, mission.id, "approved", "Approve")}
                              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-emerald-800 bg-emerald-950/50 px-2 py-1 text-[10px] font-medium text-emerald-400 transition-colors hover:bg-emerald-900/50 disabled:opacity-50"
                            >
                              <CheckCircle className="h-3 w-3" />
                              Approve
                            </button>
                            <button
                              disabled={isUpdating}
                              onClick={e => startAction(e, mission.id, "rejected", "Reject")}
                              className="flex flex-1 items-center justify-center gap-1 rounded-md border border-red-800 bg-red-950/50 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-900/50 disabled:opacity-50"
                            >
                              <XCircle className="h-3 w-3" />
                              Reject
                            </button>
                          </div>
                        )}

                        {/* Confirm form */}
                        {renderConfirmForm(mission.id)}
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
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-[13px] font-medium text-foreground">{mission.title}</span>
                  <span className="text-xs text-zinc-500 font-mono">{mission.id}</span>
                </div>
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
