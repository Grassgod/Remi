"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDefaultLayout } from "react-resizable-panels";
import type { TraceItem, TraceSubagentItem } from "@multiremi/contracts/trace";
import { topLevelSubagents } from "@multiremi/shared/turn-trace";
import { useChatStore, type SubagentPanelTarget } from "@multiremi/core/chat";
import { defaultStorage } from "@multiremi/core/platform";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@multiremi/ui/components/ui/resizable";
import { Sheet, SheetContent } from "@multiremi/ui/components/ui/sheet";
import { useIsMobile } from "@multiremi/ui/hooks/use-mobile";
import { cn } from "@multiremi/ui/lib/utils";
import { AlertCircle, ArrowLeft, Bot, CircleStop, CircleX, LoaderCircle, X } from "lucide-react";
import { Markdown } from "../../common/markdown";
import { useTurnTrace } from "../../common/task-transcript/use-task-trace";
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
import { buildChildSteps, liveBlockKey, liveLabel, type FoldHeader } from "../lib/turn-steps";
import { useStickyLabel, useTickingNow } from "./live-hooks";
import { SubagentTraceContext, type SubagentTraceSource } from "./subagent-context";
import { formatSubagentElapsed, SubagentStatusText, useSubagentElapsed } from "./subagent-step-row";
import { useSubagentActivity } from "./subagent-running-strip";
import { TurnStepList } from "./turn-step-list";
import { REPLY, StepsFold, useFoldHeaderText } from "./turn-steps-fold";

// The subagent panel (PR 5 §6.6), after the Codex right panel (behaviour
// only, `codex-notes/5-子代理抽屉.md`):
// - On the Chat page it sits right of the conversation in a resizable split
//   and pushes it narrower; the split is remembered (`useDefaultLayout`).
//   When the conversation cannot keep 352px beside a 320px panel it covers
//   the conversation instead, under 768px it is a full-width sheet, and in
//   the floating chat window it covers the window.
// - One panel per chat, showing the attempt it was opened from: an overview
//   (运行中 · n / 已完成 · n, top-level subagents) and a subagent's detail, a
//   read-only mini conversation (task bubble, steps, reply) that updates
//   live. Nested subagents open a deeper detail; ← goes up one level.
// - × or Esc (focus inside) closes it, and so do switching chats and closing
//   the floating window; a click in the conversation does not.

/** The conversation keeps this much beside the panel (Codex). */
export const CONVERSATION_MIN_PX = 352;
export const SUBAGENT_PANEL_MIN_PX = 320;
const LAYOUT_ID = "chat-subagent-panel";

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
 * Lays the conversation out with the subagent panel. The conversation stays
 * mounted whether the panel is open or not, so its scroll position and
 * composer survive opening and closing it.
 */
export function SubagentPanelLayout({ sessionId, presentation, visible = true, children }: {
  sessionId: string | null;
  presentation: "page" | "window";
  /** The chat is on screen; closing the floating window closes the panel. */
  visible?: boolean;
  children: ReactNode;
}) {
  const target = useSubagentPanelTarget(sessionId, visible);
  const close = useChatStore((s) => s.closeSubagentPanel);
  const isMobile = useIsMobile();
  const [groupRef, groupWidth] = useElementWidth<HTMLDivElement>();
  const mode = presentation === "window" ? "overlay"
    : isMobile ? "sheet"
      : groupWidth >= CONVERSATION_MIN_PX + SUBAGENT_PANEL_MIN_PX ? "split" : "overlay";
  const split = mode === "split" && !!target;
  const panelIds = useMemo(() => split ? ["conversation", "subagents"] : ["conversation"], [split]);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: LAYOUT_ID, panelIds, storage: defaultStorage });
  const overlay = mode === "overlay" && target
    ? <div data-subagent-panel-mode="overlay" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background">
      <SubagentPanelView target={target} onClose={close} />
    </div>
    : null;

  if (presentation === "window") return <>{children}{overlay}</>;
  return (
    <div ref={groupRef} className="flex min-h-0 min-w-0 flex-1">
      <ResizablePanelGroup id={LAYOUT_ID} orientation="horizontal" className="min-h-0 flex-1"
        defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <ResizablePanel id="conversation" minSize={CONVERSATION_MIN_PX} className="relative flex min-h-0 flex-col">
          {children}
          {overlay}
        </ResizablePanel>
        {split && target && (
          <>
            <SubagentPanelHandle />
            <ResizablePanel id="subagents" defaultSize="40%" minSize={SUBAGENT_PANEL_MIN_PX} className="flex min-h-0 flex-col">
              <div data-subagent-panel-mode="split" className="flex h-full min-h-0 flex-col border-l bg-background motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200">
                <SubagentPanelView target={target} onClose={close} />
              </div>
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      {mode === "sheet" && (
        <Sheet open={!!target} onOpenChange={(open) => { if (!open) close(); }}>
          <SheetContent side="right" showCloseButton={false} data-subagent-panel-mode="sheet"
            className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none">
            {target && <SubagentPanelView target={target} onClose={close} focusOnMount={false} />}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function SubagentPanelHandle() {
  const { t } = useT("chat");
  return <ResizableHandle aria-label={t(($) => $.subagents.resize)} />;
}

const ICON_BUTTON = "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/** The panel's own view: header, the overview or a detail, and the read-only note. */
export function SubagentPanelView({ target, onClose, focusOnMount = true }: {
  target: SubagentPanelTarget;
  onClose: () => void;
  /** Take focus when it opens, so Esc closes it at once (the sheet's dialog focuses itself). */
  focusOnMount?: boolean;
}) {
  const { t } = useT("chat");
  const { t: ta } = useT("agents");
  const setPath = useChatStore((s) => s.setSubagentPath);
  const trace = useTurnTrace(target.attemptId, { live: target.live, turnId: target.turnId });
  const items = trace.items;
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusOnMount) rootRef.current?.focus({ preventScroll: true });
  }, [focusOnMount]);
  const currentId = target.path.at(-1);
  const current = currentId ? items.find((item) => item.id === currentId) : undefined;
  const detail = target.path.length > 0;
  const source = useMemo<SubagentTraceSource>(() => ({
    sessionId: target.sessionId, attemptId: target.attemptId, turnId: target.turnId, live: target.live,
  }), [target.sessionId, target.attemptId, target.turnId, target.live]);
  const read = trace.read;
  // While pages are still arriving, a subagent that is not there yet (it may
  // be on a later page) and an empty list both mean "loading".
  const missing = detail ? !isSubagent(current) : !items.some((item) => item.type === "subagent" && item.parent_id === null);
  // A live attempt's first read can land before the daemon has a trace for it
  // (`not_found`); the stream then supplies every item. A read that is not ok
  // only explains a view with nothing to show.
  const unavailable = read && read.state !== "ok" && missing
    ? read.state === "unreachable" ? ta(($) => $.transcript.trace_unreachable, { name: read.runtime_name ?? read.runtime_id ?? "" })
      : read.state === "lost" ? ta(($) => $.transcript.trace_lost) : ta(($) => $.transcript.trace_not_found)
    : null;
  let body: ReactNode;
  if (trace.error && (!items.length || missing)) {
    body = (
      <div role="alert" className="flex items-center gap-1.5 p-4 text-sm text-destructive">
        <AlertCircle className="size-4" aria-hidden="true" />
        {t(($) => $.turn_steps.load_failed)}
        <button type="button" onClick={trace.retry} className="underline underline-offset-2 hover:text-foreground">
          {t(($) => $.turn_steps.retry)}
        </button>
      </div>
    );
  } else if (!trace.loaded && (!items.length || missing)) {
    body = (
      <div role="status" className="flex items-center gap-1.5 p-4 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{t(($) => $.subagents.loading)}
      </div>
    );
  } else if (unavailable) {
    body = <div className="p-4 text-sm text-muted-foreground">{unavailable}</div>;
  } else if (detail) {
    body = isSubagent(current)
      ? <SubagentDetail key={current.id} item={current} items={items} />
      : <div data-subagent-not-found className="p-4 text-sm text-muted-foreground">{t(($) => $.subagents.not_found)}</div>;
  } else {
    body = <SubagentOverview items={items} onOpen={(item) => setPath(subagentPath(items, item.id))} />;
  }
  return (
    <section
      ref={rootRef}
      tabIndex={-1}
      aria-label={t(($) => $.subagents.panel_title)}
      data-subagent-panel={detail ? "detail" : "overview"}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        onClose();
      }}
      className="flex h-full min-h-0 flex-col bg-background outline-none"
    >
      {detail && isSubagent(current)
        ? <DetailHeader item={current} items={items} onBack={() => setPath(target.path.slice(0, -1))} onClose={onClose} />
        : (
          <div data-subagent-panel-header className="flex h-12 shrink-0 items-center gap-1.5 border-b pr-2 pl-2">
            {detail && <BackButton onBack={() => setPath(target.path.slice(0, -1))} />}
            <h2 className={cn("min-w-0 flex-1 truncate text-sm font-medium", !detail && "pl-2")}>{t(($) => $.subagents.panel_title)}</h2>
            <CloseButton onClose={onClose} />
          </div>
        )}
      <SubagentTraceContext.Provider value={source}>
        <div key={target.path.join("/")} data-subagent-panel-body className="min-h-0 flex-1 overflow-y-auto">{body}</div>
      </SubagentTraceContext.Provider>
      <div data-subagent-panel-footer className="shrink-0 border-t px-4 py-2.5 text-xs text-muted-foreground">
        {t(($) => $.subagents.read_only)}
      </div>
    </section>
  );
}

function BackButton({ onBack, className }: { onBack: () => void; className?: string }) {
  const { t } = useT("chat");
  const label = t(($) => $.subagents.back);
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

function SubagentOverview({ items, onOpen }: { items: readonly TraceItem[]; onOpen: (item: TraceSubagentItem) => void }) {
  const { t } = useT("chat");
  const agents = useMemo(() => topLevelSubagents(items), [items]);
  const running = agents.filter((item) => item.status === "in_progress");
  const done = agents.filter((item) => item.status !== "in_progress");
  if (!agents.length) return <div data-subagent-overview="empty" className="px-4 py-5 text-sm text-muted-foreground">{t(($) => $.subagents.panel_empty)}</div>;
  return (
    <div data-subagent-overview className="px-3 py-5">
      {running.length > 0 && (
        <OverviewSection section="running" title={t(($) => $.subagents.panel_running, { count: running.length })}
          agents={running} shown={RUNNING_SHOWN} items={items} onOpen={onOpen} />
      )}
      {done.length > 0 && (
        <OverviewSection section="done" title={t(($) => $.subagents.panel_done, { count: done.length })}
          agents={done} shown={DONE_SHOWN} items={items} onOpen={onOpen} className={running.length > 0 ? "mt-6" : undefined} />
      )}
    </div>
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

function SubagentDetail({ item, items }: { item: TraceSubagentItem; items: readonly TraceItem[] }) {
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
function GenerationView({ generation, item, items, first, last, showReply }: {
  generation: SubagentGeneration;
  item: TraceSubagentItem;
  items: readonly TraceItem[];
  first: boolean;
  last: boolean;
  showReply: boolean;
}) {
  const { t } = useT("chat");
  const headerText = useFoldHeaderText();
  const reply = showReply ? generation.reply : null;
  const steps = useMemo(() => buildChildSteps(items, item.id, { children: generation.children, excludeId: reply?.id }),
    [items, item.id, generation.children, reply?.id]);
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
