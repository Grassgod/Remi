"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMotionValue, useReducedMotion } from "motion/react";
import type { TraceItem, TraceSubagentItem } from "@multiremi/contracts/trace";
import { topLevelSubagents } from "@multiremi/shared/turn-trace";
import type { BackgroundTaskResolver } from "@multiremi/shared/trace-step-copy";
import { useChatStore, type ChatPanelView, type SubagentPanelTarget } from "@multiremi/core/chat";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { cn } from "@multiremi/ui/lib/utils";
import { AlertCircle, ArrowLeft, Bot, ChevronRight, CircleStop, CircleX, LoaderCircle, X } from "lucide-react";
import { Markdown } from "../../common/markdown";
import { useTurnTrace, type TurnTraceView } from "../../common/task-transcript/use-task-trace";
import { useT } from "../../i18n";
import {
  isSubagent,
  subagentFailureText,
  subagentGenerations,
  subagentLabel,
  subagentPath,
  subagentStatus,
  subagentTaskLine,
  type SubagentGeneration,
} from "../lib/subagents";
import { backgroundLaunchResolver, findBackgroundTask, formatBackgroundClock } from "../lib/background-tasks";
import { overviewTurns, tracePromptLine, type ChatPanelRecord, type SubagentTurnRef } from "../lib/side-panel-record";
import { buildChildSteps, liveBlockKey, liveLabel, type FoldHeader } from "../lib/turn-steps";
import { CHAT_PANE_CLASS } from "../lib/chat-column";
import {
  BackgroundTaskDetail,
  BackgroundTaskDetailFooter,
  BackgroundTaskDetailHeader,
  BackgroundTasksOverview,
  localeOf,
} from "./background-task-view";
import {
  clampSidePanelWidth,
  CONVERSATION_MIN_PX,
  OVERLAY_TRANSITION,
  SidePanelFrame,
  sidePanelMaxWidth,
  SidePanelResizeHandle,
  SPLIT_TRANSITION,
  SUBAGENT_PANEL_MIN_PX,
  useDrawerProgress,
  useSidePanelWidth,
} from "./side-panel-motion";
import { useCachedBackgroundTasks, useChatBackgroundTasks, type ChatBackgroundTasksView } from "./use-background-tasks";
import { useStickyLabel, useTickingNow } from "./live-hooks";
import { SUBAGENT_SPIN, SubagentTraceContext, type SubagentTraceSource } from "./subagent-context";
import { formatSubagentElapsed, SubagentStatusText, useSubagentElapsed } from "./subagent-step-row";
import { useSubagentActivity } from "./subagent-running-strip";
import { TurnStepList } from "./turn-step-list";
import { REPLY, StepsFold, useFoldHeaderText } from "./turn-steps-fold";

// The subagent panel (PR 5 §6.6), after the Codex right panel (behaviour
// only, `codex-notes/5-子代理抽屉.md`):
// - On the Chat page it sits right of the conversation and pushes it
//   narrower; its width can be dragged and is remembered. When the
//   conversation cannot keep 352px beside a 320px panel it covers the
//   conversation instead, under 768px it is a full-width sheet, and in the
//   floating chat window it covers the window. Opening and closing animate
//   one progress value (`side-panel-motion.tsx`).
// - One panel per chat. Its 子代理 overview covers the whole chat: every turn
//   the page has on record that ran subagents, newest first, each a group
//   (time · first words of the prompt) that reads its turn's trace once it is
//   opened; the newest, the running and the targeted turn start open. A
//   subagent's detail is a read-only mini conversation (task bubble, steps,
//   reply) that updates live. Nested subagents open a deeper detail; ← goes
//   up one level.
// - × or Esc (focus inside) closes it and gives focus back to what opened it
//   (else the header toggle); switching chats and closing the floating window
//   close it at once; a click in the conversation does not.
// - PR 6: the same panel has a 后台任务 view, the chat's background tasks from
//   the session registry (`background-task-view.tsx`). It needs no attempt,
//   so it opens with no running turn. A 「子代理 | 后台任务 · m」 switch shows
//   only while both kinds exist; otherwise the header is one title.

/** The id of a chat's side panel, which its header toggle controls. */
export function sidePanelId(presentation: "page" | "window"): string {
  return `chat-side-panel-${presentation}`;
}

/**
 * The open panel target for this chat. Switching chats closes the panel (it
 * belongs to one chat's turn), and so does hiding the chat (closing the
 * floating window).
 */
function useSubagentPanelTarget(sessionId: string | null, visible: boolean): SubagentPanelTarget | null {
  const panel = useChatStore((s) => s.subagentPanel);
  const close = useChatStore((s) => s.closeSubagentPanel);
  const shownSession = useRef(sessionId);
  useEffect(() => {
    // A chat switch also drops a reveal request (the page can switch chats
    // through its URL without touching the store's active session).
    const switched = shownSession.current !== sessionId;
    shownSession.current = sessionId;
    if (switched || (panel && (!visible || panel.sessionId !== sessionId))) close();
  }, [panel, sessionId, visible, close]);
  return visible && panel && panel.sessionId === sessionId ? panel : null;
}

/** Width of an element, followed through resizes. */
function useElementWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Where focus goes around the panel: what had focus when it opened (the
 * header toggle, a step row, a strip chip) is remembered, and a close while
 * focus is inside the panel gives focus back to it, or to the header toggle
 * when it is gone. A close with focus elsewhere leaves focus alone.
 */
function useReturnFocus(panelId: string, target: SubagentPanelTarget | null) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    const panel = document.getElementById(panelId);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const outside = !!active && active !== document.body && !panel?.contains(active);
    if (target) {
      // Runs before the panel takes focus (its own effect), so this is the opener.
      if (outside) opener.current = active;
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const from = opener.current;
    opener.current = null;
    if (outside) return;
    // An opener that left the page (a row scrolled out of the list) or cannot
    // take focus (hidden) gives way to the toggle.
    if (from?.isConnected && !from.closest("[inert]")) {
      from.focus({ preventScroll: true });
      if (document.activeElement === from) return;
    }
    document.querySelector<HTMLElement>(`[data-side-panel-toggle="${panelId}"]`)?.focus({ preventScroll: true });
  }, [panelId, target]);
}

/** How long a pane-width change may take: the 0.5s spring, the rows' reflow after it, and slack. */
const PIN_GUARD_MS = 1000;
const PIN_SLACK_PX = 24;

/**
 * Keeps a conversation that was at its end at its end while the split changes
 * the pane's width (opening, closing). Its text reflows every frame, and the
 * scroll position the browser clamps as the content gets shorter, or rows the
 * list mounts meanwhile, could otherwise read to the list as the reader
 * scrolling away and release its pin. Like the list's own pin it writes from
 * a ResizeObserver, after layout and before paint. A reader who scrolls,
 * drags or uses the keys meanwhile takes over.
 */
function usePinnedThroughWidthChange(paneRef: React.RefObject<HTMLElement | null>, change: unknown, enabled: boolean) {
  // Only a change arms it: on mount the list is still placing itself (an
  // anchored deep link must not be pulled to the end).
  const seen = useRef(change);
  useLayoutEffect(() => {
    if (Object.is(seen.current, change)) return;
    seen.current = change;
    const scroll = enabled ? paneRef.current?.querySelector<HTMLElement>("[data-session-log-scroll]") : null;
    const content = scroll?.firstElementChild;
    if (!scroll || !content || typeof ResizeObserver !== "function") return;
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > PIN_SLACK_PX) return;
    let armed = true;
    const keep = () => {
      if (!armed) return;
      const end = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      if (Math.abs(scroll.scrollTop - end) >= 1) scroll.scrollTop = end;
    };
    const disarm = () => { armed = false; };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) disarm();
    };
    const observer = new ResizeObserver(keep);
    observer.observe(content);
    observer.observe(scroll);
    // Capturing on the pane runs before the list's own scroll listener, so the
    // scroll event a clamp or a late row causes finds the list at its end.
    const pane = paneRef.current!;
    const onScroll = (event: Event) => { if (event.target === scroll) keep(); };
    pane.addEventListener("scroll", onScroll, { capture: true, passive: true });
    scroll.addEventListener("wheel", disarm, { passive: true });
    scroll.addEventListener("touchmove", disarm, { passive: true });
    scroll.addEventListener("pointerdown", disarm);
    scroll.addEventListener("keydown", onKey);
    const timer = setTimeout(disarm, PIN_GUARD_MS);
    return () => {
      disarm();
      clearTimeout(timer);
      observer.disconnect();
      pane.removeEventListener("scroll", onScroll, { capture: true });
      scroll.removeEventListener("wheel", disarm);
      scroll.removeEventListener("touchmove", disarm);
      scroll.removeEventListener("pointerdown", disarm);
      scroll.removeEventListener("keydown", onKey);
    };
  }, [paneRef, change, enabled]);
}

/**
 * Lays the conversation out with the subagent panel. The conversation stays
 * mounted whether the panel is open or not, so its scroll position and
 * composer survive opening and closing it.
 */
export function SubagentPanelLayout({ sessionId, presentation, visible = true, record, children }: {
  sessionId: string | null;
  presentation: "page" | "window";
  /** The chat is on screen; closing the floating window closes the panel. */
  visible?: boolean;
  /** What the page has on record for the panel's chat-wide overview and switch. */
  record?: ChatPanelRecord;
  children: ReactNode;
}) {
  const { t } = useT("chat");
  const target = useSubagentPanelTarget(sessionId, visible);
  const close = useChatStore((s) => s.closeSubagentPanel);
  const isMobile = useIsMobile();
  const [groupRef, groupWidth] = useElementWidth<HTMLDivElement>();
  const mode = presentation === "window" ? "overlay"
    : isMobile ? "sheet"
      : groupWidth >= CONVERSATION_MIN_PX + SUBAGENT_PANEL_MIN_PX ? "split" : "overlay";
  const reduceMotion = useReducedMotion() ?? false;
  // A panel that leaves with its chat (switching chats, closing the floating
  // window) goes at once; only the reader's own close animates.
  const open = !!target;
  const { progress, mounted } = useDrawerProgress(open, {
    instant: reduceMotion || !visible || mode === "sheet",
    transition: mode === "split" ? SPLIT_TRANSITION : OVERLAY_TRANSITION,
    resetKey: sessionId,
  });
  // A closing panel keeps showing what it showed until it is gone.
  const [lastTarget, setLastTarget] = useState(target);
  if (target && target !== lastTarget) setLastTarget(target);
  const shown = target ?? (mounted ? lastTarget : null);
  const panelId = sidePanelId(presentation);
  useReturnFocus(panelId, target);
  const paneRef = useRef<HTMLDivElement>(null);
  usePinnedThroughWidthChange(paneRef, open, mode === "split");

  // The split: the outer width follows progress, the panel inside keeps its width.
  const [storedWidth, commitWidth] = useSidePanelWidth();
  const width = clampSidePanelWidth(storedWidth, groupWidth);
  const widthValue = useMotionValue(width);
  useLayoutEffect(() => { widthValue.set(width); }, [width, widthValue]);

  const view = shown ? <SubagentPanelView id={panelId} target={shown} record={record} onClose={close} /> : null;
  const overlay = mode === "overlay" && view
    ? <SidePanelFrame mode="overlay" progress={progress} width={widthValue} open={open}>{view}</SidePanelFrame>
    : null;

  if (presentation === "window") return <>{children}{overlay}</>;
  return (
    <div ref={groupRef} className="flex min-h-0 min-w-0 flex-1">
      {/* The pane the Chat column's width follows: the list and the composer are both inside. */}
      <div ref={paneRef} data-chat-conversation-pane className={cn(CHAT_PANE_CLASS, "relative flex min-h-0 min-w-0 flex-1 flex-col")}>
        {children}
        {overlay}
      </div>
      {mode === "split" && view && (
        <>
          {open && (
            <SidePanelResizeHandle width={widthValue} min={SUBAGENT_PANEL_MIN_PX} max={Math.max(SUBAGENT_PANEL_MIN_PX, sidePanelMaxWidth(groupWidth))}
              label={t(($) => $.subagents.resize)} onCommit={commitWidth} />
          )}
          <SidePanelFrame mode="split" progress={progress} width={widthValue} open={open}>{view}</SidePanelFrame>
        </>
      )}
      {mode === "sheet" && (
        <Sheet open={open} onOpenChange={(next) => { if (!next) close(); }}>
          <SheetContent side="right" showCloseButton={false} data-subagent-panel-mode="sheet"
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none">
            {target && <SubagentPanelView id={panelId} target={target} record={record} onClose={close} focusOnMount={false} />}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/**
 * The panel's own view: the header (a 「子代理 | 后台任务 · m」 switch when both
 * kinds exist, else the single title), the 子代理 view (the chat-wide overview
 * or a subagent's detail) or the 后台任务 view (the chat's tasks, PR 6 §8.1),
 * and the footer.
 */
export function SubagentPanelView({ id, target, record, onClose, focusOnMount = true }: {
  id?: string;
  target: SubagentPanelTarget;
  record?: ChatPanelRecord;
  onClose: () => void;
  /** Take focus when it opens, so Esc closes it at once (the sheet's dialog focuses itself). */
  focusOnMount?: boolean;
}) {
  const { t } = useT("chat");
  const view = target.view ?? "subagents";
  const attemptId = target.attemptId ?? null;
  // The 后台任务 view reads no trace of its own: only the running turn's (which
  // the live fold already follows) or one already cached (MUL-472).
  const trace = useTurnTrace(attemptId, { enabled: view === "subagents" || target.live, live: target.live, turnId: target.turnId });
  // The registry is read for the 后台任务 view, and for the switch when the
  // page has a task of this chat on record.
  const tasks = useChatBackgroundTasks(target.sessionId, { enabled: view === "tasks" || !!record?.tasks });
  const setView = useChatStore((s) => s.setPanelView);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusOnMount) rootRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const attemptHasSubagents = useMemo(() => topLevelSubagents(trace.items).length > 0, [trace.items]);
  const both = ((record?.turns.length ?? 0) > 0 || (!!attemptId && attemptHasSubagents)) && tasks.rows.length > 0;
  const title = both
    ? <PanelSwitch view={view} tasks={tasks.rows.length} onChange={setView} />
    : <h2 className="min-w-0 flex-1 truncate pl-2 text-sm font-medium">
      {view === "tasks" ? t(($) => $.bg_tasks.panel_title) : t(($) => $.subagents.panel_title)}
    </h2>;
  return (
    <section
      ref={rootRef}
      id={id}
      tabIndex={-1}
      aria-label={view === "tasks" ? t(($) => $.bg_tasks.panel_title) : t(($) => $.subagents.panel_title)}
      data-panel-view={view}
      data-subagent-panel={view === "tasks" ? (target.task ? "task" : "tasks") : target.path.length > 0 ? "detail" : "overview"}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      className="flex h-full min-h-0 flex-col bg-background outline-none"
    >
      {view === "tasks"
        ? <BackgroundTasksPanel target={target} tasks={tasks} title={title} onClose={onClose} />
        : <SubagentsPanel target={target} trace={trace} turns={record?.turns} title={title} onClose={onClose} />}
    </section>
  );
}

/**
 * 「子代理 | 后台任务 · m」: shown only while both kinds exist. The 子代理 side
 * has no count: the overview spans the chat's turns, and a turn not opened
 * yet has not told how many top-level subagents it ran.
 */
function PanelSwitch({ view, tasks, onChange }: {
  view: ChatPanelView; tasks: number; onChange: (view: ChatPanelView) => void;
}) {
  const { t } = useT("chat");
  const option = (value: ChatPanelView, label: string) => (
    <button key={value} type="button" role="tab" aria-selected={view === value} data-panel-switch-option={value}
      onClick={() => onChange(value)}
      className={cn("h-6 rounded-md px-2 whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        view === value && "bg-background text-foreground shadow-xs")}>
      {label}
    </button>
  );
  return (
    <div className="min-w-0 flex-1 pl-1">
      <div role="tablist" data-panel-switch className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 text-xs font-medium [scrollbar-width:none]">
        {option("subagents", t(($) => $.subagents.panel_title))}
        {option("tasks", t(($) => $.bg_tasks.view, { count: tasks }))}
      </div>
    </div>
  );
}

function PanelHeader({ title, back, onClose }: { title: ReactNode; back?: () => void; onClose: () => void }) {
  return (
    <div data-subagent-panel-header className="flex h-12 shrink-0 items-center gap-1.5 border-b pr-2 pl-2">
      {back && <BackButton onBack={back} />}
      {title}
      <CloseButton onClose={onClose} />
    </div>
  );
}

/**
 * Whether a view still missing what it shows has a read state to show
 * instead: an error, still loading (while pages arrive, an item that is not
 * there yet may be on a later page), or a read that is not ok. A live
 * attempt's first read can land before the daemon has a trace for it
 * (`not_found`); the stream then supplies every item, so a read that is not
 * ok only explains a view with nothing to show.
 */
function hasReadState(trace: TurnTraceView): boolean {
  return trace.error || !trace.loaded || (!!trace.read && trace.read.state !== "ok");
}

function TraceReadState({ trace }: { trace: TurnTraceView }) {
  const { t } = useT("chat");
  const { t: ta } = useT("agents");
  if (trace.error) {
    return (
      <div role="alert" className="flex items-center gap-1.5 p-4 text-sm text-destructive">
        <AlertCircle className="size-4" aria-hidden="true" />
        {t(($) => $.turn_steps.load_failed)}
        <button type="button" onClick={trace.retry} className="underline underline-offset-2 hover:text-foreground">
          {t(($) => $.turn_steps.retry)}
        </button>
      </div>
    );
  }
  if (!trace.loaded) {
    return (
      <div role="status" className="flex items-center gap-1.5 p-4 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{t(($) => $.subagents.loading)}
      </div>
    );
  }
  const read = trace.read;
  if (!read || read.state === "ok") return null;
  const text = read.state === "unreachable" ? ta(($) => $.transcript.trace_unreachable, { name: read.runtime_name ?? read.runtime_id ?? "" })
    : read.state === "lost" ? ta(($) => $.transcript.trace_lost) : ta(($) => $.transcript.trace_not_found);
  return <div className="p-4 text-sm text-muted-foreground">{text}</div>;
}

/** The 子代理 view (PR 5): the chat-wide overview, or a subagent's detail in one attempt. */
function SubagentsPanel({ target, trace, turns: recordTurns, title, onClose }: {
  target: SubagentPanelTarget;
  trace: TurnTraceView;
  turns?: readonly SubagentTurnRef[];
  title: ReactNode;
  onClose: () => void;
}) {
  const { t } = useT("chat");
  const setPath = useChatStore((s) => s.setSubagentPath);
  const openPanel = useChatStore((s) => s.openSubagentPanel);
  const items = trace.items;
  const attemptId = target.attemptId ?? null;
  const currentId = target.path.at(-1);
  const current = currentId ? items.find((item) => item.id === currentId) : undefined;
  const detail = target.path.length > 0;
  const source = useMemo<SubagentTraceSource>(() => ({
    sessionId: target.sessionId, attemptId, turnId: target.turnId, live: target.live,
  }), [target.sessionId, attemptId, target.turnId, target.live]);
  // Launch rows of background tasks a subagent started (PR 6): the registry
  // when it is loaded, else the trace.
  const taskRows = useCachedBackgroundTasks(target.sessionId);
  const attemptEnded = !!trace.turn && trace.turn.status !== "running";
  const resolveBackgroundTask = useMemo(() => backgroundLaunchResolver(items, taskRows, attemptId, attemptEnded),
    [items, taskRows, attemptId, attemptEnded]);
  const turns = useMemo(() => overviewTurns(recordTurns ?? [], { attemptId, turnId: target.turnId, live: target.live }),
    [recordTurns, attemptId, target.turnId, target.live]);
  // Groups the reader opened or closed; the rest follow `groupOpenByDefault`.
  // Kept here so they survive a visit to a detail and back.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  let body: ReactNode;
  if (detail) {
    body = isSubagent(current)
      ? <SubagentDetail key={current.id} item={current} items={items} resolveBackgroundTask={resolveBackgroundTask} />
      : hasReadState(trace) ? <TraceReadState trace={trace} />
        : <div data-subagent-not-found className="p-4 text-sm text-muted-foreground">{t(($) => $.subagents.not_found)}</div>;
  } else {
    body = (
      <ChatSubagentOverview turns={turns} focused={attemptId}
        isOpen={(turn, index) => toggled.get(turn.attemptId) ?? groupOpenByDefault(turn, index, attemptId, recordTurns?.[0]?.attemptId)}
        onToggle={(turn, open) => setToggled((map) => new Map(map).set(turn.attemptId, open))}
        onOpen={(turn, path) => openPanel({
          sessionId: target.sessionId, view: "subagents", attemptId: turn.attemptId, turnId: turn.turnId, live: turn.live, path,
        })} />
    );
  }
  const back = () => setPath(target.path.slice(0, -1));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {detail && isSubagent(current)
        ? <DetailHeader item={current} items={items} onBack={back} onClose={onClose} />
        : <PanelHeader title={detail ? <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t(($) => $.subagents.panel_title)}</h2> : title}
          back={detail ? back : undefined} onClose={onClose} />}
      <SubagentTraceContext.Provider value={source}>
        <div key={target.path.join("/")} data-subagent-panel-body className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      </SubagentTraceContext.Provider>
    </div>
  );
}

/**
 * The 后台任务 view (PR 6 §8.2): the chat's tasks from the session registry,
 * opened with or without a running turn; ← from a task's detail goes back to
 * the list.
 */
function BackgroundTasksPanel({ target, tasks, title, onClose }: {
  target: SubagentPanelTarget;
  tasks: ChatBackgroundTasksView;
  title: ReactNode;
  onClose: () => void;
}) {
  const { t } = useT("chat");
  const setTask = useChatStore((s) => s.setPanelTask);
  const row = target.task ? findBackgroundTask(tasks.rows, target.task) : null;
  const back = () => setTask(null);
  const currentAttemptId = target.live ? target.attemptId ?? null : null;
  let body: ReactNode;
  if (tasks.error && !tasks.rows.length) {
    body = (
      <div role="alert" className="flex items-center gap-1.5 p-4 text-sm text-destructive">
        <AlertCircle className="size-4" aria-hidden="true" />
        {t(($) => $.bg_tasks.load_failed)}
        <button type="button" onClick={tasks.retry} className="underline underline-offset-2 hover:text-foreground">
          {t(($) => $.bg_tasks.retry)}
        </button>
      </div>
    );
  } else if (!tasks.loaded) {
    body = (
      <div role="status" className="flex items-center gap-1.5 p-4 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{t(($) => $.bg_tasks.loading)}
      </div>
    );
  } else if (target.task) {
    body = row ? <BackgroundTaskDetail row={row} />
      : <div data-bg-not-found className="p-4 text-sm text-muted-foreground">{t(($) => $.bg_tasks.not_found)}</div>;
  } else {
    body = <BackgroundTasksOverview sessionId={target.sessionId} rows={tasks.rows} currentAttemptId={currentAttemptId}
      onOpen={(open) => setTask({ task_id: open.task_id, provider_session_id: open.provider_session_id })} />;
  }
  const footer = row ? <BackgroundTaskDetailFooter row={row} /> : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {target.task && row
        ? <BackgroundTaskDetailHeader sessionId={target.sessionId} row={row} back={<BackButton onBack={back} label={t(($) => $.bg_tasks.back)} />}
          close={<CloseButton onClose={onClose} />} />
        : <PanelHeader title={target.task ? <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{t(($) => $.bg_tasks.panel_title)}</h2> : title}
          back={target.task ? back : undefined} onClose={onClose} />}
      <div key={target.task?.task_id ?? ""} data-bg-panel-body className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      {footer && <div data-bg-panel-footer className="shrink-0 border-t px-4 py-2.5 text-xs text-muted-foreground">{footer}</div>}
    </div>
  );
}

function BackButton({ onBack, className, label: given }: { onBack: () => void; className?: string; label?: string }) {
  const { t } = useT("chat");
  const label = given ?? t(($) => $.subagents.back);
  return (
    <button type="button" data-subagent-panel-back aria-label={label} title={label} onClick={onBack} className={cn(ICON_BUTTON, className)}>
      <ArrowLeft className="size-4" aria-hidden="true" />
    </button>
  );
}

function CloseButton({ onClose, className }: { onClose: () => void; className?: string }) {
  const { t } = useT("chat");
  const label = t(($) => $.subagents.close);
  return (
    <button type="button" data-subagent-panel-close aria-label={label} title={`${label} (Esc)`} onClick={onClose} className={cn(ICON_BUTTON, className)}>
      <X className="size-4" aria-hidden="true" />
    </button>
  );
}

function DetailHeader({ item, items, onBack, onClose }: {
  item: TraceSubagentItem; items: readonly TraceItem[]; onBack: () => void; onClose: () => void;
}) {
  const { name, type } = subagentLabel(item);
  const task = subagentTaskLine(item);
  return (
    <div data-subagent-panel-header className="flex shrink-0 items-start gap-1.5 border-b py-2 pr-2 pl-2">
      <BackButton onBack={onBack} className="mt-0.5" />
      <div className="min-w-0 flex-1 py-0.5">
        <h2 className="truncate text-sm" title={task ? `${name} · ${task}` : name}>
          <span className="font-medium text-foreground">{name}</span>
          {task && <span className="text-muted-foreground"> · {task}</span>}
        </h2>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {type && <span data-subagent-type className="min-w-0 truncate">{type}</span>}
          <SubagentStatusText item={item} items={items} />
        </div>
      </div>
      <CloseButton onClose={onClose} className="mt-0.5" />
    </div>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

const RUNNING_SHOWN = 4;
const DONE_SHOWN = 10;

/**
 * Open until the reader closes it: the newest turn (the first group, and the
 * record's newest when the panel's own turn was put in front of it), the
 * running turn and the turn the panel was opened on. Older groups read their
 * trace only once opened.
 */
function groupOpenByDefault(turn: SubagentTurnRef, index: number, focused: string | null, newest: string | undefined): boolean {
  return index === 0 || turn.attemptId === newest || turn.live || turn.attemptId === focused;
}

/** The chat-wide overview: one group per turn that ran subagents, newest first. */
function ChatSubagentOverview({ turns, focused, isOpen, onToggle, onOpen }: {
  turns: readonly SubagentTurnRef[];
  focused: string | null;
  isOpen: (turn: SubagentTurnRef, index: number) => boolean;
  onToggle: (turn: SubagentTurnRef, open: boolean) => void;
  onOpen: (turn: SubagentTurnRef, path: string[]) => void;
}) {
  const { t } = useT("chat");
  if (!turns.length) return <div data-subagent-overview="empty" className="px-4 py-5 text-sm text-muted-foreground">{t(($) => $.subagents.chat_empty)}</div>;
  return (
    <div data-subagent-overview className="space-y-3 px-3 py-4">
      {turns.map((turn, index) => (
        <SubagentTurnGroup key={turn.attemptId} turn={turn} open={isOpen(turn, index)} reveal={turn.attemptId === focused && index > 0}
          onToggle={(open) => onToggle(turn, open)} onOpen={(path) => onOpen(turn, path)} />
      ))}
    </div>
  );
}

/**
 * One turn of the overview: a header (time · first words of the prompt, a
 * running count) that opens and closes it, and its top-level subagents in
 * 运行中 / 已完成 sections. Its trace is read when it is open.
 */
function SubagentTurnGroup({ turn, open, reveal, onToggle, onOpen }: {
  turn: SubagentTurnRef;
  open: boolean;
  /** Scroll it into view when it mounts: the turn the panel was opened on. */
  reveal: boolean;
  onToggle: (open: boolean) => void;
  onOpen: (path: string[]) => void;
}) {
  const { t, i18n } = useT("chat");
  const trace = useTurnTrace(turn.attemptId, { enabled: open, live: turn.live, turnId: turn.turnId });
  const items = trace.items;
  const agents = useMemo(() => topLevelSubagents(items), [items]);
  const running = agents.filter((item) => item.status === "in_progress");
  const done = agents.filter((item) => item.status !== "in_progress");
  const bodyId = useId();
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView?.({ block: "nearest" });
    // Only when the overview mounts with this turn in front.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const startedAt = turn.startedAt ?? parseTime(trace.turn?.started_at);
  const time = startedAt !== null ? formatBackgroundClock(startedAt, localeOf(i18n)) : null;
  const prompt = turn.prompt ?? tracePromptLine(items);
  const label = [time, prompt].filter(Boolean).join(" · ") || t(($) => $.subagents.turn_untitled);
  const openItem = (item: TraceSubagentItem) => onOpen(subagentPath(items, item.id));
  let body: ReactNode = null;
  if (open) {
    body = !agents.length && hasReadState(trace) ? <TraceReadState trace={trace} />
      : !agents.length ? <div data-subagent-turn-empty className="px-2 py-1.5 text-sm text-muted-foreground">{t(($) => $.subagents.panel_empty)}</div>
        : (
          <>
            {running.length > 0 && (
              <OverviewSection section="running" title={t(($) => $.subagents.panel_running, { count: running.length })}
                agents={running} shown={RUNNING_SHOWN} items={items} onOpen={openItem} />
            )}
            {done.length > 0 && (
              <OverviewSection section="done" title={t(($) => $.subagents.panel_done, { count: done.length })}
                agents={done} shown={DONE_SHOWN} items={items} onOpen={openItem} className={running.length > 0 ? "mt-4" : undefined} />
            )}
          </>
        );
  }
  return (
    <section ref={ref} data-subagent-turn={turn.attemptId} data-open={open ? "" : undefined} aria-label={label}>
      <button type="button" data-subagent-turn-header aria-expanded={open} aria-controls={open ? bodyId : undefined}
        onClick={() => onToggle(!open)} title={label}
        className="flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {time && <span className="tabular-nums">{time}</span>}
          {time && prompt && <span aria-hidden="true"> · </span>}
          {prompt && <span className="text-foreground/80">{prompt}</span>}
          {!time && !prompt && t(($) => $.subagents.turn_untitled)}
        </span>
        {running.length > 0 && (
          <span data-subagent-turn-running className="inline-flex shrink-0 items-center gap-1 text-brand">
            <LoaderCircle className={cn("size-3", SUBAGENT_SPIN)} aria-hidden="true" />
            {t(($) => $.subagents.strip_running_short, { count: running.length })}
          </span>
        )}
      </button>
      {open && <div id={bodyId} data-subagent-turn-body className="pt-1">{body}</div>}
    </section>
  );
}

function OverviewSection({ section, title, agents, shown, items, onOpen, className }: {
  section: "running" | "done";
  title: string;
  agents: TraceSubagentItem[];
  shown: number;
  items: readonly TraceItem[];
  onOpen: (item: TraceSubagentItem) => void;
  className?: string;
}) {
  const { t } = useT("chat");
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? agents : agents.slice(0, shown);
  const hidden = agents.length - shown;
  return (
    <section data-subagent-section={section} className={className}>
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="flex flex-col">
        {visible.map((item) => <OverviewRow key={item.id} item={item} items={items} onOpen={onOpen} />)}
      </div>
      {hidden > 0 && (
        <button type="button" data-subagent-show-more onClick={() => setExpanded(!expanded)}
          className="mt-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          {expanded ? t(($) => $.subagents.show_less) : t(($) => $.subagents.show_more, { count: hidden })}
        </button>
      )}
    </section>
  );
}

function OverviewRow({ item, items, onOpen }: { item: TraceSubagentItem; items: readonly TraceItem[]; onOpen: (item: TraceSubagentItem) => void }) {
  const { t } = useT("chat");
  const { name, type } = subagentLabel(item);
  const status = subagentStatus(item);
  const running = status === "running" || status === "background";
  const elapsed = useSubagentElapsed(item);
  const activity = useSubagentActivity(item, items);
  // Codex: the instructions, else what it does now, else 「处理中」.
  const second = subagentTaskLine(item) ?? (running ? activity ?? t(($) => $.subagents.working) : null);
  const Icon = status === "failed" ? CircleX : status === "stopped" ? CircleStop : Bot;
  return (
    <button type="button" data-subagent-overview-row={item.id} data-subagent-status={status} onClick={() => onOpen(item)}
      aria-label={t(($) => $.subagents.open, { name })}
      className="flex min-h-10 w-full min-w-0 flex-col justify-center gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-ring">
      <span className="flex w-full min-w-0 items-center gap-2 text-sm">
        <Icon className={cn("size-4 shrink-0 text-muted-foreground", status === "failed" && "text-destructive")} aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-foreground">{name}</span>
          {type && <span className="text-muted-foreground"> {type}</span>}
        </span>
        {status === "background" && (
          <span className="shrink-0 rounded bg-violet-500/10 px-1 text-[10px] leading-4 text-violet-700 dark:text-violet-300">
            {t(($) => $.subagents.strip_background)}
          </span>
        )}
        {elapsed != null && (
          <span className={cn("shrink-0 text-xs tabular-nums text-muted-foreground", running && "text-brand", status === "background" && "text-violet-700 dark:text-violet-300")}>
            {formatSubagentElapsed(elapsed)}
          </span>
        )}
      </span>
      {second && <span className="w-full truncate pl-6 text-sm text-muted-foreground">{second}</span>}
    </button>
  );
}

// ── Detail: a read-only mini conversation ───────────────────────────────────

function nonBlank(value: string | null | undefined): string | null {
  return value?.trim() ? value : null;
}

function SubagentDetail({ item, items, resolveBackgroundTask }: {
  item: TraceSubagentItem; items: readonly TraceItem[]; resolveBackgroundTask?: BackgroundTaskResolver;
}) {
  const { t } = useT("chat");
  const generations = useMemo(() => subagentGenerations(items, item), [items, item]);
  const status = subagentStatus(item);
  const running = status === "running" || status === "background";
  const last = generations[generations.length - 1]!;
  // A completed subagent's reply, else the output its parent received.
  const fallback = status === "completed" && !last.reply ? nonBlank(item.output) : null;
  const stoppedText = status === "stopped" ? nonBlank(last.reply?.text) ?? nonBlank(item.output) : null;
  const failure = status === "failed" ? subagentFailureText(items, item) : null;
  const meta = [item.model?.trim() ? t(($) => $.subagents.model, { model: item.model!.trim() }) : null,
    item.background === true ? t(($) => $.subagents.strip_background) : null].filter(Boolean).join(" · ");
  return (
    <div data-subagent-detail={item.id} className="space-y-4 px-4 py-5">
      {generations.map((generation, index) => (
        <GenerationView key={generation.key} generation={generation} item={item} items={items} first={index === 0}
          resolveBackgroundTask={resolveBackgroundTask}
          last={index === generations.length - 1}
          // The last generation's reply is the result only when it completed.
          showReply={index < generations.length - 1 || status === "completed"} />
      ))}
      {fallback && <ReplyView text={fallback} />}
      {running && <p data-subagent-pending className="text-sm text-muted-foreground">{t(($) => $.subagents.pending_result)}</p>}
      {status === "failed" && (
        <div role="alert" data-subagent-error className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-sm font-medium text-destructive">
            <CircleX className="size-4" aria-hidden="true" />{t(($) => $.subagents.error)}
          </div>
          {failure ? (
            <div className="max-h-60 overflow-auto rounded-md border border-destructive/25 bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">
              <Markdown mode="minimal">{failure}</Markdown>
            </div>
          ) : <p className="text-sm text-muted-foreground">{t(($) => $.subagents.no_error)}</p>}
        </div>
      )}
      {stoppedText && (
        <section data-subagent-stopped className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">{t(($) => $.subagents.stopped_output)}</h3>
          <div className={REPLY}><Markdown>{stoppedText}</Markdown></div>
        </section>
      )}
      {meta && <div data-subagent-meta className="text-xs text-muted-foreground">{meta}</div>}
    </div>
  );
}

function TaskBubble({ text, label }: { text: string; label: string | null }) {
  return (
    <div data-subagent-task className="flex flex-col items-end gap-1">
      {label && <div className="text-xs text-muted-foreground">{label}</div>}
      <div className="max-h-60 max-w-[85%] overflow-y-auto break-words rounded-[22px] bg-muted px-4 py-2.5 text-sm">
        <div className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          <Markdown>{text}</Markdown>
        </div>
      </div>
    </div>
  );
}

function ReplyView({ text }: { text: string }) {
  const { t } = useT("chat");
  return <section aria-label={t(($) => $.subagents.result)} data-subagent-reply className={REPLY}><Markdown>{text}</Markdown></section>;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** One generation: its instructions, its steps fold (timed by the generation) and its reply. */
function GenerationView({ generation, item, items, first, last, showReply, resolveBackgroundTask }: {
  generation: SubagentGeneration;
  item: TraceSubagentItem;
  items: readonly TraceItem[];
  first: boolean;
  last: boolean;
  showReply: boolean;
  resolveBackgroundTask?: BackgroundTaskResolver;
}) {
  const { t } = useT("chat");
  const headerText = useFoldHeaderText();
  const reply = showReply ? generation.reply : null;
  const steps = useMemo(() => buildChildSteps(items, item.id, { children: generation.children, excludeId: reply?.id, resolveBackgroundTask }),
    [items, item.id, generation.children, reply?.id, resolveBackgroundTask]);
  const label = useStickyLabel(generation.running ? liveLabel(steps) : null);
  const start = parseTime(generation.startedAt);
  const now = useTickingNow(generation.running && start !== null, start);
  // Like the chat's own turn: open while it works, folded once it answered.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const end = parseTime(generation.endedAt);
  const ms = start === null ? null : Math.max(0, (generation.running ? now : end ?? start) - start);
  const header: FoldHeader = ms === null ? { kind: "steps" }
    : generation.running ? (ms < 1000 ? { kind: "working" } : { kind: "working_for", ms })
      : last && subagentStatus(item) === "stopped" ? { kind: "stopped_after", ms } : { kind: "worked_for", ms };
  const hasSteps = steps.blocks.length > 0;
  return (
    <>
      {generation.prompt && <TaskBubble text={generation.prompt} label={first ? t(($) => $.subagents.task) : null} />}
      {(hasSteps || generation.running) && (
        <div data-subagent-steps={generation.key}>
          <StepsFold kind="live" title={headerText(header)} open={userOpen ?? generation.running} onOpenChange={setUserOpen}>
            <TurnStepList steps={steps} items={items}
              live={generation.running && label ? { label, blockKey: liveBlockKey(steps, label) } : undefined} />
          </StepsFold>
        </div>
      )}
      {reply && <ReplyView text={reply.text} />}
    </>
  );
}
