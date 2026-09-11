"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  ArrowLeft,
  ExternalLink,
  List,
  Minus,
  Maximize2,
  Minimize2,
  Plus,
} from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@multiremi/ui/components/ui/tooltip";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { useAuthStore } from "@multiremi/core/auth";
import {
  agentListOptions,
  memberListOptions,
} from "@multiremi/core/workspace/queries";
import { canAssignAgent } from "@multiremi/views/issues/components";
import { api } from "@multiremi/core/api";
import {
  useAgentPresenceDetail,
  useWorkspaceAgentAvailability,
} from "@multiremi/core/agents";
import { useFileUpload } from "@multiremi/core/hooks/use-file-upload";
import { OfflineBanner } from "./offline-banner";
import { HumanRequestDock } from "./human-request-dock";
import { NoAgentBanner } from "./no-agent-banner";
import {
  chatSessionsOptions,
  chatMessagesPageOptions,
  pendingChatTaskOptions,
  chatKeys,
} from "@multiremi/core/chat/queries";
import {
  useCreateChatSession,
  useMarkChatSessionRead,
  useUpdateChatSession,
} from "@multiremi/core/chat/mutations";
import {
  reconcileSettledPendingChatTask,
  useChatStore,
  type PendingChatTaskRef,
} from "@multiremi/core/chat";
import { useChatScopeSubscription } from "@multiremi/core/realtime";
import { ChatMessageList, ChatMessageSkeleton } from "./chat-message-list";
import { ChatInput } from "./chat-input";
import { AgentDropdown } from "./agent-dropdown";
import { SessionDropdown } from "./session-dropdown";
import { EmptyState } from "./chat-empty-state";
import { ChatResizeHandles } from "./chat-resize-handles";
import { useChatContextItems } from "./use-chat-context-items";
import { useChatResize } from "./use-chat-resize";
import { createLogger } from "@multiremi/core/logger";
import type {
  Agent,
  ChatMessage,
  ChatMessagesPage,
  ChatPendingTask,
  ChatSession,
} from "@multiremi/core/types";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { getCurrentWsId } from "@multiremi/core/platform";
import { PageHeader } from "../../layout/page-header";
import { ChatQueue } from "./chat-queue";

const uiLogger = createLogger("chat.ui");
const apiLogger = createLogger("chat.api");
const CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX = 1_000_000;

function seedChatMessagesPageCache(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
  messages: ChatMessage[],
) {
  qc.setQueryData<InfiniteData<ChatMessagesPage>>(
    chatKeys.messagesPage(sessionId),
    (old) =>
      old ?? {
        pages: [
          {
            messages,
            limit: 50,
            has_more: false,
            next_cursor: null,
          },
        ],
        pageParams: [null],
      },
  );
}

export function ChatWindow({
  presentation = "window",
  onSessionChange,
}: {
  presentation?: "window" | "page";
  onSessionChange?: (sessionId: string | null, agentId?: string) => void;
}) {
  const isPage = presentation === "page";
  const [showList, setShowList] = useState(false);
  const navigation = useNavigation();
  const workspacePaths = useWorkspacePaths();
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const isOpen = useChatStore((s) => s.isOpen);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const setOpen = useChatStore((s) => s.setOpen);
  const storeSetActiveSession = useChatStore((s) => s.setActiveSession);
  const setActiveSession = useCallback(
    (id: string | null, agentId?: string) => {
      storeSetActiveSession(id);
      onSessionChange?.(id, agentId);
      setShowList(false);
    },
    [storeSetActiveSession, onSessionChange],
  );
  const setSelectedAgentId = useChatStore((s) => s.setSelectedAgentId);
  const user = useAuthStore((s) => s.user);
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: members = [] } = useQuery(memberListOptions(wsId));
  // Single sessions cache — eliminates the separate active/all queries
  // that used to drift during the WS-invalidate window.
  const {
    data: sessions = [],
    isLoading: sessionsLoading,
    isError: sessionsError,
    refetch: refetchSessions,
  } = useQuery(chatSessionsOptions(wsId));
  const {
    data: rawMessagePages,
    isLoading: messagesLoading,
    isError: messagesError,
    refetch: refetchMessages,
    fetchNextPage: fetchOlderMessages,
    hasNextPage: hasOlderMessages,
    isFetchingNextPage: isFetchingOlderMessages,
  } = useInfiniteQuery(chatMessagesPageOptions(activeSessionId ?? ""));
  // When no active session, always show empty — don't use stale cache.
  // Page 0 contains the latest chronological window; later cursor pages are
  // older chronological windows. Reverse pages so older fetched pages render
  // above the initial latest page. The Virtuoso firstItemIndex is client-owned:
  // it starts from a large stable base and only subtracts the count of loaded
  // prepended rows, so concurrent server inserts cannot drift the scroll anchor.
  const messagePages = activeSessionId ? (rawMessagePages?.pages ?? []) : [];
  const messages = [...messagePages].reverse().flatMap((page) => page.messages);
  const olderMessageCount = messagePages
    .slice(1)
    .reduce((sum, page) => sum + page.messages.length, 0);
  const firstItemIndex =
    messages.length > 0
      ? CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX - olderMessageCount
      : 0;
  // Skeleton only shows for an un-cached session fetch. Cached switches
  // return data synchronously — no flash. `enabled: false` (new chat)
  // keeps isLoading false so the starter prompts aren't hidden.
  const showSkeleton = !!activeSessionId && messagesLoading;

  // Server-authoritative pending task. Survives refresh / reopen / session
  // switch because it's keyed on sessionId in the Query cache; WS events
  // (chat:message / chat:done / task:*) keep it invalidated in real time.
  //
  // This is the SOLE source for pendingTaskId — no mirror in the store.
  const { data: pendingTask } = useQuery(
    pendingChatTaskOptions(activeSessionId ?? ""),
  );
  const pendingTaskId = pendingTask?.task_id ?? null;
  useChatScopeSubscription(activeSessionId, !!activeSessionId);

  // Archived sessions remain readable; restore them before sending.
  const currentSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : null;
  const isSessionArchived = currentSession?.status === "archived";

  const qc = useQueryClient();
  const previousPendingTaskRef = useRef<PendingChatTaskRef>({
    sessionId: activeSessionId,
    taskId: pendingTaskId,
  });
  useEffect(() => {
    const current = {
      sessionId: activeSessionId,
      taskId: pendingTaskId,
    };
    reconcileSettledPendingChatTask(
      qc,
      wsId,
      previousPendingTaskRef.current,
      current,
    );
    previousPendingTaskRef.current = current;
  }, [activeSessionId, pendingTaskId, qc, wsId]);

  const createSession = useCreateChatSession();
  const markRead = useMarkChatSessionRead();
  const updateSession = useUpdateChatSession();
  const [actionError, setActionError] = useState(false);

  const currentMember = members.find((m) => m.user_id === user?.id);
  const memberRole = currentMember?.role;
  const availableAgents = agents.filter(
    (a) => !a.archived_at && canAssignAgent(a, user?.id, memberRole),
  );

  // Resolve selected agent: stored preference → first available
  const activeAgent =
    agents.find((a) => a.id === currentSession?.agent_id) ??
    availableAgents.find((a) => a.id === selectedAgentId) ??
    availableAgents[0] ??
    null;

  // Three-state availability — "loading" stays neutral (no banner, no
  // disable) so the input doesn't flash a fake "no agent" state in the
  // few hundred ms before the agent list query resolves. Only `"none"`
  // (server confirmed: zero usable agents) drives the disabled UI.
  const agentAvailability = useWorkspaceAgentAvailability();
  const noAgent =
    agentAvailability === "none" ||
    (!!currentSession &&
      !availableAgents.some((a) => a.id === currentSession.agent_id));

  // Presence drives both the avatar status dot (via ActorAvatar) and the
  // OfflineBanner / TaskStatusPill availability copy. `useAgentPresenceDetail`
  // returns "loading" while queries are still resolving — pass `undefined`
  // downstream so banners and pill copy stay silent during loading rather
  // than flash speculative offline text.
  const presenceDetail = useAgentPresenceDetail(wsId, activeAgent?.id);
  const availability =
    presenceDetail === "loading" ? undefined : presenceDetail.availability;

  // Mount / unmount logging. ChatWindow lives in DashboardLayout, so this
  // fires on layout mount (login / workspace switch / fresh page load).
  useEffect(() => {
    uiLogger.info("ChatWindow mount", {
      isOpen,
      activeSessionId,
      pendingTaskId,
      selectedAgentId,
      wsId,
    });
    return () => {
      uiLogger.info("ChatWindow unmount", {
        activeSessionId,
        pendingTaskId,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  // Open intent is fully driven by `activeSessionId` in storage — no mount
  // restore, no self-heal. Adding either reintroduces a "two signals
  // describing one fact" race (the previous self-heal mis-cleared the
  // freshly-created session because allSessions was still stale during the
  // post-create invalidate-refetch window).

  // WS events are handled globally in useRealtimeSync — the query cache
  // stays current even when this window is closed. See packages/core/realtime/.

  // Auto mark-as-read whenever the user is looking at a session with unread
  // state: window open + a session active + has_unread → PATCH.
  // has_unread comes from the list query; WS handlers invalidate it on
  // chat:done so a reply arriving while the user watches triggers this
  // effect again and is instantly cleared.
  const currentHasUnread =
    sessions.find((s) => s.id === activeSessionId)?.has_unread ?? false;
  useEffect(() => {
    if ((isPage ? showList : !isOpen) || !activeSessionId) return;
    if (!currentHasUnread) return;
    uiLogger.info("auto markRead", { sessionId: activeSessionId });
    markRead.mutate(activeSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRead ref stable
  }, [isOpen, isPage, showList, activeSessionId, currentHasUnread]);

  const { uploadWithToast } = useFileUpload(api);

  // Lazy-creates a chat_session the first time the user needs an id —
  // either to send a message or to attach an uploaded file. Pulled out of
  // handleSend so the upload path (which fires before any text exists) can
  // get a session_id to hang the attachment on. Returns null when no agent
  // is available; callers must early-return in that case.
  //
  // Concurrent callers (e.g. user drops a file → handleUploadFile, then
  // quickly clicks send → handleSend) would each observe activeSessionId
  // === null and fire a separate createSession.mutateAsync, creating two
  // sessions and orphaning the attachment on the wrong one. The in-flight
  // promise ref dedupes those races: the first caller starts the create,
  // every subsequent caller awaits the same promise until it settles.
  //
  // titleSeed is the first 50 chars of the user's message when called from
  // send; the upload path passes "" and we leave the title empty so the
  // session-dropdown's existing localized `window.untitled` fallback kicks
  // in. A follow-up task may back-fill the real title from the first user
  // message — until then this keeps the session list scannable across locales.
  //
  // NOTE: ensureSession does NOT flip `activeSessionId` itself. Callers must
  // seed `chatKeys.messages(sessionId)` in the Query cache BEFORE calling
  // `setActiveSession(sessionId)`, otherwise the first useQuery subscription
  // for the new key reports `isLoading: true` and renders ChatMessageSkeleton
  // for one frame (the "new-chat first-message" white flash).
  const sessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const ensureSession = useCallback(
    async (titleSeed: string): Promise<string | null> => {
      if (activeSessionId) return activeSessionId;
      if (!activeAgent) return null;
      if (sessionPromiseRef.current) return sessionPromiseRef.current;

      const promise = (async () => {
        try {
          const session = await createSession.mutateAsync({
            agent_id: activeAgent.id,
            title: titleSeed.slice(0, 50),
          });
          return session.id;
        } finally {
          sessionPromiseRef.current = null;
        }
      })();
      sessionPromiseRef.current = promise;
      return promise;
    },
    [activeSessionId, activeAgent, createSession],
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      const sessionAtStart = useChatStore.getState().activeSessionId;
      const sessionId = await ensureSession("");
      if (!sessionId || getCurrentWsId() !== wsId) return null;
      // Prime the messages cache as empty before flipping activeSessionId so
      // ChatMessageList mounts directly (no Skeleton frame). Skip the write
      // when an entry already exists — a concurrent handleSend may have
      // seeded an optimistic message we must not clobber.
      seedChatMessagesPageCache(qc, sessionId, []);
      qc.setQueryData<ChatMessage[]>(
        chatKeys.messages(sessionId),
        (old) => old ?? [],
      );
      if (useChatStore.getState().activeSessionId === sessionAtStart)
        setActiveSession(sessionId);
      return uploadWithToast(file, { chatSessionId: sessionId });
    },
    [ensureSession, uploadWithToast, qc, setActiveSession, wsId],
  );

  const handleSend = useCallback(
    async (content: string, attachmentIds?: string[]) => {
      if (!activeAgent) throw new Error("No agent available");
      const sessionAtStart = useChatStore.getState().activeSessionId;
      const sessionId = await ensureSession(content);
      if (!sessionId || getCurrentWsId() !== wsId)
        throw new Error("Chat workspace changed");
      const priorPending = qc.getQueryData<ChatPendingTask>(
        chatKeys.pendingTask(sessionId),
      );
      const isFollowup = !!priorPending?.task_id;
      const sentAt = new Date().toISOString();
      const optimistic: ChatMessage = {
        id: `optimistic-${crypto.randomUUID()}`,
        chat_session_id: sessionId,
        role: "user",
        content,
        task_id: null,
        created_at: sentAt,
      };
      if (!isFollowup) {
        qc.setQueryData<InfiniteData<ChatMessagesPage>>(
          chatKeys.messagesPage(sessionId),
          (old) =>
            old
              ? {
                  ...old,
                  pages: old.pages.map((page, index) =>
                    index === 0
                      ? { ...page, messages: [...page.messages, optimistic] }
                      : page,
                  ),
                }
              : {
                  pages: [
                    {
                      messages: [optimistic],
                      limit: 50,
                      has_more: false,
                      next_cursor: null,
                    },
                  ],
                  pageParams: [null],
                },
        );
        qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), {
          task_id: optimistic.id,
          status: "queued",
          created_at: sentAt,
        });
      }
      if (useChatStore.getState().activeSessionId === sessionAtStart)
        setActiveSession(sessionId, activeAgent.id);
      try {
        const result = await api.sendChatMessage(
          sessionId,
          content,
          attachmentIds,
        );
        if (!result.queued) {
          qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), {
            task_id: result.task_id,
            status: "queued",
            created_at: result.created_at,
            supports_queue: result.supports_queue,
          });
        }
      } catch (error) {
        apiLogger.error("sendChatMessage.error", { sessionId, error });
        throw error;
      } finally {
        // Drop only this send's optimistic row. Concurrent WS messages stay intact.
        qc.setQueryData<InfiniteData<ChatMessagesPage>>(
          chatKeys.messagesPage(sessionId),
          (old) =>
            old && {
              ...old,
              pages: old.pages.map((page) => ({
                ...page,
                messages: page.messages.filter(
                  (message) => message.id !== optimistic.id,
                ),
              })),
            },
        );
        if (
          qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId))
            ?.task_id === optimistic.id
        ) {
          qc.setQueryData(chatKeys.pendingTask(sessionId), priorPending ?? {});
        }
        void qc.invalidateQueries({
          queryKey: chatKeys.pendingTask(sessionId),
        });
        void qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
        void qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
        void qc.invalidateQueries({
          queryKey: chatKeys.messagesPage(sessionId),
        });
        void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
      }
    },
    [activeAgent, ensureSession, qc, setActiveSession, wsId],
  );

  const [stopping, setStopping] = useState(false);
  const handleStop = useCallback(async () => {
    if (
      !pendingTaskId ||
      !activeSessionId ||
      stopping ||
      pendingTaskId.startsWith("optimistic-")
    )
      return;
    setStopping(true);
    setActionError(false);
    try {
      await api.cancelTaskById(pendingTaskId);
    } catch (error) {
      setActionError(true);
      apiLogger.error("cancelTask.error", { taskId: pendingTaskId, error });
    } finally {
      setStopping(false);
      void qc.invalidateQueries({
        queryKey: chatKeys.pendingTask(activeSessionId),
      });
      void qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
      void qc.invalidateQueries({
        queryKey: chatKeys.messagesPage(activeSessionId),
      });
    }
  }, [pendingTaskId, activeSessionId, stopping, qc, wsId]);

  const handleSelectAgent = useCallback(
    (agent: Agent) => {
      // No-op when clicking the already-active agent — don't clobber the
      // current session just because the user closed the menu this way.
      // Compare against activeAgent (what the UI shows), not selectedAgentId
      // (which may be null / point to an archived agent on first load).
      if (activeAgent && agent.id === activeAgent.id) return;
      uiLogger.info("selectAgent", {
        from: selectedAgentId,
        to: agent.id,
        previousSessionId: activeSessionId,
      });
      setSelectedAgentId(agent.id);
      // Reset session when switching agent
      setActiveSession(null, agent.id);
    },
    [
      activeAgent,
      selectedAgentId,
      activeSessionId,
      setSelectedAgentId,
      setActiveSession,
    ],
  );

  const handleNewChat = useCallback(() => {
    uiLogger.info("newChat", {
      previousSessionId: activeSessionId,
      previousPendingTask: pendingTaskId,
    });
    setActiveSession(null);
  }, [activeSessionId, pendingTaskId, setActiveSession]);

  const handleSelectSession = useCallback(
    (session: ChatSession) => {
      // Sessions are bound 1:1 to an agent — picking a session from a
      // different agent implicitly switches the agent too.
      if (activeAgent && session.agent_id !== activeAgent.id) {
        uiLogger.info("selectSession (cross-agent)", {
          from: activeAgent.id,
          toAgent: session.agent_id,
          toSession: session.id,
        });
        setSelectedAgentId(session.agent_id);
      }
      setActiveSession(session.id, session.agent_id);
    },
    [activeAgent, setSelectedAgentId, setActiveSession],
  );

  const handleMinimize = useCallback(() => {
    uiLogger.info("minimize (close)", {
      activeSessionId,
      pendingTaskId,
    });
    setOpen(false);
  }, [activeSessionId, pendingTaskId, setOpen]);

  const isExpanded = useChatStore((s) => s.isExpanded);

  const windowRef = useRef<HTMLDivElement>(null);
  const {
    renderWidth,
    renderHeight,
    isAtMax,
    boundsReady,
    isDragging,
    toggleExpand,
    startDrag,
  } = useChatResize(windowRef);

  // Show the list (vs empty state) as soon as there's anything to display —
  // a real message, or a pending task whose timeline will stream in.
  const hasMessages = messages.length > 0 || !!pendingTaskId;

  const isVisible = isOpen && (isExpanded || boundsReady);

  const containerClass =
    "absolute bottom-2 right-2 z-50 flex flex-col rounded-xl ring-1 ring-foreground/10 bg-sidebar shadow-2xl overflow-hidden";
  const containerStyle: React.CSSProperties = {
    transformOrigin: "bottom right",
    pointerEvents: isOpen ? "auto" : "none",
  };

  const contextItems = useChatContextItems(wsId);

  const conversation = (
    <>
      {/* Header — ⊕ new + session dropdown | window tools */}
      <div className="flex items-center justify-between border-b px-4 py-2.5 gap-2">
        {isPage && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label={t(($) => $.page.history)}
            onClick={() => setShowList(true)}
          >
            <List />
          </Button>
        )}
        <div className="flex items-center gap-1 min-w-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground"
                  onClick={handleNewChat}
                />
              }
            >
              <Plus />
            </TooltipTrigger>
            <TooltipContent side="top">
              {t(($) => $.window.new_chat_tooltip)}
            </TooltipContent>
          </Tooltip>
          <SessionDropdown
            sessions={sessions}
            // Use the full agent list (incl. archived) so historical
            // sessions can still resolve their avatar.
            agents={agents}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onSessionDeleted={() => setActiveSession(null)}
          />
        </div>
        {!isPage && (
          <div className="flex items-center gap-0.5 shrink-0">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(($) => $.page.open)}
              title={t(($) => $.page.open)}
              onClick={() =>
                navigation.push(
                  workspacePaths.chat(activeSessionId ?? undefined),
                )
              }
            >
              <ExternalLink />
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    onClick={toggleExpand}
                  />
                }
              >
                {isExpanded || isAtMax ? <Minimize2 /> : <Maximize2 />}
              </TooltipTrigger>
              <TooltipContent side="top">
                {isExpanded || isAtMax
                  ? t(($) => $.window.restore_tooltip)
                  : t(($) => $.window.expand_tooltip)}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground"
                    onClick={handleMinimize}
                  />
                }
              >
                <Minus />
              </TooltipTrigger>
              <TooltipContent side="top">
                {t(($) => $.window.minimize_tooltip)}
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>

      {/* Messages / skeleton / empty state */}
      {messagesError ? (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-sm text-destructive"
        >
          <p>{t(($) => $.page.load_failed)}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetchMessages()}
          >
            {t(($) => $.page.retry)}
          </Button>
        </div>
      ) : showSkeleton ? (
        <ChatMessageSkeleton />
      ) : hasMessages ? (
        <ChatMessageList
          key={activeSessionId}
          messages={messages}
          pendingTask={pendingTask}
          availability={availability}
          firstItemIndex={firstItemIndex}
          hasOlderMessages={!!hasOlderMessages}
          isFetchingOlderMessages={isFetchingOlderMessages}
          onLoadOlderMessages={() => void fetchOlderMessages()}
        />
      ) : (
        <EmptyState
          hasSessions={sessions.length > 0}
          agentName={activeAgent?.name}
          noAgent={noAgent}
          onPickPrompt={(text) => {
            void handleSend(text).catch(() => setActionError(true));
          }}
        />
      )}

      {/* Status banner above the input — single mutually-exclusive slot.
       *  Priority: no-agent > offline / unstable. Agent presence is the
       *  hard prerequisite (you can't send anything without one), so it
       *  always wins over a presence hint. Recent issue/project navigation
       *  lives in the input action row; it is not message/session state.
       *
       *  We key off `noAgent` (the resolved-empty state) rather than
       *  `!activeAgent`, so the loading window between mount and the
       *  first agent-list response stays banner-free. */}
      <HumanRequestDock taskId={pendingTaskId} />

      {noAgent ? (
        <NoAgentBanner />
      ) : (
        <OfflineBanner
          agentName={activeAgent?.name}
          availability={availability}
        />
      )}

      {/* Input — disabled for legacy archived sessions; locked out entirely
       *  when there's no agent (the EmptyState above carries the CTA). */}
      {activeSessionId && (pendingTask?.queued_tasks?.length ?? 0) > 0 && (
        <ChatQueue
          sessionId={activeSessionId}
          tasks={pendingTask!.queued_tasks!}
        />
      )}
      {actionError && (
        <p role="alert" className="mx-5 mb-2 text-xs text-destructive">
          {t(($) => $.sessions.failed)}
        </p>
      )}
      {isSessionArchived && activeSessionId && (
        <div className="flex items-center justify-between gap-2 px-5 py-2 text-sm text-muted-foreground">
          <span>{t(($) => $.input.placeholder_archived)}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={updateSession.isPending}
            onClick={() =>
              updateSession.mutate(
                { sessionId: activeSessionId, status: "active" },
                { onError: () => setActionError(true) },
              )
            }
          >
            {t(($) => $.sessions.restore)}
          </Button>
        </div>
      )}
      <ChatInput
        onSend={handleSend}
        onUploadFile={handleUploadFile}
        onStop={handleStop}
        isRunning={!!pendingTaskId}
        supportsQueue={pendingTask?.supports_queue}
        disabled={isSessionArchived}
        noAgent={noAgent}
        agentName={activeAgent?.name}
        leftAdornment={
          <AgentDropdown
            agents={availableAgents}
            activeAgent={activeAgent}
            userId={user?.id}
            onSelect={handleSelectAgent}
          />
        }
        contextItems={contextItems}
      />
    </>
  );

  if (isPage)
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader>
          <h1 className="text-sm font-semibold">{t(($) => $.page.title)}</h1>
          <span className="ml-3 truncate text-xs text-muted-foreground">
            {t(($) => $.page.private)}
          </span>
        </PageHeader>
        <div className="flex min-h-0 flex-1">
          <aside
            className={`${showList ? "flex" : "hidden"} w-full min-h-0 shrink-0 flex-col border-r bg-sidebar md:flex md:w-80`}
          >
            <div className="flex items-center justify-between border-b p-3">
              <Button variant="outline" size="sm" onClick={handleNewChat}>
                <Plus className="size-4" />
                {t(($) => $.window.new_chat_tooltip)}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                aria-label={t(($) => $.page.back)}
                onClick={() => setShowList(false)}
              >
                <ArrowLeft />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sessionsLoading ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {t(($) => $.page.loading)}
                </p>
              ) : sessionsError ? (
                <div role="alert" className="p-4 text-sm text-destructive">
                  <p>{t(($) => $.page.load_failed)}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void refetchSessions()}
                  >
                    {t(($) => $.page.retry)}
                  </Button>
                </div>
              ) : (
                <SessionDropdown
                  presentation="list"
                  sessions={sessions}
                  agents={agents}
                  activeSessionId={activeSessionId}
                  onSelectSession={handleSelectSession}
                  onSessionDeleted={() => setActiveSession(null)}
                />
              )}
            </div>
          </aside>
          <main
            className={`${showList ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col md:flex`}
          >
            {conversation}
          </main>
        </div>
      </div>
    );

  return (
    <motion.div
      ref={windowRef}
      className={containerClass}
      style={containerStyle}
      initial={{
        opacity: 0,
        scale: 0.95,
        width: renderWidth,
        height: renderHeight,
      }}
      animate={{
        opacity: isVisible ? 1 : 0,
        scale: isVisible ? 1 : 0.95,
        width: renderWidth,
        height: renderHeight,
      }}
      transition={{
        width: isDragging
          ? { duration: 0 }
          : { type: "spring", duration: 0.3, bounce: 0 },
        height: isDragging
          ? { duration: 0 }
          : { type: "spring", duration: 0.3, bounce: 0 },
        opacity: { duration: 0.15 },
      }}
    >
      <ChatResizeHandles onDragStart={startDrag} />
      {conversation}
    </motion.div>
  );
}
