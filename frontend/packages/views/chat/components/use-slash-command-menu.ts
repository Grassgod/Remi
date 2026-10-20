"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { chatSlashCommandsOptions } from "@multiremi/core/chat/queries";
import { buildSlashMenu, type SlashMenuModel } from "@multiremi/core/chat/slash-menu";
import type { Agent } from "@multiremi/core/types";

const PENDING_MENU: SlashMenuModel = { status: "loading", catalogue: null, provider: null, items: [] };

/**
 * The composer's `/` menu for the chat's own agent: a started chat's agent,
 * the selected one for a new chat (ADR 0025). The agent's commands are read
 * the first time the menu opens in this chat, not on every chat switch; a
 * finished turn refreshes them (realtime `chat:done`).
 *
 * `menu` is null when there is no agent; while a started chat's agent is not
 * known yet it is a loading menu, so it never shows another agent's commands.
 */
export function useSlashCommandMenu({
  wsId,
  agent,
  agentPending = false,
  sessionId,
  enabled,
}: {
  wsId: string;
  agent: Pick<Agent, "id" | "provider" | "skills"> | null;
  agentPending?: boolean;
  sessionId: string | null;
  enabled: boolean;
}): { menu: SlashMenuModel | null; onOpen: () => void } {
  const key = agent ? `${agent.id}:${sessionId ?? ""}` : null;
  const keyRef = useRef(key);
  keyRef.current = key;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const onOpen = useCallback(() => {
    if (keyRef.current) setOpenedFor(keyRef.current);
  }, []);
  const query = useQuery(chatSlashCommandsOptions(wsId, agent?.id ?? null, sessionId, {
    enabled: enabled && key !== null && openedFor === key,
  }));
  const status = query.data ? "ready" : query.isError ? "error" : "loading";
  const menu = useMemo(() => {
    if (!agent) return agentPending ? PENDING_MENU : null;
    return buildSlashMenu({
      provider: agent.provider ?? null,
      status,
      response: query.data ?? null,
      skills: agent.skills ?? [],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id, agent?.provider, agent?.skills, agentPending, status, query.data]);
  return { menu, onOpen };
}
