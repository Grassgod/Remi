"use client";

import { useWorkspacePaths } from "@multiremi/core/paths";
import { useTimeAgo } from "../../../i18n";
import { availabilityConfig } from "../../../agents/presence";
import { AppLink } from "../../../navigation";
import { Plus, Trash2, ArrowUpRight, Crown } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@multiremi/ui/components/ui/tooltip";
import { ActorAvatar } from "../../../common/actor-avatar";
import type { SquadMember, SquadMemberStatus, SquadMemberStatusValue } from "@multiremi/core/types";
import { useT } from "../../../i18n";
import { RoleEditor } from "../role-editor";

// Visual config for the five squad member status buckets. The dot classes
// come straight from availabilityConfig in packages/views/agents/presence.ts
// so a status dot here is the same colour as the agents page's dot by
// construction, not by convention: a squad member that is working is on a
// live runtime, so it reads `online`, and every non-working bucket maps to
// the availability state of the same name.
// Unknown / null statuses (human members, server-side enum drift) render as
// a neutral muted pill; this is the "downgrade, don't crash" defense from
// CLAUDE.md > API Response Compatibility.
const SQUAD_STATUS_DOT_CLASS: Record<SquadMemberStatusValue, string> = {
  working: availabilityConfig.online.dotClass,
  idle: availabilityConfig.offline.dotClass,
  offline: availabilityConfig.offline.dotClass,
  unstable: availabilityConfig.unstable.dotClass,
  archived: availabilityConfig.archived.dotClass,
};

// Members tab body — re-uses the existing list/role editing patterns.
export function SquadMembersTab({
  members,
  memberStatusById,
  isLeader,
  isArchived,
  getEntityName,
  onAddMemberClick,
  onCreateAgentClick,
  onSetLeader,
  onRemoveMember,
  onUpdateRole,
  setLeaderPending,
}: {
  members: SquadMember[];
  memberStatusById: Map<string, SquadMemberStatus>;
  isLeader: (m: SquadMember) => boolean;
  isArchived: (m: SquadMember) => boolean;
  getEntityName: (type: string, id: string) => string;
  onAddMemberClick: () => void;
  // Hidden for non-admins — see SquadOverviewPane.
  onCreateAgentClick?: () => void;
  onSetLeader: (agentId: string) => void;
  onRemoveMember: (m: SquadMember) => void;
  onUpdateRole: (m: SquadMember, role: string) => Promise<void>;
  setLeaderPending: boolean;
}) {
  const { t } = useT("squads");
  const timeAgo = useTimeAgo();
  const p = useWorkspacePaths();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">{t(($) => $.members_tab.section_title)}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t(($) => $.members_tab.section_count, { count: members.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onCreateAgentClick && (
            <Button size="sm" variant="outline" onClick={onCreateAgentClick}>
              <Plus className="size-3.5 mr-1.5" />
              {t(($) => $.members_tab.create_agent_button)}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onAddMemberClick}>
            <Plus className="size-3.5 mr-1.5" />
            {t(($) => $.members_tab.add_member_button)}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {members.map((m) => {
          const status = memberStatusById.get(m.member_id);
          const statusValue = status?.status ?? null;
          const dotClass =
            statusValue && statusValue in SQUAD_STATUS_DOT_CLASS
              ? SQUAD_STATUS_DOT_CLASS[statusValue as keyof typeof SQUAD_STATUS_DOT_CLASS]
              : null;
          const statusLabel =
            statusValue === "working" ? t(($) => $.members_tab.status_working)
              : statusValue === "idle" ? t(($) => $.members_tab.status_idle)
              : statusValue === "offline" ? t(($) => $.members_tab.status_offline)
              : statusValue === "unstable" ? t(($) => $.members_tab.status_unstable)
              : statusValue === "archived" ? t(($) => $.members_tab.status_archived)
              : null;
          const activeIssues = status?.active_issues ?? [];
          const primaryIssue = activeIssues[0];
          const extraIssueCount = Math.max(0, activeIssues.length - 1);
          // Show last_active only when the agent isn't currently working —
          // a "working" pill already implies the agent is live, and a
          // "last active 2s ago" line next to it is just noise.
          const showLastActive =
            m.member_type === "agent" && statusValue && statusValue !== "working" && status?.last_active_at;
          return (
            <div key={m.id} className="group flex items-start gap-3 rounded-lg border p-3">
              <ActorAvatar
                actorType={m.member_type}
                actorId={m.member_id}
                size={32}
                showStatusDot
                enableHoverCard={m.member_type === "agent"}
                hoverCardVariant="live"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{getEntityName(m.member_type, m.member_id)}</span>
                  <span className="text-xs text-muted-foreground capitalize">{m.member_type}</span>
                  {isLeader(m) && (
                    <span className="inline-flex items-center gap-0.5 text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded">
                      <Crown className="size-3" />
                      {t(($) => $.members_tab.leader_chip)}
                    </span>
                  )}
                  {m.member_type === "agent" && statusLabel && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <span className={`h-1.5 w-1.5 rounded-full ${dotClass ?? "bg-muted-foreground/40"}`} />
                      {statusLabel}
                    </span>
                  )}
                </div>
                <RoleEditor
                  value={m.role ?? ""}
                  onSave={async (next) => { await onUpdateRole(m, next); }}
                />
                {primaryIssue && (
                  <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground min-w-0">
                    <AppLink
                      href={p.issueDetail(primaryIssue.issue_id)}
                      className="inline-flex items-center gap-1 min-w-0 hover:text-foreground transition-colors"
                    >
                      <span className="font-mono text-[10px] uppercase shrink-0">{primaryIssue.identifier}</span>
                      <span className="truncate">{primaryIssue.title}</span>
                      {primaryIssue.issue_status === "blocked" && (
                        <span className="shrink-0 inline-flex items-center text-[10px] uppercase tracking-wide text-warning">
                          {t(($) => $.members_tab.issue_status_blocked)}
                        </span>
                      )}
                    </AppLink>
                    {extraIssueCount > 0 && (
                      <span className="shrink-0">
                        · {t(($) => $.members_tab.active_issue_more, { count: extraIssueCount })}
                      </span>
                    )}
                  </div>
                )}
                {showLastActive && (
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t(($) => $.members_tab.last_active_label, {
                      time: timeAgo(status!.last_active_at!),
                    })}
                  </div>
                )}
              </div>
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
              {m.member_type === "agent" && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <AppLink
                        href={p.agentDetail(m.member_id)}
                        className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                        aria-label={t(($) => $.members_tab.view_agent_tooltip)}
                      >
                        <ArrowUpRight className="size-3.5" />
                      </AppLink>
                    }
                  />
                  <TooltipContent>
                    {t(($) => $.members_tab.view_agent_tooltip)}
                  </TooltipContent>
                </Tooltip>
              )}
              {m.member_type === "agent" && !isLeader(m) && !isArchived(m) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-amber-600 h-8 w-8 p-0"
                        onClick={() => onSetLeader(m.member_id)}
                        disabled={setLeaderPending}
                        aria-label={t(($) => $.members_tab.make_leader_tooltip)}
                      >
                        <Crown className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipContent>
                    {t(($) => $.members_tab.make_leader_tooltip)}
                  </TooltipContent>
                </Tooltip>
              )}
              {!isLeader(m) && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive h-8 w-8 p-0"
                        onClick={() => onRemoveMember(m)}
                        aria-label={t(($) => $.members_tab.remove_member_tooltip)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    }
                  />
                  <TooltipContent>
                    {t(($) => $.members_tab.remove_member_tooltip)}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
