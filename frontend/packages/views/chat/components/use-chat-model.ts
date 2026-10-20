"use client";

import { useQuery } from "@tanstack/react-query";
import { agentTaskSnapshotOptions } from "@multiremi/core/agents/queries";
import { fleetModelsOptions } from "@multiremi/core/runtimes";
import { useAfterFirstScreen } from "@multiremi/core/platform/use-after-first-screen";
import type { Agent, ChatPendingTask } from "@multiremi/core/types";
import { chatModelDisplay, runningChatTask, type ChatModelDisplay } from "../lib/chat-model";

/**
 * The composer's model chip for the chat's own agent (the session's, or the
 * selected one for a new chat), or null while there is none.
 *
 * Labels come from the workspace model catalog the agent settings read; the
 * chip waits for it so it appears once, with its final text. A fallback switch
 * of the running turn is read from the workspace task snapshot that agent
 * presence already keeps: this reader never fetches it.
 */
export function useChatModel({
  wsId,
  agent,
  sessionId,
  pendingTask,
  enabled,
}: {
  wsId: string;
  agent: Agent | null;
  sessionId: string | null;
  pendingTask: ChatPendingTask | null | undefined;
  enabled: boolean;
}): ChatModelDisplay | null {
  const afterFirstScreen = useAfterFirstScreen();
  const { data: snapshot } = useQuery(agentTaskSnapshotOptions(wsId, { enabled: false }));
  const runningTask = agent ? runningChatTask(snapshot, sessionId, pendingTask) : null;
  const unlabelled = agent ? chatModelDisplay({ agent, runningTask }) : null;
  // Only a model or an effort has a catalog label; the default needs none.
  const needsCatalog = !!unlabelled && (!!unlabelled.modelId || !!unlabelled.effort);
  const catalog = useQuery({
    ...fleetModelsOptions(wsId),
    enabled: enabled && afterFirstScreen && !!wsId && needsCatalog,
  });
  if (!agent || !unlabelled) return null;
  if (!needsCatalog) return unlabelled;
  // Until the catalog answers the chip stays out; a failed read shows raw ids.
  if (catalog.isPending) return null;
  const bucket = catalog.data?.providers.find((entry) => entry.provider === agent.provider);
  return chatModelDisplay({ agent, runningTask, models: bucket?.models, defaultThinking: bucket?.default_thinking });
}
