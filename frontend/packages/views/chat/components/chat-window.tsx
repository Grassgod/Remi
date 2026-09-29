"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkLocationPicker } from "../../runtimes/components/runtime-workspace-picker";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  ArrowLeft,
  ExternalLink,
  List,
  Minus,
  Maximize2,
  Minimize2,
  Plus,
  LoaderCircle,
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
import { api, toSafeErrorDetails } from "@multiremi/core/api";
import { projectListOptions } from "@multiremi/core/projects/queries";
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
  pendingChatTaskOptions,
  chatKeys,
} from "@multiremi/core/chat/queries";
import { useIssueLog } from "@multiremi/core/session-log/use-issue-log";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
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
import { ChatMessageList } from "./chat-message-list";
import { clientIdOf, type OptimisticChatRow } from "../lib/optimistic-log";
import { ChatInput } from "./chat-input";
import { AgentDropdown } from "./agent-dropdown";
import { ProjectDisplay } from "./project-dropdown";
import { SessionDropdown } from "./session-dropdown";
import { EmptyState } from "./chat-empty-state";
import { ChatResizeHandles } from "./chat-resize-handles";
import { useChatContextItems } from "./use-chat-context-items";
import { useChatResize } from "./use-chat-resize";
import { createLogger } from "@multiremi/core/logger";
import type {
  Agent,
  ChatPendingTask,
  ChatSession,
  Attachment,
} from "@multiremi/core/types";
import { useT } from "../../i18n";
import { useNavigation } from "../../navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { getCurrentWsId } from "@multiremi/core/platform";
import { createSafeId } from "@multiremi/core/utils";
import { PageHeader } from "../../layout/page-header";
import { ChatQueue } from "./chat-queue";

const uiLogger = createLogger("chat.ui");
const apiLogger = createLogger("chat.api");
export function ChatWindow({
  presentation = "window",
  onSessionChange,
  initialLog,
  initialSessionId,
}: {
  presentation?: "window" | "page";
  onSessionChange?: (sessionId: string | null, agentId?: string) => void;
  initialLog?: IssueLogBootstrap;
  initialSessionId?: string;
}) {
  const isPage = presentation === "page";
  const [showList, setShowList] = useState(false);
  const navigation = useNavigation();
  const workspacePaths = useWorkspacePaths();
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const [runtimeWorkspaceId, setRuntimeWorkspaceId] = useState<string | null>(null);
  useEffect(() => { setRuntimeWorkspaceId(null); }, [wsId]);
  const isOpen = useChatStore((s) => s.isOpen);
  const chatVisible = isPage || isOpen;
  const storedActiveSessionId = useChatStore((s) => s.activeSessionId);
  const [pageSessionId, setPageSessionId] = useState(initialSessionId ?? storedActiveSessionId);
  useEffect(() => { if (isPage) setPageSessionId(initialSessionId ?? storedActiveSessionId); }, [isPage, initialSessionId]);
  useEffect(() => {
    if (isPage && !initialSessionId && !pageSessionId && storedActiveSessionId)
      setPageSessionId(storedActiveSessionId);
  }, [isPage, initialSessionId, pageSessionId, storedActiveSessionId]);
  const activeSessionId = isPage ? pageSessionId : storedActiveSessionId;
  const displayedSessionId = activeSessionId;
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const draftProjectId = useChatStore((s) => s.draftProjectId);
  const setDraftProjectId = useChatStore((s) => s.setDraftProjectId);
  const setOpen = useChatStore((s) => s.setOpen);
  const storeSetActiveSession = useChatStore((s) => s.setActiveSession);
  const setActiveSession = useCallback(
    (id: string | null, agentId?: string) => {
      storeSetActiveSession(id);
      if (isPage) setPageSessionId(id);
      onSessionChange?.(id, agentId);
      setShowList(false);
    },
    [storeSetActiveSession, onSessionChange, isPage],
  );
  const setSelectedAgentId = useChatStore((s) => s.setSelectedAgentId);
  const user = useAuthStore((s) => s.user);
  const { data: agents = [] } = useQuery(agentListOptions(wsId, { enabled: chatVisible }));
  const { data: members = [] } = useQuery({ ...memberListOptions(wsId), enabled: chatVisible });
  const { data: projects = [] } = useQuery({ ...projectListOptions(wsId), enabled: chatVisible });
  // Single sessions cache — eliminates the separate active/all queries
  // that used to drift during the WS-invalidate window.
  const {
    data: sessions = [],
    isLoading: sessionsLoading,
    isError: sessionsError,
    refetch: refetchSessions,
  } = useQuery(chatSessionsOptions(wsId, "all", { enabled: chatVisible }));
  const { replica, snapshot: logSnapshot, error: messagesError } = useIssueLog(
    displayedSessionId ?? "", initialLog?.sessionId === displayedSessionId ? initialLog : undefined,
    undefined, true, chatVisible,
  );
  const replicaRef = useRef(replica);
  replicaRef.current = replica;
  const [pendingRefreshSessionId, setPendingRefreshSessionId] = useState<string | null>(null);
  const refreshSession = useCallback((sessionId: string) => {
    if (!chatVisible) { setPendingRefreshSessionId(sessionId); return; }
    if (replicaRef.current.sessionId === sessionId)
      void replicaRef.current.refreshTailPreservingWindow().catch(() => {});
    else setPendingRefreshSessionId(sessionId);
  }, [chatVisible]);
  useEffect(() => {
    if (!chatVisible || !pendingRefreshSessionId || replica.sessionId !== pendingRefreshSessionId) return;
    setPendingRefreshSessionId(null);
    void replica.refreshTailPreservingWindow().catch(() => {});
  }, [replica, pendingRefreshSessionId, chatVisible]);
  const [optimisticRows, setOptimisticRows] = useState<OptimisticChatRow[]>([]);
  const [isFetchingOlderMessages, setIsFetchingOlderMessages] = useState(false);
  const optimisticCounter = useRef(0);
  const displayedOptimistic = useMemo(() => optimisticRows.filter((row) => row.sessionId === displayedSessionId),
    [optimisticRows, displayedSessionId]);
  useEffect(() => {
    const confirmed = new Set(logSnapshot.entries.map(clientIdOf).filter((id): id is string => !!id));
    if (!confirmed.size) return;
    const now = Date.now();
    setOptimisticRows((rows) => {
      let changed = false;
      const next = rows.map((row) => {
        if (row.sessionId !== displayedSessionId || !confirmed.has(row.clientId) || row.status === "sent" || row.status === "hidden") return row;
        changed = true;
        return { ...row, status: "sent" as const, confirmedAt: now };
      });
      return changed ? next : rows;
    });
  }, [logSnapshot, displayedSessionId]);
  useEffect(() => {
    const waiting = optimisticRows.filter((row) => row.status === "sent" && row.confirmedAt);
    if (!waiting.length) return;
    const delay = Math.max(0, Math.min(...waiting.map((row) => row.confirmedAt! + 600 - Date.now())));
    const timer = setTimeout(() => setOptimisticRows((rows) => rows.map((row) =>
      row.status === "sent" && row.confirmedAt && Date.now() - row.confirmedAt >= 600
        ? { ...row, status: "hidden" } : row)), delay);
    return () => clearTimeout(timer);
  }, [optimisticRows]);

  // Server-authoritative pending task. Survives refresh / reopen / session
  // switch because it's keyed on sessionId in the Query cache; WS events
  // (chat:message / chat:done / task:*) keep it invalidated in real time.
  //
  // This is the SOLE source for pendingTaskId — no mirror in the store.
  const { data: pendingTask } = useQuery(
    pendingChatTaskOptions(displayedSessionId ?? "", { enabled: chatVisible }),
  );
  const pendingTaskId = pendingTask?.task_id ?? null;
  useChatScopeSubscription(displayedSessionId, chatVisible && !!displayedSessionId);

  // Archived sessions remain readable; restore them before sending.
  const currentSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : null;
  const isSessionArchived = currentSession?.status === "archived";

  // New chats keep the picker: it is the only chance to choose where the
  // chat runs. An existing chat with neither binding has no location to
  // report, so the strip would spend a row on the absence of a choice.
  const showLocationStrip =
    !activeSessionId ||
    Boolean(currentSession?.project_id || currentSession?.runtime_workspace_id);

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
  const agentAvailability = useWorkspaceAgentAvailability(chatVisible);
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
  // The caller reveals a new session after its local row or upload is ready.
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
            ...(runtimeWorkspaceId ? { runtime_workspace_id: runtimeWorkspaceId } : {}),
            title: titleSeed.slice(0, 50),
            ...(draftProjectId ? { project_id: draftProjectId } : {}),
          });
          return session.id;
        } finally {
          sessionPromiseRef.current = null;
        }
      })();
      sessionPromiseRef.current = promise;
      return promise;
    },
    [activeSessionId, activeAgent, createSession, runtimeWorkspaceId, draftProjectId],
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      const sessionAtStart = useChatStore.getState().activeSessionId;
      const sessionId = await ensureSession("");
      if (!sessionId || getCurrentWsId() !== wsId) return null;
      if (useChatStore.getState().activeSessionId === sessionAtStart)
        setActiveSession(sessionId);
      return uploadWithToast(file, { chatSessionId: sessionId });
    },
    [ensureSession, uploadWithToast, setActiveSession, wsId],
  );

  const deliverRow = useCallback(async (row: OptimisticChatRow) => {
    const sessionId = row.sessionId;
    const priorPending = qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId));
    if (!priorPending?.task_id) qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), {
      task_id: `optimistic-${row.clientId}`, status: "queued", created_at: row.createdAt,
    });
    try {
      const result = await api.sendChatMessage(sessionId, row.content, row.attachmentIds, row.clientId);
      if (!result.queued) qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), {
        task_id: result.task_id, status: "queued", created_at: result.created_at,
        supports_queue: result.supports_queue,
      });
      refreshSession(sessionId);
    } catch (error) {
      apiLogger.error("sendChatMessage.error", { sessionId, error: toSafeErrorDetails(error) });
      setOptimisticRows((rows) => rows.map((item) => item.clientId === row.clientId
        ? { ...item, status: "failed" } : item));
      refreshSession(sessionId);
      throw error;
    } finally {
      if (qc.getQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId))?.task_id === `optimistic-${row.clientId}`) {
        qc.setQueryData(chatKeys.pendingTask(sessionId), priorPending ?? {});
      }
      void qc.invalidateQueries({ queryKey: chatKeys.pendingTask(sessionId) });
      void qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
      void qc.invalidateQueries({ queryKey: chatKeys.sessions(wsId) });
    }
  }, [qc, wsId, refreshSession]);

  const handleSend = useCallback(async (content: string, attachmentIds?: string[], localAttachments?: Attachment[]) => {
    if (!activeAgent) throw new Error("No agent available");
    const sessionAtStart = useChatStore.getState().activeSessionId;
    const sessionId = await ensureSession(content);
    if (!sessionId || getCurrentWsId() !== wsId) throw new Error("Chat workspace changed");
    const row: OptimisticChatRow = {
      clientId: createSafeId(), sessionId, content, attachmentIds, attachments: localAttachments,
      createdAt: new Date().toISOString(),
      localSeq: (logSnapshot.head ?? 0) + ++optimisticCounter.current / 1_000_000,
      status: "sending",
    };
    setOptimisticRows((rows) => [...rows, row]);
    if (useChatStore.getState().activeSessionId === sessionAtStart) setActiveSession(sessionId, activeAgent.id);
    await deliverRow(row);
  }, [activeAgent, ensureSession, setActiveSession, wsId, logSnapshot.head, deliverRow]);

  const retrySend = useCallback((clientId: string) => {
    const row = optimisticRows.find((item) => item.clientId === clientId);
    if (!row) return;
    void replica.refreshTailPreservingWindow().then(() => {
      if (replica.getSnapshot(row.sessionId).entries.some((entry) => clientIdOf(entry) === clientId)) return;
      setOptimisticRows((rows) => rows.map((item) => item.clientId === clientId ? { ...item, status: "sending" } : item));
      void deliverRow(row).catch(() => {});
    }).catch(() => {});
  }, [optimisticRows, replica, deliverRow]);

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
      void replica.refreshTailPreservingWindow().catch(() => {});
    }
  }, [pendingTaskId, activeSessionId, stopping, qc, wsId, replica]);

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
      if (activeSessionId) setDraftProjectId(null);
      // Reset session when switching agent
      setActiveSession(null, agent.id);
    },
    [
      activeAgent,
      selectedAgentId,
      activeSessionId,
      setSelectedAgentId,
      setDraftProjectId,
      setActiveSession,
    ],
  );

  const handleNewChat = useCallback(() => {
    uiLogger.info("newChat", {
      previousSessionId: activeSessionId,
      previousPendingTask: pendingTaskId,
    });
    setRuntimeWorkspaceId(null);
    setDraftProjectId(null);
    setActiveSession(null);
  }, [activeSessionId, pendingTaskId, setActiveSession, setDraftProjectId]);

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
  const hasMessages = logSnapshot.entries.some(entry => entry.seq > 0)
    || displayedOptimistic.length > 0 || !!pendingTaskId;
  const waitingForLog = !!displayedSessionId && !logSnapshot.ready && !messagesError && displayedOptimistic.length === 0;
  const isVisible = isOpen && (isExpanded || boundsReady) && !waitingForLog;

  const containerClass =
    "absolute bottom-2 right-2 z-50 flex flex-col rounded-xl ring-1 ring-foreground/10 bg-sidebar shadow-2xl overflow-hidden";
  const containerStyle: React.CSSProperties = {
    transformOrigin: "bottom right",
    pointerEvents: isVisible ? "auto" : "none",
  };

  const contextItems = useChatContextItems(wsId, chatVisible);

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
            chatVisible={chatVisible}
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

      {showLocationStrip && (
        <div className="flex min-w-0 items-center border-b px-4 py-1.5">
          {activeSessionId && !currentSession?.runtime_workspace_id ? (
            <ProjectDisplay projects={projects} projectId={currentSession?.project_id ?? null} />
          ) : (
            <WorkLocationPicker
              projectsEnabled={chatVisible}
              wsId={wsId}
              value={activeSessionId ? currentSession?.runtime_workspace_id ?? null : runtimeWorkspaceId}
              projectId={activeSessionId ? currentSession?.project_id ?? null : draftProjectId}
              onChange={location => {
                setDraftProjectId(location.project_id);
                setRuntimeWorkspaceId(location.runtime_workspace_id);
              }}
              disabled={Boolean(activeSessionId) || createSession.isPending}
            />
          )}
        </div>
      )}

      {/* The log window is hidden until its first answer; no skeleton replaces rows. */}
      {messagesError && !logSnapshot.ready ? (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-sm text-destructive"
        >
          <p>{t(($) => $.page.load_failed)}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void replica.refreshTailPreservingWindow()}
          >
            {t(($) => $.page.retry)}
          </Button>
        </div>
      ) : waitingForLog ? (
        <div className="min-h-0 flex-1" />
      ) : hasMessages ? (
        <ChatMessageList
          visible={chatVisible}
          key={displayedSessionId}
          sessionId={displayedSessionId ?? ""}
          replica={replica}
          optimisticRows={displayedOptimistic}
          pendingTask={pendingTask}
          availability={availability}
          initialPositioned={initialLog?.sessionId === displayedSessionId}
          hasOlderMessages={!!replica.window?.has_more_before}
          isFetchingOlderMessages={isFetchingOlderMessages}
          onLoadOlderMessages={() => {
            setIsFetchingOlderMessages(true);
            void replica.earlier().finally(() => setIsFetchingOlderMessages(false));
          }}
          onRetrySend={retrySend}
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
      <HumanRequestDock taskId={pendingTaskId} enabled={chatVisible} />

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
                  chatVisible={chatVisible}
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
    <>
    {isOpen && waitingForLog && <div role="status" aria-label={t(($) => $.page.loading)}
      className="absolute bottom-2 right-2 z-50 flex size-10 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-foreground/10">
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
    </div>}
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
    </>
  );
}
