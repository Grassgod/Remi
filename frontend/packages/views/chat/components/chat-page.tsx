"use client";

import { useCallback, useEffect, useRef } from "react";
import { useChatStore } from "@multiremi/core/chat";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useNavigation } from "../../navigation";
import { ChatWindow } from "./chat-window";

export function ChatPage() {
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  const querySession = navigation.searchParams.get("session");
  const queryAgent = navigation.searchParams.get("agent");
  const mounted = useRef(false);
  useEffect(() => {
    const state = useChatStore.getState();
    if (querySession) state.setActiveSession(querySession);
    else if (queryAgent || mounted.current) state.setActiveSession(null);
    if (queryAgent) state.setSelectedAgentId(queryAgent);
    mounted.current = true;
  }, [querySession, queryAgent]);
  const onSessionChange = useCallback(
    (sessionId: string | null, agentId?: string) => {
      navigation.replace(
        paths.chat(sessionId ?? undefined, sessionId ? undefined : agentId),
      );
    },
    [navigation, paths],
  );
  return <ChatWindow presentation="page" onSessionChange={onSessionChange} />;
}
