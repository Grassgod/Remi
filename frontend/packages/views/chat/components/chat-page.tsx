"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "@multiremi/core/chat";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { useNavigation } from "../../navigation";
import { ChatWindow } from "./chat-window";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";

export function ChatPage({ initialLog, initialSessionId }: { initialLog?: IssueLogBootstrap; initialSessionId?: string } = {}) {
  const navigation = useNavigation();
  const paths = useWorkspacePaths();
  // The URL names the open chat. The route's props describe the URL the
  // server rendered, which a URL-only replacement leaves behind (and a back
  // navigation restores), so they never pick the chat: they only seed its log
  // until the page replaces its URL, or the server renders another session.
  const querySession = navigation.searchParams.get("session");
  const queryAgent = navigation.searchParams.get("agent");
  const [replacedRoute, setReplacedRoute] = useState<{ sessionId?: string } | null>(null);
  const routeCurrent = !replacedRoute || replacedRoute.sessionId !== initialSessionId;
  const mounted = useRef(false);
  useEffect(() => {
    const state = useChatStore.getState();
    if (querySession) state.setActiveSession(querySession);
    else if (queryAgent || mounted.current) state.setActiveSession(null);
    if (queryAgent) state.setSelectedAgentId(queryAgent);
    mounted.current = true;
  }, [querySession, queryAgent]);
  // The URL names the chat shown, without a history entry or a scroll jump.
  const onSessionChange = useCallback(
    (sessionId: string | null, agentId?: string) => {
      const path = paths.chat(sessionId ?? undefined, sessionId ? undefined : agentId);
      // The window already shows the chosen chat; a route render would only
      // read a log bootstrap the window ignores for a chat it is showing.
      if (navigation.replaceUrl) {
        setReplacedRoute((route) =>
          route && route.sessionId === initialSessionId ? route : { sessionId: initialSessionId });
        navigation.replaceUrl(path);
      } else navigation.replace(path, { scroll: false });
    },
    [navigation, paths, initialSessionId],
  );
  return <ChatWindow presentation="page" onSessionChange={onSessionChange}
    initialLog={routeCurrent ? initialLog : undefined} initialSessionId={querySession ?? undefined} />;
}
