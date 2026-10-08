"use client";

import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWorkspaceId } from "../hooks";
import { useAfterFirstScreen } from "../platform/use-after-first-screen";
import { memberListOptions, agentListOptions, squadListOptions } from "./queries";
import { resolvePublicFileUrl } from "./avatar-url";
import { findMemberById } from "./member-lookup";

// Stable fallbacks while a list is disabled or loading. A fresh `[]` per render
// changes every callback below, and consumers that memoize on them (the board's
// column groups feed a setState effect) then re-render without end.
const NO_MEMBERS: never[] = [];
const NO_AGENTS: never[] = [];
const NO_SQUADS: never[] = [];

export function useActorName(
  /**
   * Row labels defer agent/squad lookups. Assignee board columns opt in
   * immediately because their headings depend on those names.
   */
  options: { enabled?: boolean; squadsEnabled?: boolean; agentsEnabled?: boolean } = {},
) {
  const wsId = useWorkspaceId();
  const gateOpen = useAfterFirstScreen();
  const squadsEnabled = options.squadsEnabled ?? gateOpen;
  const enabled = options.enabled ?? true;
  const { data: members = NO_MEMBERS } = useQuery({ ...memberListOptions(wsId), enabled });
  const { data: agents = NO_AGENTS } = useQuery(agentListOptions(wsId, {
    enabled: enabled && (options.agentsEnabled ?? gateOpen),
  }));
  const { data: squads = NO_SQUADS } = useQuery(
    squadListOptions(wsId, { enabled: enabled && squadsEnabled }),
  );

  const getMemberName = useCallback((memberId: string) => {
    const m = findMemberById(members, memberId);
    return m?.name ?? "Unknown";
  }, [members]);

  const getAgentName = useCallback((agentId: string) => {
    const a = agents.find((a) => a.id === agentId);
    return a?.name ?? "Unknown Agent";
  }, [agents]);

  const getSquadName = useCallback((squadId: string) => {
    const s = squads.find((s) => s.id === squadId);
    return s?.name ?? "Unknown Squad";
  }, [squads]);

  const getActorName = useCallback((type: string, id: string) => {
    if (type === "member") return getMemberName(id);
    if (type === "agent") return getAgentName(id);
    if (type === "squad") return getSquadName(id);
    if (type === "system") return "Multiremi";
    return "System";
  }, [getAgentName, getMemberName, getSquadName]);

  const getActorInitials = useCallback((type: string, id: string) => {
    const name = getActorName(type, id);
    return name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }, [getActorName]);

  const getActorAvatarUrl = useCallback((type: string, id: string): string | null => {
    if (type === "member") return resolvePublicFileUrl(findMemberById(members, id)?.avatar_url);
    if (type === "agent") return resolvePublicFileUrl(agents.find((a) => a.id === id)?.avatar_url);
    if (type === "squad") return resolvePublicFileUrl(squads.find((s) => s.id === id)?.avatar_url);
    return null;
  }, [agents, members, squads]);

  return useMemo(
    () => ({
      getMemberName,
      getAgentName,
      getSquadName,
      getActorName,
      getActorInitials,
      getActorAvatarUrl,
    }),
    [
      getActorAvatarUrl,
      getActorInitials,
      getActorName,
      getAgentName,
      getMemberName,
      getSquadName,
    ],
  );
}
