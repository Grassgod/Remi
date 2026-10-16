"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WorkLocationPicker, type WorkLocation } from "../../runtimes/components/runtime-workspace-picker";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  ExternalLink,
  List,
  Minus,
  Maximize2,
  Minimize2,
  Plus,
  LoaderCircle,
  Zap,
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
import { runtimeWorkspacesOptions } from "@multiremi/core/runtimes/workspaces";
import {
  useAgentPresenceDetail,
  useWorkspaceAgentAvailability,
} from "@multiremi/core/agents";
import { useFileUpload } from "@multiremi/core/hooks/use-file-upload";
import { OfflineBanner } from "./offline-banner";
import { HumanRequestDock } from "./human-request-dock";
import { NoAgentBanner } from "./no-agent-banner";
import {
  chatSessionOptions,
  chatSessionsOptions,
  pendingChatTaskOptions,
  chatKeys,
} from "@multiremi/core/chat/queries";
import { useIssueLog } from "@multiremi/core/session-log/use-issue-log";
import type { IssueLogBootstrap } from "@multiremi/core/api/schemas/session-log";
import {
  useCreateChatSession,
  useEnqueueChatMessage,
  useMarkChatSessionRead,
  useUpdateChatSession,
  useUpdateQueuedChatMessage,
} from "@multiremi/core/chat/mutations";
import {
  reconcileSettledPendingChatTask,
  useChatStore,
  type ChatQueueEdit,
  type PendingChatTaskRef,
} from "@multiremi/core/chat";
import { isQueueDeliveryUnconfirmed, queueErrorCode } from "@multiremi/core/chat/queue";
import { ChatMessageList } from "./chat-message-list";
import { contextRingSource, type HeldRingUsage } from "../lib/turn-card";
import { ChatContextUsage } from "./chat-context-usage";
import type { SessionLogEntry } from "@multiremi/core/replica";
import { useTurnTrace } from "../../common/task-transcript/use-task-trace";
import { clientIdOf, type OptimisticChatRow } from "../lib/optimistic-log";
import { ChatInput, type ChatSendMode } from "./chat-input";
import { AgentDropdown } from "./agent-dropdown";
import { ProjectDisplay } from "./project-dropdown";
import { SessionDropdown } from "./session-dropdown";
import { ChatSidebar } from "./chat-sidebar";
import { ActorAvatar } from "../../common/actor-avatar";
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
import { AppLink, useNavigation } from "../../navigation";
import { useWorkspacePaths } from "@multiremi/core/paths";
import { getCurrentWsId } from "@multiremi/core/platform";
import { createSafeId } from "@multiremi/core/utils";
import { useFloatingPanelLayout } from "../../layout/floating-panel-layout";
import { ChatQueue, type ChatQueueController } from "./chat-queue";
import { SubagentPanelLayout } from "./subagent-panel";
import { useChatBackgroundTasks } from "./use-background-tasks";

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
  const { t: tr } = useT("runtimes");
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
  const { data: projectsData, isError: projectsFailed } = useQuery({ ...projectListOptions(wsId), enabled: chatVisible });
  const projects = projectsData ?? [];
  // Loading is not "missing": a bound Project reads "…" until the list answers.
  const loadedProjects = projectsData ?? (projectsFailed ? [] : undefined);
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
  // Chat lifecycle events keep it current; the SessionLog stream owns content.
  //
  // This is the SOLE source for pendingTaskId — no mirror in the store.
  const { data: pendingTask } = useQuery(
    pendingChatTaskOptions(displayedSessionId ?? "", { enabled: chatVisible }),
  );
  const pendingTaskId = pendingTask?.task_id ?? null;
  // The context ring follows the running turn's live trace, the same one the
  // message list follows (a pending task whose reply already landed counts as
  // finished there too), else the newest finished turn card. It never reads a
  // finished turn's trace.
  // The last live value, per session: kept between chat-done and the arrival
  // of the turn's own card, so the ring does not flash the previous turn's.
  const [heldRing, setHeldRing] = useState<(HeldRingUsage & { sessionId: string | null }) | null>(null);
  const held = heldRing && heldRing.sessionId === displayedSessionId ? heldRing : null;
  const ringContext = useMemo(
    () => contextRingSource(logSnapshot.entries as ReadonlyArray<SessionLogEntry & { task_id?: string | null; metadata?: Record<string, unknown> }>, pendingTaskId, held),
    [logSnapshot.entries, pendingTaskId, held],
  );
  const liveRingTrace = useTurnTrace(ringContext.liveTaskId, {
    enabled: chatVisible && !!ringContext.liveTaskId, live: true, turnId: pendingTask?.turn_id,
  });
  const liveRingUsage = ringContext.liveTaskId ? liveRingTrace.turn?.context_usage ?? null : null;
  useEffect(() => {
    if (ringContext.liveTaskId && liveRingUsage) {
      setHeldRing({ sessionId: displayedSessionId, taskId: ringContext.liveTaskId, usage: liveRingUsage });
    }
  }, [displayedSessionId, ringContext.liveTaskId, liveRingUsage]);

  // Archived sessions remain readable; restore them before sending. The list
  // holds only the user's own chats, so a chat opened by an automation run
  // (reached from a run row or a shared link) is read by id instead.
  const listedSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : undefined;
  const { data: fetchedSession } = useQuery({
    ...chatSessionOptions(wsId, activeSessionId ?? ""),
    enabled: chatVisible && !!activeSessionId && !sessionsLoading && !listedSession,
  });
  const currentSession = listedSession ?? fetchedSession ?? null;
  const isSessionArchived = currentSession?.status === "archived";

  // Background tasks (PR 6): the session list says how many run, with or
  // without a turn; only then does the visible chat read the registry rows
  // the strip, the panel and the launch rows share (MUL-472). An older
  // server sends no count, and nothing is read.
  const sessionBackgroundTasks = currentSession?.id === displayedSessionId ? currentSession?.running_background_tasks ?? null : null;
  const backgroundTasks = useChatBackgroundTasks(displayedSessionId, {
    enabled: chatVisible && (sessionBackgroundTasks ?? 0) > 0,
    expectRunning: sessionBackgroundTasks,
  });
  const backgroundTasksRunning = Math.max(sessionBackgroundTasks ?? 0, backgroundTasks.running);

  // New chats keep the picker: it is the only chance to choose where the
  // chat runs. An existing chat with neither binding has no location to
  // report, so the strip would spend a row on the absence of a choice. The
  // page names an existing chat's location in its header instead.
  const showLocationStrip =
    !activeSessionId ||
    (!isPage && Boolean(currentSession?.project_id || currentSession?.runtime_workspace_id));

  // The page header names where an existing chat runs. Directory names are
  // read only for a chat bound to one.
  const boundDirectoryId = isPage && activeSessionId ? currentSession?.runtime_workspace_id ?? null : null;
  const { data: runtimeWorkspaces } = useQuery({
    ...runtimeWorkspacesOptions(wsId),
    enabled: chatVisible && Boolean(wsId) && !!boundDirectoryId,
  });
  const boundProjectId = isPage && activeSessionId ? currentSession?.project_id ?? null : null;
  const boundLocation = boundProjectId
    ? (() => {
        const label = loadedProjects
          ? loadedProjects.find((project) => project.id === boundProjectId && !project.archived_at)?.title
            ?? t(($) => $.project.unavailable)
          : "…";
        return { label, name: `${t(($) => $.project.label)}: ${label}`, hint: t(($) => $.project.fixed_hint) };
      })()
    : boundDirectoryId && runtimeWorkspaces
      ? (() => {
          const label = runtimeWorkspaces.find((workspace) => workspace.id === boundDirectoryId)?.name
            ?? tr(($) => $.location.directory_missing);
          return { label, name: `${tr(($) => $.location.label)}: ${label}`, hint: tr(($) => $.location.locked) };
        })()
      : null;

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
  const { mutateAsync: enqueueMessage } = useEnqueueChatMessage();
  const { mutateAsync: updateQueuedMessage } = useUpdateQueuedChatMessage();
  const queueController = useRef<ChatQueueController | null>(null);
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
  const currentHasUnread = currentSession?.has_unread ?? false;
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
        task_id: result.task_id, turn_id: result.turn_id, status: "queued", created_at: result.created_at,
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

  const handleSend = useCallback(async (content: string, attachmentIds?: string[], localAttachments?: Attachment[], mode: ChatSendMode = "send") => {
    if (!activeAgent) throw new Error("No agent available");
    const sessionAtStart = useChatStore.getState().activeSessionId;
    const sessionId = await ensureSession(content);
    if (!sessionId || getCurrentWsId() !== wsId) throw new Error("Chat workspace changed");
    if (mode === "queue") {
      // Queued (排队): the row waits outside the log until this turn completes.
      // An enqueue on an idle lane releases every queued row, so deletes still
      // behind their undo are sent first.
      await queueController.current?.flushDeletes();
      try {
        const result = await enqueueMessage({
          sessionId, body_md: content, attachment_ids: attachmentIds, client_id: createSafeId(),
          created_at: new Date().toISOString(),
          attachments: (localAttachments ?? []).map((attachment) => ({
            id: attachment.id, filename: attachment.filename, content_type: attachment.content_type, size: attachment.size_bytes,
          })),
        });
        // An idle lane released it at once: it is already a log message.
        if (result.released) refreshSession(sessionId);
      } catch (error) {
        // Without an HTTP answer the row stays in the queue as unconfirmed;
        // the draft has been handed over to it.
        if (isQueueDeliveryUnconfirmed(error)) return;
        throw error;
      }
      return;
    }
    // Sent now: idle starts a turn; a running turn takes it as a steer (引导).
    const row: OptimisticChatRow = {
      clientId: createSafeId(), sessionId, content, attachmentIds, attachments: localAttachments,
      createdAt: new Date().toISOString(),
      localSeq: (logSnapshot.head ?? 0) + ++optimisticCounter.current / 1_000_000,
      status: "sending",
    };
    setOptimisticRows((rows) => [...rows, row]);
    if (useChatStore.getState().activeSessionId === sessionAtStart) setActiveSession(sessionId, activeAgent.id);
    await deliverRow(row);
  }, [activeAgent, ensureSession, setActiveSession, wsId, logSnapshot.head, deliverRow, enqueueMessage, refreshSession]);

  // Saves the queued message edited in the composer. A row that can no
  // longer change (released, deleted, or edited elsewhere) keeps the text as
  // an ordinary draft; other failures stay in edit mode for a retry.
  const handleSaveQueueEdit = useCallback(async (sessionId: string, edit: ChatQueueEdit, content: string, attachmentIds: string[]) => {
    try {
      await updateQueuedMessage({
        sessionId, itemId: edit.itemId, body_md: content, attachment_ids: attachmentIds, expected_revision: edit.revision,
      });
      if (useChatStore.getState().queueEdit[sessionId]?.itemId === edit.itemId) {
        useChatStore.getState().finishQueueEdit(sessionId, "restore");
      }
    } catch (error) {
      const code = queueErrorCode(error);
      const notice = code === "revision_conflict" ? t(($) => $.queue.changed)
        : code === "queued_message_consumed" ? t(($) => $.queue.consumed)
          : code === "queued_message_not_found" || code === "queued_message_deleted" ? t(($) => $.queue.deleted_elsewhere)
            : null;
      if (!notice) throw error;
      if (useChatStore.getState().queueEdit[sessionId]?.itemId !== edit.itemId) return;
      // The submitted text, not the debounced stored draft, so no keystroke is lost.
      useChatStore.getState().finishQueueEdit(sessionId, "keep", content);
      toast(notice);
    }
  }, [updateQueuedMessage, t]);

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
      await api.cancelTaskById(pendingTask?.turn_id ?? pendingTaskId);
    } catch (error) {
      setActionError(true);
      apiLogger.error("cancelTask.error", { taskId: pendingTaskId, error });
    } finally {
      setStopping(false);
      void qc.invalidateQueries({
        queryKey: chatKeys.pendingTask(activeSessionId),
      });
      void qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
      // A member's stop pauses the follow-up queue (interrupted).
      void qc.invalidateQueries({ queryKey: chatKeys.queue(wsId, activeSessionId) });
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

  // A sidebar group's "+" starts the new chat already bound to its Project or
  // local directory; the location picker keeps the draft until the first send.
  const handleNewChat = useCallback((location?: WorkLocation) => {
    uiLogger.info("newChat", {
      previousSessionId: activeSessionId,
      previousPendingTask: pendingTaskId,
    });
    setRuntimeWorkspaceId(location?.runtime_workspace_id ?? null);
    setDraftProjectId(location?.project_id ?? null);
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

  // PR 6 §2.8: a turn waiting for a local folder that another chat's parked
  // background tasks hold links to that chat's 后台任务 view (「全部停止」 there).
  const openSubagentPanel = useChatStore((s) => s.openSubagentPanel);
  const resolveChat = useCallback((sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return null;
    return {
      title: session.title?.trim() || t(($) => $.session_history.untitled),
      open: () => {
        handleSelectSession(session);
        openSubagentPanel({ sessionId: session.id, view: "tasks", attemptId: null, live: false, path: [], task: null });
      },
    };
  }, [sessions, t, handleSelectSession, openSubagentPanel]);

  const handleMinimize = useCallback(() => {
    uiLogger.info("minimize (close)", {
      activeSessionId,
      pendingTaskId,
    });
    setOpen(false);
  }, [activeSessionId, pendingTaskId, setOpen]);

  const isExpanded = useChatStore((s) => s.isExpanded);

  const { rightRailWidth } = useFloatingPanelLayout();
  const windowRef = useRef<HTMLDivElement>(null);
  const {
    renderWidth,
    renderHeight,
    isAtMax,
    boundsReady,
    isDragging,
    toggleExpand,
    startDrag,
  } = useChatResize(windowRef, isPage ? 0 : rightRailWidth);

  // Show the list (vs empty state) as soon as there's anything to display —
  // a real message, or a pending task whose timeline will stream in.
  const hasMessages = logSnapshot.entries.some(entry => entry.seq > 0)
    || displayedOptimistic.length > 0 || !!pendingTaskId;
  const waitingForLog = !!displayedSessionId && !logSnapshot.ready && !messagesError && displayedOptimistic.length === 0;
  const isVisible = isOpen && (isExpanded || boundsReady) && !waitingForLog;

  const containerClass =
    "absolute bottom-2 right-2 z-50 flex flex-col rounded-xl ring-1 ring-foreground/10 bg-sidebar shadow-2xl overflow-hidden";
  const containerStyle: React.CSSProperties = {
    right: 8 + rightRailWidth,
    transformOrigin: "bottom right",
    pointerEvents: isVisible ? "auto" : "none",
  };

  const contextItems = useChatContextItems(wsId, chatVisible);

  const conversation = (
    <>
      {isPage ? (
        // Page header: who and what this chat is. New chat and history live
        // in the sidebar, so the header carries no session controls.
        <div data-chat-page-header="" className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <Button
            variant="ghost"
            size="icon-sm"
            className="md:hidden"
            aria-label={t(($) => $.page.history)}
            onClick={() => setShowList(true)}
          >
            <List />
          </Button>
          {activeAgent && (
            <ActorAvatar actorType="agent" actorId={activeAgent.id} size={20} enableHoverCard showStatusDot />
          )}
          <h1 className="min-w-0 truncate text-sm font-medium">
            {/* "New chat" names the unsaved draft; an existing chat without a title is "Untitled". */}
            {currentSession?.title?.trim()
              || (activeSessionId ? t(($) => $.session_history.untitled) : t(($) => $.window.untitled))}
          </h1>
          {boundLocation && (
            <span
              role="group"
              aria-label={boundLocation.name}
              title={boundLocation.hint}
              className="min-w-0 max-w-[40%] shrink truncate text-sm text-muted-foreground"
            >
              <span aria-hidden="true">· </span>{boundLocation.label}
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between border-b px-4 py-2.5 gap-2">
          <div className="flex items-center gap-1 min-w-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-full text-muted-foreground"
                    onClick={() => handleNewChat()}
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
              activeSession={currentSession}
              onSelectSession={handleSelectSession}
              onSessionDeleted={() => setActiveSession(null)}
            />
          </div>
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
        </div>
      )}

      {currentSession?.origin && (
        <div className="flex min-w-0 items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground">
          <Zap className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t(($) => $.window.automation_origin)}</span>
          <AppLink
            href={workspacePaths.autopilotDetail(currentSession.origin.autopilot_id)}
            className="shrink-0 text-foreground underline underline-offset-2"
          >
            {t(($) => $.window.view_automation)}
          </AppLink>
        </div>
      )}

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
        isPage ? <DelayedLoadingIndicator label={t(($) => $.page.loading_conversation)} /> : <div className="min-h-0 flex-1" />
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
          resolveChat={resolveChat}
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
      <HumanRequestDock taskId={pendingTaskId} sessionId={displayedSessionId ?? undefined} turnId={pendingTask?.turn_id} enabled={chatVisible} />

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
      {activeSessionId && currentSession?.agent_id && chatVisible && (
        <ChatQueue
          key={`${wsId}:${activeSessionId}:${currentSession.agent_id}`}
          sessionId={activeSessionId}
          pendingTaskId={pendingTaskId}
          archived={isSessionArchived}
          onReleased={() => refreshSession(activeSessionId)}
          controllerRef={queueController}
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
        onSaveQueueEdit={handleSaveQueueEdit}
        onUploadFile={handleUploadFile}
        onStop={handleStop}
        // The turn's own stop leaves background tasks running (PR 6 §6.3); its label says so.
        stopLabel={backgroundTasksRunning > 0 ? t(($) => $.bg_tasks.stop_turn_hint) : undefined}
        isRunning={!!pendingTaskId}
        disabled={isSessionArchived}
        noAgent={noAgent}
        agentName={activeAgent?.name}
        rightAdornment={<ChatContextUsage live={liveRingUsage} last={ringContext.last} />}
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
      <div className="flex h-full min-h-0">
        <aside
          className={`${showList ? "flex" : "hidden"} w-full min-h-0 shrink-0 flex-col border-r bg-sidebar md:flex md:w-[300px]`}
        >
          <ChatSidebar
            sessions={sessions}
            projects={loadedProjects}
            activeSessionId={activeSessionId}
            loading={sessionsLoading}
            error={sessionsError}
            onRetry={() => void refetchSessions()}
            onSelectSession={handleSelectSession}
            onNewChat={handleNewChat}
            onSessionDeleted={() => setActiveSession(null)}
            onClose={() => setShowList(false)}
          />
        </aside>
        <main
          className={`${showList ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col md:flex`}
        >
          {/* The subagent panel pushes the conversation aside (PR 5 §6.6). */}
          <SubagentPanelLayout sessionId={displayedSessionId ?? null} presentation="page">
            {conversation}
          </SubagentPanelLayout>
        </main>
      </div>
    );

  return (
    <>
    {isOpen && waitingForLog && <div role="status" aria-label={t(($) => $.page.loading)}
      className="absolute bottom-2 right-2 z-50 flex size-10 items-center justify-center rounded-full bg-card text-muted-foreground shadow-sm ring-1 ring-foreground/10" style={{ right: 8 + rightRailWidth }}>
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
    </div>}
    <motion.div
      data-floating-chat-window=""
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
      {/* In the floating window the subagent panel covers the conversation. */}
      <SubagentPanelLayout sessionId={displayedSessionId ?? null} presentation="window" visible={isOpen}>
        {conversation}
      </SubagentPanelLayout>
    </motion.div>
    </>
  );
}

/**
 * The first load of a conversation shows nothing for 400ms, then a 28px
 * spinner: a fast load never flashes one.
 */
function DelayedLoadingIndicator({ label }: { label: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      {shown && (
        <div role="status" aria-label={label} data-chat-log-loading="">
          <LoaderCircle className="size-7 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
