"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ActorAvatar as ActorAvatarBase } from "@multiremi/ui/components/common/actor-avatar";
import { useActorName } from "@multiremi/core/workspace/hooks";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { runtimeListOptions } from "@multiremi/core/runtimes/queries";
import { agentListOptions } from "@multiremi/core/workspace/queries";
import { deriveAgentAvailability, resolveAgentRuntimes } from "@multiremi/core/agents";
import type { AgentTask } from "@multiremi/core/types";
import { formatElapsedSince } from "../../common/format";
import { workloadConfig } from "../presence";
import { useT } from "../../i18n";

// Compact `2m 14s` / `45s` / `1h 03m`. Capped at hours — anything over a day
// for a running task is a sign of a stuck runtime, but the hover card is not
// the place to relitigate that; the row reads as `26h 12m` and the user can
// act. Padded because the rows stack into a column.
const HOVER_DURATION = {
  collapseZeroSeconds: false,
  pad: true,
  hours: true,
} as const;

interface AgentActivityHoverContentProps {
  // Active tasks (running / queued / dispatched) to render — caller filters
  // by issue id or by workspace scope. Order is preserved; we render every
  // task as its own row.
  tasks: readonly AgentTask[];
}

/**
 * Shared hover-card body for "what are these agents doing right now?" — used
 * by IssueAgentActivityIndicator (per-issue) and WorkspaceAgentWorkingChip
 * (workspace-wide). One row per task: agent avatar, name, status dot,
 * status label, duration.
 *
 * Status colour follows the workspace's existing composition rule:
 *   - running                       → brand (text-brand)
 *   - queued, runtime online        → muted gray (transient race)
 *   - queued, runtime offline/etc.  → warning amber (genuine stuck)
 * — same rule as agent-presence-indicator.tsx so users see a single,
 * consistent language for "agent is in trouble" vs "just enqueued".
 */
export function AgentActivityHoverContent({
  tasks,
}: AgentActivityHoverContentProps) {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();
  const { getActorName, getActorInitials, getActorAvatarUrl } = useActorName();
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: runtimes = [] } = useQuery(runtimeListOptions(wsId));

  // Tick `now` once per second so the per-task duration label updates
  // live while the hover card is open. setInterval only runs while the
  // hover card is mounted (Base UI portals the content but tears it down
  // on close), so this costs nothing when the card is closed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Build an O(1) lookup so each task row resolves its agent without an
  // N×M scan. Cheap — agents/runtimes count in tens at most.
  const agentById = new Map(agents.map((a) => [a.id, a] as const));

  if (tasks.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-muted-foreground">
        {t(($) => $.agent_activity.hover_header, { count: tasks.length })}
      </div>
      <div className="flex flex-col gap-1.5">
        {tasks.map((task) => {
          const agent = agentById.get(task.agent_id);
          const availability = agent
            ? deriveAgentAvailability(resolveAgentRuntimes(agent, runtimes), now)
            : "offline";
          const isRunning = task.status === "running";
          const isAwaitingHuman = task.status === "awaiting_human";
          // queued/dispatched both read as "queued" in the user-facing
          // copy — `dispatched` is the daemon-acked sub-state of queued
          // and not user-meaningful here.
          const wl = isRunning ? workloadConfig.working : workloadConfig.queued;
          // queued + online → muted gray (transient race, no warning);
          // queued + offline/unstable → keep warning amber from
          // workloadConfig. Mirrors agent-presence-indicator.tsx.
          const dotClass = isRunning
            ? "bg-brand"
            : availability === "online"
              ? "bg-muted-foreground/40"
              : "bg-warning";
          const labelClass = isRunning
            ? wl.textClass
            : availability === "online"
              ? "text-muted-foreground"
              : wl.textClass;
          const startedFrom = isRunning
            ? (task.started_at ?? task.dispatched_at ?? task.created_at)
            : task.created_at;

          return (
            <div
              key={task.id}
              className="flex items-center gap-2 text-xs"
            >
              <ActorAvatarBase
                name={getActorName("agent", task.agent_id)}
                initials={getActorInitials("agent", task.agent_id)}
                avatarUrl={getActorAvatarUrl("agent", task.agent_id)}
                isAgent
                size={18}
              />
              <span className="flex-1 truncate font-medium">
                {getActorName("agent", task.agent_id)}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
                <span className={labelClass}>
                  {isRunning
                    ? t(($) => $.agent_activity.status_running)
                    : isAwaitingHuman
                      ? t(($) => $.agent_activity.status_awaiting_human)
                      : t(($) => $.agent_activity.status_queued)}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatElapsedSince(startedFrom, now, HOVER_DURATION)}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
