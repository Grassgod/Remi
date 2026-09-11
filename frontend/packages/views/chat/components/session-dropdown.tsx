"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Square,
  Trash2,
} from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multiremi/ui/components/ui/popover";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { createLogger } from "@multiremi/core/logger";
import {
  chatKeys,
  pendingChatTasksOptions,
} from "@multiremi/core/chat/queries";
import {
  useDeleteChatSession,
  useUpdateChatSession,
} from "@multiremi/core/chat/mutations";
import { useChatStore } from "@multiremi/core/chat";
import { getCurrentWsId } from "@multiremi/core/platform";
import type {
  Agent,
  ChatSession,
  PendingChatTasksResponse,
} from "@multiremi/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { useT } from "../../i18n";
import { SessionRenameInput } from "./session-rename-input";
import { useFormatTimeAgo } from "./use-format-time-ago";

const apiLogger = createLogger("chat.api");

/**
 * Session dropdown: a flat "Chat history" list of all non-archived
 * sessions. Selecting a session from a different agent implicitly
 * switches the agent too
 * (sessions are bound 1:1 to an agent). "New chat" lives in the header's
 * ⊕ button, not inside this dropdown.
 */
export function SessionDropdown({
  sessions,
  agents,
  activeSessionId,
  onSelectSession,
  presentation = "dropdown",
  onSessionDeleted,
}: {
  sessions: ChatSession[];
  agents: Agent[];
  activeSessionId: string | null;
  onSelectSession: (session: ChatSession) => void;
  presentation?: "dropdown" | "list";
  onSessionDeleted?: () => void;
}) {
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const agentById = useMemo(
    () => new Map(agents.map((a) => [a.id, a])),
    [agents],
  );
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const title = activeSession?.title?.trim() || t(($) => $.window.untitled);
  const triggerAgent = activeSession
    ? (agentById.get(activeSession.agent_id) ?? null)
    : null;

  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState(false);
  const historySessions = useMemo(
    () =>
      sessions
        .filter((s) => (s.status === "archived") === showArchived)
        .filter((s) =>
          `${s.title} ${s.last_message?.content ?? ""}`
            .toLocaleLowerCase()
            .includes(search.toLocaleLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            b.updated_at.localeCompare(a.updated_at),
        ),
    [sessions, showArchived, search],
  );

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const [confirmingStopId, setConfirmingStopId] = useState<string | null>(null);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [completedFlashIds, setCompletedFlashIds] = useState<Set<string>>(
    () => new Set(),
  );
  const previousInFlightRef = useRef<Set<string>>(new Set());
  const completedFlashTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  // Inline rename: only one row can be in edit mode at a time. We track the
  // session id (not the full session) so a stale closure can't overwrite a
  // newer rename pulled in via WS.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const deleteSession = useDeleteChatSession();
  const updateSession = useUpdateChatSession();
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const queryClient = useQueryClient();
  const formatTimeAgo = useFormatTimeAgo();

  // Aggregate "which sessions have an in-flight task right now". Reuses
  // the same workspace-scoped query the FAB consumes, so toggling the chat
  // window doesn't fire a second request — TanStack dedupes by key.
  const { data: pending } = useQuery(pendingChatTasksOptions(wsId));
  const pendingTaskBySessionId = useMemo(
    () =>
      new Map(
        (pending?.tasks ?? []).map((task) => [task.chat_session_id, task]),
      ),
    [pending],
  );
  const inFlightSessionIds = useMemo(
    () => new Set(pendingTaskBySessionId.keys()),
    [pendingTaskBySessionId],
  );

  useEffect(() => {
    const previous = previousInFlightRef.current;
    const unreadSessionIds = new Set(
      sessions.filter((s) => s.has_unread).map((s) => s.id),
    );

    for (const sessionId of previous) {
      if (inFlightSessionIds.has(sessionId) || !unreadSessionIds.has(sessionId))
        continue;

      setCompletedFlashIds((current) => {
        if (current.has(sessionId)) return current;
        return new Set(current).add(sessionId);
      });

      const existingTimer = completedFlashTimersRef.current.get(sessionId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        setCompletedFlashIds((current) => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
        completedFlashTimersRef.current.delete(sessionId);
      }, 1600);
      completedFlashTimersRef.current.set(sessionId, timer);
    }

    previousInFlightRef.current = inFlightSessionIds;
  }, [inFlightSessionIds, sessions]);

  useEffect(() => {
    const timers = completedFlashTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!confirmingStopId || pendingTaskBySessionId.has(confirmingStopId))
      return;
    setConfirmingStopId(null);
  }, [confirmingStopId, pendingTaskBySessionId]);

  // Header state split:
  // - inside the trigger: the current chat's own live state
  // - beside the trigger: aggregate activity from other chats
  const currentSessionRunning = activeSessionId
    ? inFlightSessionIds.has(activeSessionId)
    : false;
  const otherRunningCount = sessions.filter(
    (s) => s.id !== activeSessionId && inFlightSessionIds.has(s.id),
  ).length;
  const otherUnreadCount = sessions.filter(
    (s) => s.id !== activeSessionId && s.has_unread,
  ).length;

  const handleConfirmDelete = (session: ChatSession) => {
    const sessionId = session.id;
    setActionError(false);
    deleteSession.mutate(sessionId, {
      onSuccess: () => {
        if (getCurrentWsId() !== wsId) return;
        // The core mutation may already have cleared this session. Preserve
        // any newer selection made while this request was in flight.
        const selectedId = useChatStore.getState().activeSessionId;
        if (
          selectedId === sessionId ||
          (!selectedId && activeSessionId === sessionId)
        ) {
          if (selectedId === sessionId) setActiveSession(null);
          onSessionDeleted?.();
        }
        setConfirmingDeleteId(null);
      },
      onError: () => setActionError(true),
    });
  };

  const handleSubmitRename = (sessionId: string, raw: string) => {
    const trimmed = raw.trim();
    const current = sessions.find((s) => s.id === sessionId);
    setRenamingId(null);
    // No-op submits (unchanged or blank) skip the network round-trip — the
    // server would reject a blank title anyway, and an unchanged title would
    // just bump updated_at for no user-visible reason.
    if (!trimmed || trimmed === current?.title) return;
    setActionError(false);
    updateSession.mutate(
      { sessionId, title: trimmed },
      { onError: () => setActionError(true) },
    );
  };

  const handleSelectSession = (session: ChatSession) => {
    onSelectSession(session);
    setIsHistoryOpen(false);
  };

  const handleConfirmStop = (
    session: ChatSession,
    task: PendingChatTasksResponse["tasks"][number],
  ) => {
    setStoppingTaskId(task.task_id);
    previousInFlightRef.current = new Set(
      [...previousInFlightRef.current].filter(
        (sessionId) => sessionId !== session.id,
      ),
    );

    api
      .cancelTaskById(task.task_id)
      .then(
        () =>
          apiLogger.info("cancelTask.success (history row)", {
            taskId: task.task_id,
            sessionId: session.id,
          }),
        (err) => {
          setActionError(true);
          apiLogger.warn(
            "cancelTask.error (history row; task may have already finished)",
            {
              taskId: task.task_id,
              sessionId: session.id,
              err,
            },
          );
        },
      )
      .finally(() => {
        queryClient.invalidateQueries({
          queryKey: chatKeys.pendingTasks(wsId),
        });
        queryClient.invalidateQueries({
          queryKey: chatKeys.pendingTask(session.id),
        });
        setStoppingTaskId(null);
        setConfirmingStopId(null);
      });
  };

  const renderRow = (session: ChatSession) => {
    const isCurrent = session.id === activeSessionId;
    const agent = agentById.get(session.agent_id) ?? null;
    const pendingTask = pendingTaskBySessionId.get(session.id);
    const isRunning = !!pendingTask;
    const showCompleted = completedFlashIds.has(session.id) && !isCurrent;
    const showUnread = session.has_unread && !isCurrent;
    const isRenaming = renamingId === session.id;
    const isConfirmingDelete = confirmingDeleteId === session.id;
    const isConfirmingStop = confirmingStopId === session.id && !!pendingTask;
    const isConfirmingAction = isConfirmingDelete || isConfirmingStop;
    const titleText = session.title?.trim() || t(($) => $.window.untitled);
    const trailingStatus = isRunning
      ? t(($) => $.session_history.row_subtitle.working)
      : showCompleted
        ? t(($) => $.session_history.row_subtitle.completed)
        : showUnread
          ? t(($) => $.session_history.row_subtitle.new_reply)
          : formatTimeAgo(session.updated_at);

    return (
      <div
        key={session.id}
        aria-current={isCurrent ? "true" : undefined}
        tabIndex={0}
        onClick={() => {
          if (isRenaming || isConfirmingAction) return;
          handleSelectSession(session);
        }}
        onKeyDown={(e) => {
          if (isRenaming || isConfirmingAction) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          handleSelectSession(session);
        }}
        className={cn(
          "group/history-row relative flex min-h-11 min-w-0 cursor-default items-center gap-2 overflow-hidden rounded-md py-1.5 pl-2 pr-2 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring",
          isCurrent && "bg-accent/70",
          isConfirmingAction && "bg-destructive/5 hover:bg-destructive/5",
        )}
      >
        {isCurrent && (
          <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand" />
        )}
        {agent ? (
          <ActorAvatar
            actorType="agent"
            actorId={agent.id}
            size={24}
            enableHoverCard
            showStatusDot
          />
        ) : (
          <span className="size-6 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <SessionRenameInput
              initialValue={session.title ?? ""}
              onSubmit={(value) => handleSubmitRename(session.id, value)}
              onCancel={() => setRenamingId(null)}
            />
          ) : isConfirmingDelete ? (
            <div className="truncate text-sm font-medium text-destructive">
              {t(($) => $.session_history.delete_dialog.title)}
            </div>
          ) : isConfirmingStop ? (
            <div className="truncate text-sm font-medium text-destructive">
              {t(($) => $.session_history.stop_dialog.title)}
            </div>
          ) : (
            <div
              className={cn(
                "truncate text-sm",
                (showUnread || showCompleted) && !isRunning && "font-medium",
              )}
              style={{
                maskImage:
                  "linear-gradient(to right, black calc(100% - 18px), transparent)",
                WebkitMaskImage:
                  "linear-gradient(to right, black calc(100% - 18px), transparent)",
              }}
            >
              {session.pinned && (
                <Pin className="mr-1 inline size-3 text-muted-foreground" />
              )}
              {titleText}
            </div>
          )}
          {!isRenaming &&
            !isConfirmingAction &&
            presentation === "list" &&
            session.last_message && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {session.last_message.content}
              </p>
            )}
        </div>
        {!isRenaming &&
          (isConfirmingDelete ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setConfirmingDeleteId(null);
                }}
                disabled={deleteSession.isPending}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {t(($) => $.session_history.delete_dialog.cancel)}
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleConfirmDelete(session);
                }}
                disabled={deleteSession.isPending}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                {deleteSession.isPending
                  ? t(($) => $.session_history.delete_dialog.confirming)
                  : t(($) => $.session_history.delete_dialog.confirm)}
              </button>
            </div>
          ) : isConfirmingStop && pendingTask ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setConfirmingStopId(null);
                }}
                disabled={stoppingTaskId === pendingTask.task_id}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {t(($) => $.session_history.stop_dialog.cancel)}
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleConfirmStop(session, pendingTask);
                }}
                disabled={stoppingTaskId === pendingTask.task_id}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                {stoppingTaskId === pendingTask.task_id
                  ? t(($) => $.session_history.stop_dialog.confirming)
                  : t(($) => $.session_history.stop_dialog.confirm)}
              </button>
            </div>
          ) : (
            // Status readout and row actions occupy the same slot, so the swap
            // has to be `display` — an opacity fade would reserve both widths
            // at once. `focus-within` is what makes the actions reachable
            // without a mouse: the row itself is focusable, so focusing it
            // flips the actions into the layout, and only then can Tab move
            // into them.
            <div className="flex shrink-0 items-center">
              <div className="flex h-7 items-center justify-end gap-1.5 text-xs text-muted-foreground group-focus-within/history-row:hidden group-hover/history-row:hidden">
                {isRunning && <Loader2 className="size-3 animate-spin" />}
                {showCompleted && !isRunning && (
                  <Check className="size-3 text-success" />
                )}
                {showUnread && !isRunning && !showCompleted && (
                  <span
                    aria-label={t(($) => $.window.unread)}
                    title={t(($) => $.window.unread)}
                    className="min-w-4 rounded-full bg-brand px-1 text-center text-[10px] font-medium text-primary-foreground"
                  >
                    {Math.max(1, session.unread_count ?? 0) > 99
                      ? "99+"
                      : Math.max(1, session.unread_count ?? 0)}
                  </span>
                )}
                <span
                  className={cn(
                    "truncate",
                    (showUnread || showCompleted || isRunning) &&
                      "font-medium text-foreground",
                  )}
                >
                  {trailingStatus}
                </span>
              </div>
              <div className="hidden h-7 items-center gap-0.5 group-focus-within/history-row:flex group-hover/history-row:flex">
                {isRunning && pendingTask && (
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setConfirmingStopId(session.id);
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none"
                    aria-label={t(($) => $.session_history.row_stop_aria)}
                    title={t(($) => $.session_history.row_stop_aria)}
                  >
                    <Square className="size-2.5 fill-current" />
                  </button>
                )}
                <>
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                    aria-label={
                      session.pinned
                        ? t(($) => $.sessions.unpin)
                        : t(($) => $.sessions.pin)
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      setActionError(false);
                      updateSession.mutate(
                        { sessionId: session.id, pinned: !session.pinned },
                        { onError: () => setActionError(true) },
                      );
                    }}
                  >
                    {session.pinned ? (
                      <PinOff className="size-3.5" />
                    ) : (
                      <Pin className="size-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                    aria-label={
                      session.status === "archived"
                        ? t(($) => $.sessions.restore)
                        : t(($) => $.sessions.archive)
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      setActionError(false);
                      updateSession.mutate(
                        {
                          sessionId: session.id,
                          status:
                            session.status === "archived"
                              ? "active"
                              : "archived",
                        },
                        { onError: () => setActionError(true) },
                      );
                    }}
                  >
                    {session.status === "archived" ? (
                      <ArchiveRestore className="size-3.5" />
                    ) : (
                      <Archive className="size-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setRenamingId(session.id);
                    }}
                    className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
                    aria-label={t(($) => $.session_history.row_rename_aria)}
                    title={t(($) => $.session_history.row_rename_aria)}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setConfirmingDeleteId(session.id);
                    }}
                    className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none"
                    aria-label={t(($) => $.session_history.row_delete_aria)}
                    title={t(($) => $.session_history.row_delete_aria)}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </>
              </div>
            </div>
          ))}
      </div>
    );
  };

  const history = (
    <div className="flex min-h-0 flex-col">
      <div className="sticky top-0 z-10 space-y-2 border-b bg-sidebar px-2 py-2">
        <input
          aria-label={t(($) => $.sessions.search)}
          placeholder={t(($) => $.sessions.search)}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
        />
        <div className="flex gap-1">
          <button
            type="button"
            aria-pressed={!showArchived}
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs",
              !showArchived && "bg-accent font-medium",
            )}
            onClick={() => setShowArchived(false)}
          >
            {t(($) => $.sessions.active)}
          </button>
          <button
            type="button"
            aria-pressed={showArchived}
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs",
              showArchived && "bg-accent font-medium",
            )}
            onClick={() => setShowArchived(true)}
          >
            {t(($) => $.sessions.archived)}
          </button>
        </div>
      </div>
      {actionError && (
        <p role="alert" className="px-2 py-2 text-xs text-destructive">
          {t(($) => $.sessions.failed)}
        </p>
      )}
      {historySessions.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {t(($) => $.window.no_previous)}
        </p>
      ) : (
        <div
          role="group"
          aria-label={t(($) => $.window.history_group)}
          className="p-1"
        >
          {historySessions.map(renderRow)}
        </div>
      )}
    </div>
  );
  if (presentation === "list") return history;

  return (
    <>
      <Popover open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
        <div className="flex min-w-0 items-center gap-1">
          <PopoverTrigger className="flex max-w-96 min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent data-[popup-open]:bg-accent data-open:bg-accent">
            {triggerAgent && (
              <ActorAvatar
                actorType="agent"
                actorId={triggerAgent.id}
                size={24}
                enableHoverCard
                showStatusDot
              />
            )}
            <span className="min-w-0 truncate text-sm font-medium">
              {title}
            </span>
            {currentSessionRunning && (
              <Loader2
                aria-label={t(($) => $.session_history.row_subtitle.working)}
                className="size-3 shrink-0 animate-spin text-muted-foreground"
              />
            )}
            <ChevronDown className="size-3 text-muted-foreground shrink-0" />
          </PopoverTrigger>
          {otherRunningCount > 0 ? (
            <span
              aria-label={t(($) => $.window.another_running)}
              title={t(($) => $.window.another_running)}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" />
              {otherRunningCount > 1 && <span>{otherRunningCount}</span>}
            </span>
          ) : otherUnreadCount > 0 ? (
            <span
              aria-label={t(($) => $.window.another_unread)}
              title={t(($) => $.window.another_unread)}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground"
            >
              <span className="size-1.5 rounded-full bg-brand" />
              {otherUnreadCount > 1 && <span>{otherUnreadCount}</span>}
            </span>
          ) : null}
        </div>
        <PopoverContent
          align="start"
          className="max-h-96 w-auto min-w-[max(16rem,var(--anchor-width,16rem))] max-w-96 gap-0 overflow-y-auto p-1"
          onClick={(e) => e.stopPropagation()}
        >
          {history}
        </PopoverContent>
      </Popover>
    </>
  );
}
