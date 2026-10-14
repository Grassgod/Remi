"use client";

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Square,
  SquarePen,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Button } from "@multiremi/ui/components/ui/button";
import { Input } from "@multiremi/ui/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@multiremi/ui/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@multiremi/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@multiremi/ui/components/ui/alert-dialog";
import { api } from "@multiremi/core/api";
import { useWorkspaceId } from "@multiremi/core/hooks";
import { createLogger } from "@multiremi/core/logger";
import { useChatStore } from "@multiremi/core/chat";
import {
  chatKeys,
  chatSessionsOptions,
  pendingChatTasksOptions,
} from "@multiremi/core/chat/queries";
import {
  useDeleteChatSession,
  useUpdateChatSession,
} from "@multiremi/core/chat/mutations";
import { runtimeWorkspacesOptions } from "@multiremi/core/runtimes/workspaces";
import { formatShortcut, getCurrentWsId, isMac, modKey } from "@multiremi/core/platform";
import type {
  ChatSession,
  PendingChatTaskItem,
  Project,
} from "@multiremi/core/types";
import { ActorAvatar } from "../../common/actor-avatar";
import { ProjectIcon } from "../../projects/components/project-icon";
import type { WorkLocation } from "../../runtimes/components/runtime-workspace-picker";
import { useSearchStore } from "../../search/search-store";
import { useT } from "../../i18n";

const apiLogger = createLogger("chat.api");

/** Initial sizes and the "Show more" step, per the Codex sidebar. */
export const RECENT_PAGE = 10;
export const GROUP_PAGE = 5;
export const GROUP_SESSION_PAGE = 5;
export const SHOW_MORE_STEP = 10;
/** Collapse and row-removal motion: 300ms on Codex's ease-out-expo curve. */
const EASE = [0.19, 1, 0.22, 1] as const;
/** Hover waits this long before a clipped title starts to scroll. */
const MARQUEE_DELAY_MS = 350;
/** Scroll speed of a clipped title, 2em/s at 14px. */
const MARQUEE_PX_PER_S = 28;
/** Width of the fade that ends a clipped title. */
const TITLE_FADE_PX = 16;

const ROW_SURFACE =
  "hover:bg-foreground/[0.053] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
const ICON_BUTTON =
  "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export interface ChatSidebarGroup {
  key: string;
  kind: "project" | "directory";
  id: string;
  sessions: ChatSession[];
}

export interface ChatSidebarSections {
  pinned: ChatSession[];
  /** Ordered by each group's most recent session. */
  groups: ChatSidebarGroup[];
  /** Non-pinned chats bound to neither a Project nor a directory. */
  recent: ChatSession[];
}

const byUpdatedDesc = (a: ChatSession, b: ChatSession) =>
  b.updated_at.localeCompare(a.updated_at);

/**
 * Splits the user's active chats into the sidebar's three sections. A pinned
 * chat lives only under Pinned, and a chat bound to a Project or a local
 * directory lives only in its group: neither repeats under Recent.
 */
export function groupChatSessions(sessions: readonly ChatSession[]): ChatSidebarSections {
  const live = sessions.filter((session) => session.status !== "archived").sort(byUpdatedDesc);
  const pinned: ChatSession[] = [];
  const recent: ChatSession[] = [];
  const groups = new Map<string, ChatSidebarGroup>();
  for (const session of live) {
    if (session.pinned) {
      pinned.push(session);
      continue;
    }
    const kind = session.project_id ? "project" : session.runtime_workspace_id ? "directory" : null;
    const id = session.project_id || session.runtime_workspace_id;
    if (!kind || !id) {
      recent.push(session);
      continue;
    }
    const key = `${kind}:${id}`;
    const group = groups.get(key) ?? { key, kind, id, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  // `live` is newest first, so groups are inserted in order of their newest chat.
  return { pinned, groups: [...groups.values()], recent };
}

/**
 * The first `limit` items, plus any item `keep` asks for (the open chat stays
 * visible). One hidden item is not worth a "Show more" row, so it is shown.
 */
export function visibleItems<T>(items: readonly T[], limit: number, keep?: (item: T) => boolean): T[] {
  const shown = items.filter((item, index) => index < limit || keep?.(item));
  return items.length - shown.length <= 1 ? [...items] : shown;
}

function useMotionTransition(): Transition {
  const reduce = useReducedMotion();
  return reduce ? { duration: 0 } : { duration: 0.3, ease: EASE };
}

type SidebarView = "main" | "automations" | "archived";

interface RowActions {
  select: (session: ChatSession) => void;
  archive: (session: ChatSession, running: boolean) => void;
  restore: (session: ChatSession) => void;
  togglePin: (session: ChatSession) => void;
  stop: (session: ChatSession, task: PendingChatTaskItem) => void;
  rename: (session: ChatSession) => void;
  remove: (session: ChatSession) => void;
}

export interface ChatSidebarProps {
  /** The user's own chats, every status. */
  sessions: ChatSession[];
  /** Undefined while the Project list is loading: a missing name is not yet "unavailable". */
  projects: Project[] | undefined;
  activeSessionId: string | null;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSelectSession: (session: ChatSession) => void;
  /** Starts a new chat, optionally bound to a Project or a local directory. */
  onNewChat: (location?: WorkLocation) => void;
  /** The open chat was deleted. */
  onSessionDeleted: () => void;
  /** Narrow screens: return to the conversation. */
  onClose?: () => void;
}

/**
 * The Chat page sidebar: new chat and search, then Pinned / Projects / Recent,
 * with Automations and Archived behind the footer entries.
 */
export function ChatSidebar({
  sessions,
  projects,
  activeSessionId,
  loading,
  error,
  onRetry,
  onSelectSession,
  onNewChat,
  onSessionDeleted,
  onClose,
}: ChatSidebarProps) {
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const queryClient = useQueryClient();
  const [view, setView] = useState<SidebarView>("main");

  // The automation list is read while the sidebar is on screen so its unread
  // replies can be flagged on the footer entry.
  const automationList = useQuery(chatSessionsOptions(wsId, "all", {}, "automation"));
  const { data: pending } = useQuery(pendingChatTasksOptions(wsId));
  const pendingBySession = useMemo(
    () => new Map((pending?.tasks ?? []).map((task) => [task.chat_session_id, task])),
    [pending],
  );
  const sections = useMemo(() => groupChatSessions(sessions), [sessions]);
  // Directory names are needed only when some chat is bound to one.
  const hasDirectoryChats = sessions.some((session) => !!session.runtime_workspace_id);
  const directories = useQuery({
    ...runtimeWorkspacesOptions(wsId),
    enabled: Boolean(wsId) && hasDirectoryChats,
  });

  const automationSessions = useMemo(
    () => (automationList.data ?? []).filter((session) => session.status !== "archived").sort(byUpdatedDesc),
    [automationList.data],
  );
  const archivedSessions = useMemo(() => {
    const seen = new Set<string>();
    return [...sessions, ...(automationList.data ?? [])]
      .filter((session) => {
        if (session.status !== "archived" || seen.has(session.id)) return false;
        seen.add(session.id);
        return true;
      })
      .sort(byUpdatedDesc);
  }, [sessions, automationList.data]);
  const automationUnreadCount = automationSessions.filter(
    (session) => session.has_unread && session.id !== activeSessionId,
  ).length;

  const updateSession = useUpdateChatSession();
  const deleteSession = useDeleteChatSession();
  const setStoreActiveSession = useChatStore((s) => s.setActiveSession);
  const activeIdRef = useRef(activeSessionId);
  activeIdRef.current = activeSessionId;
  const [renaming, setRenaming] = useState<ChatSession | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmArchive, setConfirmArchive] = useState<ChatSession | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ChatSession | null>(null);

  const titleOf = (session: ChatSession) => session.title?.trim() || t(($) => $.session_history.untitled);
  const fail = () => {
    toast.error(t(($) => $.sessions.failed));
  };

  /**
   * Undo is offered only for an idle chat: archiving a running one stopped its
   * run, which restoring the chat cannot bring back (the user confirmed that).
   */
  const doArchive = (session: ChatSession, undoable: boolean) => {
    updateSession.mutateAsync({ sessionId: session.id, status: "archived" }).then(
      () => {
        // Archiving cancels the run server-side; drop its spinner now.
        void queryClient.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
        const message = t(($) => $.sidebar.archived_toast, { title: titleOf(session) });
        if (!undoable) {
          toast(message);
          return;
        }
        toast(message, {
          action: {
            label: t(($) => $.sidebar.undo),
            onClick: () => {
              updateSession.mutateAsync({ sessionId: session.id, status: "active" }).catch(fail);
            },
          },
        });
      },
      fail,
    );
  };

  const actions: RowActions = {
    select: onSelectSession,
    // Archiving stops a run and the run cannot be brought back, so a running
    // chat asks first; an idle one archives at once and offers Undo.
    archive: (session, running) => (running ? setConfirmArchive(session) : doArchive(session, true)),
    restore: (session) => {
      updateSession.mutateAsync({ sessionId: session.id, status: "active" }).catch(fail);
    },
    togglePin: (session) => {
      updateSession.mutateAsync({ sessionId: session.id, pinned: !session.pinned }).catch(fail);
    },
    stop: (session, task) => {
      api
        .cancelTaskById(task.turn_id ?? task.task_id)
        .catch((err: unknown) => {
          fail();
          apiLogger.warn("cancelTask.error (sidebar row; task may have already finished)", {
            taskId: task.task_id,
            sessionId: session.id,
            err,
          });
        })
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
          void queryClient.invalidateQueries({ queryKey: chatKeys.pendingTask(session.id) });
        });
    },
    rename: (session) => {
      setRenameValue(session.title ?? "");
      setRenaming(session);
    },
    remove: setConfirmDelete,
  };

  const submitRename = () => {
    const session = renaming;
    setRenaming(null);
    if (!session) return;
    const trimmed = renameValue.trim();
    // A blank or unchanged title would be rejected or only bump updated_at.
    if (!trimmed || trimmed === session.title) return;
    updateSession.mutateAsync({ sessionId: session.id, title: trimmed }).catch(fail);
  };

  const confirmDeleteSession = (session: ChatSession) => {
    deleteSession.mutateAsync(session.id).then(
      () => {
        setConfirmDelete(null);
        if (getCurrentWsId() !== wsId) return;
        // The core mutation may already have cleared this session. Preserve
        // any newer selection made while this request was in flight.
        const selectedId = useChatStore.getState().activeSessionId;
        if (selectedId === session.id || (!selectedId && activeIdRef.current === session.id)) {
          if (selectedId === session.id) setStoreActiveSession(null);
          onSessionDeleted();
        }
      },
      fail,
    );
  };

  const rowProps = {
    activeSessionId,
    pendingBySession,
    actions,
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {view === "main" ? (
        <>
          <div className="shrink-0 space-y-0.5 px-2 pt-2">
            <div className="flex items-center gap-1">
              <SidebarButton icon={<SquarePen />} onClick={() => onNewChat()} className="flex-1">
                {t(($) => $.sidebar.new_chat)}
              </SidebarButton>
              {onClose && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="md:hidden"
                  aria-label={t(($) => $.page.back)}
                  onClick={onClose}
                >
                  <ArrowLeft />
                </Button>
              )}
            </div>
            <SidebarButton
              icon={<Search />}
              onClick={() => useSearchStore.getState().setOpen(true)}
              trailing={
                <kbd
                  suppressHydrationWarning
                  className="ml-auto hidden font-sans text-xs text-muted-foreground group-hover/button:inline group-focus-visible/button:inline"
                >
                  {isMac ? `${modKey}K` : formatShortcut(modKey, "K")}
                </kbd>
              }
            >
              {t(($) => $.sidebar.search)}
            </SidebarButton>
          </div>
          <div data-chat-sidebar-scroll="" className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2">
            {loading ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">{t(($) => $.page.loading)}</p>
            ) : error ? (
              <div role="alert" className="space-y-2 px-2 py-4 text-sm text-destructive">
                <p>{t(($) => $.page.load_failed)}</p>
                <Button size="sm" variant="outline" onClick={onRetry}>
                  {t(($) => $.page.retry)}
                </Button>
              </div>
            ) : sections.pinned.length + sections.groups.length + sections.recent.length === 0 ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">{t(($) => $.sidebar.empty)}</p>
            ) : (
              <>
                {sections.pinned.length > 0 && (
                  <Section title={t(($) => $.sidebar.pinned)}>
                    <RowList sessions={sections.pinned} {...rowProps} />
                  </Section>
                )}
                {sections.groups.length > 0 && (
                  <Section title={t(($) => $.sidebar.projects)}>
                    <GroupList
                      groups={sections.groups}
                      projects={projects}
                      directoryNames={directories.data?.map((d) => [d.id, d.name] as const)}
                      onNewChat={onNewChat}
                      {...rowProps}
                    />
                  </Section>
                )}
                {sections.recent.length > 0 && (
                  <Section title={t(($) => $.sidebar.recent)}>
                    <RowList sessions={sections.recent} limit={RECENT_PAGE} {...rowProps} />
                  </Section>
                )}
              </>
            )}
          </div>
          <div className="shrink-0 space-y-0.5 border-t px-2 py-2">
            <SidebarButton
              icon={<Zap />}
              onClick={() => setView("automations")}
              trailing={
                automationUnreadCount > 0 ? (
                  <span
                    role="img"
                    aria-label={t(($) => $.sessions.automation_unread, { count: automationUnreadCount })}
                    className="ml-auto size-2 shrink-0 rounded-full bg-brand"
                  />
                ) : null
              }
            >
              {t(($) => $.sidebar.automations)}
            </SidebarButton>
            <SidebarButton icon={<Archive />} onClick={() => setView("archived")}>
              {t(($) => $.sidebar.archived)}
            </SidebarButton>
          </div>
        </>
      ) : (
        <>
          <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t(($) => $.sidebar.back)}
              onClick={() => setView("main")}
            >
              <ArrowLeft />
            </Button>
            <h2 className="min-w-0 truncate text-sm font-medium">
              {view === "automations" ? t(($) => $.sidebar.automations) : t(($) => $.sidebar.archived)}
            </h2>
          </div>
          <div data-chat-sidebar-scroll="" className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {automationList.isError && (
              <div role="alert" className="flex items-center gap-2 px-2 py-2 text-xs text-destructive">
                <span className="min-w-0 flex-1">{t(($) => $.sessions.load_failed)}</span>
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2"
                  onClick={() => void automationList.refetch()}
                >
                  {t(($) => $.sessions.retry)}
                </button>
              </div>
            )}
            {view === "automations" && automationList.isPending ? (
              <p className="px-2 py-4 text-sm text-muted-foreground">{t(($) => $.sessions.loading)}</p>
            ) : (view === "automations" ? automationSessions : archivedSessions).length === 0 ? (
              automationList.isError && view === "automations" ? null : (
                <p className="px-2 py-4 text-sm text-muted-foreground">
                  {view === "automations"
                    ? t(($) => $.sidebar.automations_empty)
                    : t(($) => $.sidebar.archived_empty)}
                </p>
              )
            ) : (
              <RowList
                key={view}
                sessions={view === "automations" ? automationSessions : archivedSessions}
                limit={RECENT_PAGE}
                {...rowProps}
              />
            )}
          </div>
        </>
      )}

      <Dialog open={!!renaming} onOpenChange={(open) => { if (!open) setRenaming(null); }}>
        <DialogContent className="sm:max-w-sm" showCloseButton={false}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t(($) => $.sidebar.rename_dialog.title)}</DialogTitle>
              <DialogDescription>{t(($) => $.sidebar.rename_dialog.description)}</DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              aria-label={t(($) => $.sidebar.rename_dialog.title)}
              placeholder={t(($) => $.sidebar.rename_dialog.placeholder)}
              value={renameValue}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setRenameValue(event.target.value)}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                {t(($) => $.sidebar.rename_dialog.cancel)}
              </Button>
              <Button type="submit">{t(($) => $.sidebar.rename_dialog.save)}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmArchive} onOpenChange={(open) => { if (!open) setConfirmArchive(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.sidebar.archive_dialog.title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.sidebar.archive_dialog.description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{t(($) => $.sidebar.archive_dialog.cancel)}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const session = confirmArchive;
                setConfirmArchive(null);
                if (session) doArchive(session, false);
              }}
            >
              {t(($) => $.sidebar.archive_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(open) => {
          // A deletion in flight keeps its dialog; a failure leaves it open.
          if (!open && !deleteSession.isPending) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(($) => $.sidebar.delete_dialog.title)}</AlertDialogTitle>
            <AlertDialogDescription>{t(($) => $.sidebar.delete_dialog.description)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus disabled={deleteSession.isPending}>
              {t(($) => $.sidebar.delete_dialog.cancel)}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteSession.isPending}
              onClick={() => { if (confirmDelete) confirmDeleteSession(confirmDelete); }}
            >
              {deleteSession.isPending
                ? t(($) => $.sidebar.delete_dialog.confirming)
                : t(($) => $.sidebar.delete_dialog.confirm)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SidebarButton({
  icon,
  children,
  trailing,
  onClick,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  trailing?: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group/button flex h-[30px] w-full min-w-0 items-center gap-2 rounded-[10px] px-2 text-left text-sm text-foreground/85 outline-none [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        ROW_SURFACE,
        className,
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
      {trailing}
    </button>
  );
}

function CollapsePanel({ open, children }: { open: boolean; children: ReactNode }) {
  const transition = useMotionTransition();
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="panel"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={transition}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="mt-4 first:mt-1" aria-label={title}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group/section flex h-[30px] w-full items-center gap-1 rounded-[10px] px-2 text-left text-sm font-medium text-muted-foreground outline-none hover:bg-foreground/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 truncate">{title}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 transition-transform duration-300 ease-[cubic-bezier(.19,1,.22,1)] motion-reduce:transition-none",
            open ? "opacity-0 group-hover/section:opacity-100 group-focus-visible/section:opacity-100" : "-rotate-90",
          )}
        />
      </button>
      <CollapsePanel open={open}>{children}</CollapsePanel>
    </section>
  );
}

interface RowListProps {
  sessions: ChatSession[];
  limit?: number;
  indent?: boolean;
  activeSessionId: string | null;
  pendingBySession: Map<string, PendingChatTaskItem>;
  actions: RowActions;
}

function RowList({ sessions, limit, indent, activeSessionId, pendingBySession, actions }: RowListProps) {
  const [shownLimit, setShownLimit] = useState(limit ?? Infinity);
  const transition = useMotionTransition();
  const shown = visibleItems(sessions, shownLimit, (session) => session.id === activeSessionId);
  return (
    <>
      <AnimatePresence initial={false}>
        {shown.map((session) => (
          // Removal collapses the row away; arrivals appear in place.
          <motion.div
            key={session.id}
            exit={{ height: 0, opacity: 0 }}
            transition={transition}
            className="overflow-hidden"
          >
            <SessionRow
              session={session}
              active={session.id === activeSessionId}
              pendingTask={pendingBySession.get(session.id)}
              indent={indent}
              actions={actions}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {shown.length < sessions.length && (
        <ShowMoreButton indent={indent} onClick={() => setShownLimit((value) => value + SHOW_MORE_STEP)} />
      )}
    </>
  );
}

function ShowMoreButton({ onClick, indent }: { onClick: () => void; indent?: boolean }) {
  const { t } = useT("chat");
  return (
    <button
      type="button"
      data-chat-sidebar-more=""
      onClick={onClick}
      className={cn(
        "flex h-[30px] w-full items-center rounded-[10px] px-2 text-sm text-muted-foreground outline-none hover:text-foreground",
        ROW_SURFACE,
        indent && "pl-[30px]",
      )}
    >
      {t(($) => $.sidebar.show_more)}
    </button>
  );
}

function GroupList({
  groups,
  projects,
  directoryNames,
  onNewChat,
  activeSessionId,
  ...rowProps
}: {
  groups: ChatSidebarGroup[];
  projects: Project[] | undefined;
  directoryNames: ReadonlyArray<readonly [string, string]> | undefined;
  onNewChat: (location?: WorkLocation) => void;
} & Omit<RowListProps, "sessions" | "limit" | "indent">) {
  const { t } = useT("chat");
  const [limit, setLimit] = useState(GROUP_PAGE);
  const shown = visibleItems(groups, limit, (group) =>
    group.sessions.some((session) => session.id === activeSessionId),
  );
  const directoryName = new Map(directoryNames ?? []);
  return (
    <>
      {shown.map((group) => {
        const project = group.kind === "project"
          ? projects?.find((item) => item.id === group.id && !item.archived_at)
          : undefined;
        // "…" while a list loads; "unavailable" only once it has answered.
        const name = group.kind === "project"
          ? projects ? project?.title ?? t(($) => $.project.unavailable) : "…"
          : directoryNames
            ? directoryName.get(group.id) ?? t(($) => $.sidebar.directory_unavailable)
            : "…";
        return (
          <GroupSection
            key={group.key}
            name={name}
            icon={group.kind === "project"
              ? <ProjectIcon project={project} size="md" />
              : <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            newLabel={t(($) => $.sidebar.new_chat_in, { name })}
            onNew={() => onNewChat(group.kind === "project"
              ? { project_id: group.id, runtime_workspace_id: null }
              : { project_id: null, runtime_workspace_id: group.id })}
          >
            <RowList
              sessions={group.sessions}
              limit={GROUP_SESSION_PAGE}
              indent
              activeSessionId={activeSessionId}
              {...rowProps}
            />
          </GroupSection>
        );
      })}
      {shown.length < groups.length && (
        <ShowMoreButton onClick={() => setLimit((value) => value + SHOW_MORE_STEP)} />
      )}
    </>
  );
}

function GroupSection({
  name,
  icon,
  newLabel,
  onNew,
  children,
}: {
  name: string;
  icon: ReactNode;
  newLabel: string;
  onNew: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div role="group" aria-label={name}>
      <div className="group/section relative flex h-[30px] items-center rounded-[10px] hover:bg-foreground/[0.053]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2 pr-8 text-left text-sm text-foreground/85 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        >
          {icon}
          <span className="min-w-0 truncate">{name}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(.19,1,.22,1)] motion-reduce:transition-none",
              open ? "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100" : "-rotate-90",
            )}
          />
        </button>
        <button
          type="button"
          aria-label={newLabel}
          title={newLabel}
          onClick={onNew}
          className={cn(ICON_BUTTON, "absolute right-1.5 hidden group-hover/section:flex group-focus-within/section:flex")}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <CollapsePanel open={open}>{children}</CollapsePanel>
    </div>
  );
}

function SessionRow({
  session,
  active,
  pendingTask,
  indent,
  actions,
}: {
  session: ChatSession;
  active: boolean;
  pendingTask: PendingChatTaskItem | undefined;
  indent?: boolean;
  actions: RowActions;
}) {
  const { t } = useT("chat");
  // One menu for both the ⋯ button and right-click: a second Base UI menu
  // root nested in the row would turn into a submenu and never open.
  const [menuOpen, setMenuOpen] = useState(false);
  const running = !!pendingTask;
  const needsAnswer = pendingTask?.status === "awaiting_human";
  const unread = session.has_unread && !active;
  const archived = session.status === "archived";
  // An existing chat without a title is "Untitled"; "New chat" names the unsaved draft.
  const title = session.title?.trim() || t(($) => $.session_history.untitled);
  const more = t(($) => $.sidebar.more_actions);
  const status = needsAnswer ? t(($) => $.sidebar.status.needs_answer)
    : running ? t(($) => $.sidebar.status.running)
      : unread ? t(($) => $.sidebar.status.unread) : null;
  const archiveLabel = archived ? t(($) => $.sidebar.menu.restore) : t(($) => $.sidebar.menu.archive);

  return (
    <div
      data-chat-session-row={session.id}
      data-perf-chat-session={session.id}
      role="button"
      // The row's own name: the title and its status, not the action buttons inside.
      aria-label={status ? `${title}, ${status}` : title}
      aria-current={active ? "page" : undefined}
      tabIndex={0}
      onClick={() => actions.select(session)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        actions.select(session);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      className={cn(
        "group/row relative flex h-[30px] cursor-default select-none items-center gap-2 rounded-[10px] px-2 text-sm text-foreground/85 outline-none",
        ROW_SURFACE,
        (active || menuOpen) && "bg-foreground/[0.053] text-foreground",
        indent && "pl-[30px]",
      )}
    >
      <ActorAvatar actorType="agent" actorId={session.agent_id} size={16} profileLink={false} />
      <MarqueeTitle text={title} />
      <span
        className={cn(
          "flex h-5 min-w-5 shrink-0 items-center justify-end",
          menuOpen ? "hidden" : "group-hover/row:hidden group-focus-within/row:hidden",
        )}
      >
        <RowStatus running={running && !needsAnswer} needsAnswer={needsAnswer} unread={unread} />
      </span>
      <span
        className={cn(
          "shrink-0 items-center gap-1",
          menuOpen ? "flex" : "hidden group-hover/row:flex group-focus-within/row:flex",
        )}
      >
        <button
          type="button"
          aria-label={archiveLabel}
          title={archiveLabel}
          className={ICON_BUTTON}
          onClick={(event) => {
            event.stopPropagation();
            if (archived) actions.restore(session);
            else actions.archive(session, running);
          }}
        >
          {archived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        </button>
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={more}
                title={more}
                className={ICON_BUTTON}
                onClick={(event) => event.stopPropagation()}
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => actions.rename(session)}>
              <Pencil />
              {t(($) => $.sidebar.menu.rename)}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => actions.togglePin(session)}>
              {session.pinned ? <PinOff /> : <Pin />}
              {session.pinned ? t(($) => $.sidebar.menu.unpin) : t(($) => $.sidebar.menu.pin)}
            </DropdownMenuItem>
            {pendingTask && (
              <DropdownMenuItem onClick={() => actions.stop(session, pendingTask)}>
                <Square />
                {t(($) => $.sidebar.menu.stop)}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {archived ? (
              <DropdownMenuItem onClick={() => actions.restore(session)}>
                <ArchiveRestore />
                {t(($) => $.sidebar.menu.restore)}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => actions.archive(session, running)}>
                <Archive />
                {t(($) => $.sidebar.menu.archive)}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem variant="destructive" onClick={() => actions.remove(session)}>
              <Trash2 />
              {t(($) => $.sidebar.menu.delete)}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
}

function RowStatus({ running, needsAnswer, unread }: { running: boolean; needsAnswer: boolean; unread: boolean }) {
  const { t } = useT("chat");
  if (needsAnswer)
    return (
      <span className="max-w-[150px] truncate rounded-full bg-orange-50 px-2 text-xs leading-5 text-orange-700 dark:bg-orange-400/10 dark:text-orange-300">
        {t(($) => $.sidebar.status.needs_answer)}
      </span>
    );
  if (running)
    return (
      <LoaderCircle
        role="img"
        aria-label={t(($) => $.sidebar.status.running)}
        className="size-4 animate-[spin_2s_steps(60,end)_infinite] text-foreground/60"
      />
    );
  if (unread)
    return (
      <span
        role="img"
        aria-label={t(($) => $.sidebar.status.unread)}
        className="size-2 rounded-full bg-brand"
      />
    );
  return null;
}

/**
 * A title that does not fit fades at its end; hovering the row waits 350ms
 * and then scrolls it to the end at 28px/s. Reduced motion keeps it still.
 */
function MarqueeTitle({ text }: { text: string }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content) return;
    // Hovering swaps the status slot for wider actions, so the box resizes.
    const measure = () => setOverflow(Math.max(0, content.scrollWidth - box.clientWidth));
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);
  const clipped = overflow > 1;
  const distance = overflow + TITLE_FADE_PX;
  const fade = `linear-gradient(to right, #000 calc(100% - ${TITLE_FADE_PX}px), transparent)`;
  return (
    <span
      ref={outer}
      dir="auto"
      data-chat-row-title=""
      className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap"
      style={clipped ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
    >
      <span
        ref={inner}
        className={cn(
          "inline-block",
          clipped &&
            "transition-transform duration-150 ease-linear motion-safe:group-hover/row:[transform:var(--marquee-to)] motion-safe:group-hover/row:[transition-delay:var(--marquee-delay)] motion-safe:group-hover/row:[transition-duration:var(--marquee-duration)]",
        )}
        style={
          clipped
            ? ({
                "--marquee-to": `translateX(-${distance}px)`,
                "--marquee-delay": `${MARQUEE_DELAY_MS}ms`,
                "--marquee-duration": `${Math.round((distance / MARQUEE_PX_PER_S) * 1000)}ms`,
              } as React.CSSProperties)
            : undefined
        }
      >
        {text}
      </span>
    </span>
  );
}
