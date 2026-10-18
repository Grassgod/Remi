"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { TraceItem, TraceItemOf, TraceTurn } from "@multiremi/contracts/trace";
import { finalItem, turnTraceStats } from "@multiremi/shared/turn-trace";
import {
  Bot,
  CheckCircle2,
  XCircle,
  X,
  Loader2,
  Clock,
  Copy,
  Check,
  Monitor,
  Cloud,
  Cpu,
  Filter,
  Folder,
  Coins,
  FileInput,
  ScrollText,
  ChevronRight,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@multiremi/ui/lib/utils";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { Dialog, DialogContent, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { Markdown } from "../markdown";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { ActorAvatar } from "../actor-avatar";
import {
  LIVE_TIMER,
  formatElapsedMs,
  formatElapsedSince,
  formatTokens,
} from "../format";
import { api } from "@multiremi/core/api";
import { useTranscriptViewStore } from "@multiremi/core/agents/stores";
import type { AgentTask, Agent, AgentRuntime } from "@multiremi/core/types/agent";
import { redactItem } from "./redact";
import { useT } from "../../i18n";
import {
  formatProvider,
  getItemLabel,
  getItemSummary,
  itemFilterKey,
  usageSnapshotFromTask,
} from "./event-format";
import { MetadataChip } from "./metadata-chip";
import { SortDirectionToggle } from "./sort-direction-toggle";
import { TimelineBar } from "./timeline-bar";
import { PlanEntries, TranscriptItemRow } from "./transcript-item-row";
import { ExecutionModelInfo } from "./execution-model-info";
import type { TurnTraceReadInfo } from "./use-task-trace";

interface AgentTranscriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: AgentTask;
  /** The trace's turn; model and context usage come from it. */
  turn?: TraceTurn | null;
  /** Every item of the trace, at any depth; subagent items nest their own. */
  items: readonly TraceItem[];
  agentName: string;
  isLive?: boolean;
  /**
   * Optional content rendered between the header chips and the event list.
   * Used by autopilot run rows to surface the inbound webhook trigger
   * payload so it's visible regardless of whether the agent echoes it.
   * The dialog stays generic — slot content is the caller's concern.
   */
  headerSlot?: React.ReactNode;
  /** Assignment content supplied by callers that own a turn, used only on prompt 404. */
  promptFallback?: React.ReactNode;
  initialView?: "execution" | "prompt";
  traceRead?: TurnTraceReadInfo | null;
  traceClosed?: boolean;
  traceLoading?: boolean;
  traceError?: boolean;
  onTraceRetry?: () => void;
}

// ─── Color mapping for timeline segments ────────────────────────────────────

/** Task states after which no step can still be running. */
const TERMINAL_TASK_STATUS = new Set<string>(["completed", "failed", "cancelled"]);

const NO_CHILDREN: readonly TraceItem[] = [];

// ─── Main dialog ────────────────────────────────────────────────────────────

export function AgentTranscriptDialog({
  open,
  onOpenChange,
  task,
  turn = null,
  items: rawItems,
  agentName,
  isLive = false,
  headerSlot,
  promptFallback,
  initialView = "execution",
  traceRead: readInfo,
  traceClosed = false,
  traceLoading = false,
  traceError = false,
  onTraceRetry,
}: AgentTranscriptDialogProps) {
  const { t } = useT("agents");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedWorkdir, setCopiedWorkdir] = useState(false);
  const [activeView, setActiveView] = useState<"execution" | "prompt">(initialView);
  const [promptCopied, setPromptCopied] = useState(false);
  const [agentInfo, setAgentInfo] = useState<Agent | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<AgentRuntime | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const sortDirection = useTranscriptViewStore((s) => s.sortDirection);
  const setSortDirection = useTranscriptViewStore((s) => s.setSortDirection);
  const eventRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // The turn's input for this attempt: exactly what it sent the agent when
  // recorded, else the turn's messages. The attempt is always named: the
  // first attempt has the turn's id, and the turn alone answers with its
  // current attempt, which after a retry is a later one.
  const promptTurnId = task.turn_id ?? task.id;
  const promptAttemptId = task.turn_id ? task.id : undefined;
  const promptQuery = useQuery({
    queryKey: ["task-prompt", task.id],
    queryFn: () => (promptAttemptId ? api.getTurnInput(promptTurnId, promptAttemptId) : api.getTurnInput(promptTurnId)),
    enabled: open && activeView === "prompt",
    retry: false,
    staleTime: Infinity,
  });

  // Redact for display and copy; ids, statuses and times stay intact.
  // `redactItem` caches per item, and the reducer keeps the identity of an
  // item that did not change, so a live frame redacts only what it touched.
  const items = useMemo(() => rawItems.map(redactItem), [rawItems]);
  // A read that is not ok explains only a trace with nothing in it: the cache
  // can hold a live view's first read (`not_found` before the daemon claimed
  // the attempt) while the stream supplied every item.
  const traceRead = readInfo && readInfo.state !== "ok" && items.length > 0 ? null : readInfo;
  // One pass builds the top level and the parent → children index. Top level:
  // items without a parent, or whose parent is not in the trace (fail open).
  const childrenIndex = useRef(new Map<string, readonly TraceItem[]>());
  const { topItems, childrenOf } = useMemo(() => {
    const ids = new Set<string>();
    for (const item of items) ids.add(item.id);
    const top: TraceItem[] = [];
    const groups = new Map<string, TraceItem[]>();
    for (const item of items) {
      if (item.parent_id === null || !ids.has(item.parent_id)) top.push(item);
      else {
        const siblings = groups.get(item.parent_id);
        if (siblings) siblings.push(item); else groups.set(item.parent_id, [item]);
      }
    }
    // Keep a parent's array when its children did not change, so its
    // memoized row does not re-render.
    const previous = childrenIndex.current;
    const next = new Map<string, readonly TraceItem[]>();
    for (const [parentId, children] of groups) {
      const before = previous.get(parentId);
      next.set(parentId, before && before.length === children.length && before.every((child, i) => child === children[i]) ? before : children);
    }
    childrenIndex.current = next;
    return { topItems: top, childrenOf: next };
  }, [items]);

  // Steers the agent received during this attempt: what it was sent after its
  // first prompt. A steer that was never delivered did not reach it.
  const promptSteers = useMemo(
    () => topItems.filter((item): item is TraceItemOf<"user_message"> =>
      item.type === "user_message" && item.origin === "steer" && item.steer?.injected !== false && item.text.trim() !== ""),
    [topItems],
  );
  const promptInput = promptQuery.data ?? null;
  const promptShown = !!promptInput && (promptInput.prompt.trim() !== "" || promptSteers.length > 0);
  // Not recorded: no such turn (404), or a turn with nothing to show.
  const promptNotRecorded = Boolean(
    promptQuery.error
    && typeof promptQuery.error === "object"
    && "status" in promptQuery.error
    && promptQuery.error.status === 404,
  ) || (promptQuery.isSuccess && !promptShown);
  const chatPrompt = Boolean(task.chat_session_id);

  // Filter options: tool items by their tool ("tool:Bash"), the rest by type.
  const filterOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const item of topItems) {
      const key = itemFilterKey(item);
      if (!options.has(key)) options.set(key, key.startsWith("tool:") ? key : getItemLabel(item));
    }
    return Array.from(options.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [topItems]);

  // Strict filter, top level only: a subagent keeps all of its own steps.
  const filteredItems = useMemo(() => {
    if (selectedTools.size === 0) return topItems;
    return topItems.filter((item) => selectedTools.has(itemFilterKey(item)));
  }, [topItems, selectedTools]);

  // Apply user-chosen sort direction. Reverse is a pure presentation concern —
  // the underlying timeline (and its seq numbers) is untouched, so copy/filter
  // and segment navigation continue to work against the same data.
  const displayItems = useMemo(
    () => (sortDirection === "newest_first" ? [...filteredItems].reverse() : filteredItems),
    [filteredItems, sortDirection],
  );

  // Toggling direction is a manual user action; jump the scroll container back
  // to the top so the newest end of the timeline (per the chosen direction) is
  // immediately visible. Avoids stranding the user mid-scroll on the wrong end.
  const handleSortDirectionChange = useCallback(
    (dir: typeof sortDirection) => {
      if (dir === sortDirection) return;
      setSortDirection(dir);
      scrollContainerRef.current?.scrollTo({ top: 0 });
    },
    [sortDirection, setSortDirection],
  );

  // Fetch agent and runtime metadata when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAgentInfo(null);

    if (task.agent_id) {
      api.getAgent(task.agent_id).then((agent) => {
        if (!cancelled) setAgentInfo(agent);
      }).catch(() => {});
    }

    if (task.runtime_id) {
      api.listRuntimes().then((runtimes) => {
        if (cancelled) return;
        const rt = runtimes.find((r) => r.id === task.runtime_id);
        if (rt) setRuntimeInfo(rt);
      }).catch(() => {});
    }

    return () => { cancelled = true; };
  }, [open, task.agent_id, task.runtime_id]);

  // Elapsed time for live tasks
  useEffect(() => {
    if (!isLive || (!task.started_at && !task.dispatched_at)) return;
    const startRef = task.started_at ?? task.dispatched_at!;
    const update = () => setElapsed(formatElapsedSince(startRef, Date.now(), LIVE_TIMER));
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [isLive, task.started_at, task.dispatched_at]);

  const childrenRef = useRef(childrenOf);
  childrenRef.current = childrenOf;
  const getChildren = useCallback((id: string) => childrenRef.current.get(id) ?? NO_CHILDREN, []);

  // A subagent row registers for its own items too: they have no row while it
  // is collapsed, and timeline navigation must still land on them.
  const registerRow = useCallback((id: string, element: HTMLDivElement | null) => {
    if (element) eventRefs.current.set(id, element);
    else eventRefs.current.delete(id);
  }, []);

  const handleSegmentClick = useCallback((id: string) => {
    setSelectedId(id);
    eventRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // Live-follow: the transcript is tailing a running task. Also gates the
  // auto-expansion of running subagent groups.
  const liveFollow = isLive && sortDirection === "chronological";
  // A finished task can't have running steps; `isLive` wins so a task whose
  // status has landed while the stream is still open keeps its spinners.
  const taskTerminal = !isLive && (traceClosed || TERMINAL_TASK_STATUS.has(task.status));

  // Follow the newest events while a task is live, but only when the user is
  // already parked near the bottom — scrolling up to read history pauses the
  // auto-follow (standard log-tail behavior). Only in chronological order.
  const lastItemSeq = items.length > 0 ? items[items.length - 1]!.seq ?? items.length : null;
  useEffect(() => {
    if (!isLive || sortDirection !== "chronological") return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight });
  }, [lastItemSeq, isLive, sortDirection]);

  // Copy all events as text. Use the displayed order so users get the same
  // sequence they see on screen — matters when sort is set to newest-first.
  const handleCopyWorkdir = useCallback(() => {
    if (!task.relative_work_dir) return;
    void copyText(task.relative_work_dir).then((ok) => {
      if (!ok) return;
      setCopiedWorkdir(true);
      setTimeout(() => setCopiedWorkdir(false), 2000);
    });
  }, [task.relative_work_dir]);

  const handleCopyAll = useCallback(() => {
    // The displayed order, with a subagent's own items indented under it.
    const lines: string[] = [];
    const add = (item: TraceItem, depth: number) => {
      lines.push(`${"  ".repeat(depth)}[${getItemLabel(item)}] ${getItemSummary(item)}`);
      for (const child of childrenOf.get(item.id) ?? []) add(child, depth + 1);
    };
    for (const item of displayItems) add(item, 0);
    void copyText(lines.join("\n")).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [displayItems, childrenOf]);

  const handleCopyPrompt = useCallback(() => {
    const prompt = promptQuery.data?.prompt;
    if (!prompt) return;
    void copyText(prompt).then((ok) => {
      if (!ok) return;
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 2000);
    });
  }, [promptQuery.data?.prompt]);

  // Toggle tool filter
  const toggleTool = useCallback((tool: string) => {
    setSelectedTools((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setSelectedTools(new Set());
  }, []);

  // Duration
  const duration =
    task.started_at && task.completed_at
      ? formatElapsedMs(
          new Date(task.completed_at).getTime() -
            new Date(task.started_at).getTime(),
          LIVE_TIMER,
        )
      : isLive
        ? elapsed
        : null;

  // The single tool-count rule: a finished turn's stats, else the same count
  // over the items read so far.
  const liveToolCount = useMemo(() => turnTraceStats(items).tool_call_count, [items]);
  const toolCount = turn && turn.status !== "running" ? turn.stats.tool_call_count : liveToolCount;
  const contextUsage = turn?.context_usage ?? null;

  // Header token rollup (server-provided) + the agent's final reply, surfaced
  // above the event list so the outcome isn't buried in a one-line summary.
  const usage = useMemo(() => usageSnapshotFromTask(task), [task]);
  const [answerCopied, setAnswerCopied] = useState(false);
  // The final reply is the item the daemon marked final; it is never a child's.
  const finalAnswer = useMemo(() => {
    const final = finalItem(items, turn?.final_item_id);
    return final && final.parent_id === null && final.text.trim() ? final.text : null;
  }, [items, turn?.final_item_id]);
  const handleCopyAnswer = useCallback(() => {
    if (!finalAnswer) return;
    void copyText(finalAnswer).then((ok) => {
      if (!ok) return;
      setAnswerCopied(true);
      setTimeout(() => setAnswerCopied(false), 2000);
    });
  }, [finalAnswer]);

  const entries = displayItems;
  const planEntries = useMemo(() => {
    for (let i = topItems.length - 1; i >= 0; i--) {
      const item = topItems[i]!;
      if (item.type === "plan") return item.entries;
    }
    return null;
  }, [topItems]);

  const statusDisplay = task.status === "queued"
    ? { label: t(($) => $.transcript.status_queued), icon: Clock, tone: "bg-muted text-muted-foreground", spins: false }
    : task.status === "dispatched"
      ? { label: t(($) => $.transcript.status_dispatched), icon: task.queue_blocker ? Clock : Loader2, tone: task.queue_blocker ? "bg-muted text-muted-foreground" : "bg-info/15 text-info", spins: !task.queue_blocker }
      : task.status === "waiting_local_directory"
        ? { label: t(($) => $.transcript.status_waiting_local_directory), icon: Clock, tone: "bg-muted text-muted-foreground", spins: false }
        : task.status === "running"
          ? { label: t(($) => $.transcript.status_running), icon: Loader2, tone: "bg-info/15 text-info", spins: true }
          : task.status === "awaiting_human"
            ? { label: t(($) => $.transcript.status_awaiting_human), icon: Clock, tone: "bg-success/15 text-success", spins: false }
          : task.status === "completed"
            ? { label: t(($) => $.transcript.status_completed), icon: CheckCircle2, tone: "bg-success/15 text-success", spins: false }
            : task.status === "failed"
              ? { label: t(($) => $.transcript.status_failed), icon: XCircle, tone: "bg-destructive/15 text-destructive", spins: false }
              : task.status === "cancelled"
                ? { label: t(($) => $.transcript.status_cancelled), icon: XCircle, tone: "bg-muted text-muted-foreground", spins: false }
                : { label: task.status, icon: null, tone: "bg-muted text-muted-foreground", spins: false };
  const StatusIcon = statusDisplay.icon;
  const statusBadge = (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", statusDisplay.tone)}>
      {StatusIcon ? <StatusIcon className={cn("h-3 w-3", statusDisplay.spins && !taskTerminal && "animate-spin")} /> : null}
      {statusDisplay.label}
    </span>
  );
  const emptyStateLabel = task.status === "queued"
    ? t(($) => $.transcript.waiting_dispatch)
    : task.status === "dispatched"
      ? t(($) => $.transcript.waiting_start)
      : task.status === "waiting_local_directory"
        ? t(($) => $.transcript.waiting_local_directory)
        : task.status === "awaiting_human"
          ? t(($) => $.transcript.waiting_human)
        : isLive
          ? t(($) => $.transcript.waiting_events)
          : null;
  const emptyStateSpins = !taskTerminal && ((task.status === "dispatched" && !task.queue_blocker) || (task.status === "running" && isLive));
  const traceUnavailable = traceError || (!!traceRead && traceRead.state !== "ok");
  const legacyTrace = traceRead?.format === "legacy";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!max-w-[896px] !w-[calc(100vw-48px)] !h-[min(720px,calc(100dvh-48px))] flex flex-col !p-0 !gap-0 overflow-hidden max-md:!w-screen max-md:!h-dvh max-md:!max-h-dvh max-md:!rounded-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{t(($) => $.transcript.dialog_title)}</DialogTitle>

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="border-b px-4 py-3 shrink-0 space-y-2">
          {/* Top row: agent name, status, actions */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              {task.agent_id ? (
                <ActorAvatar actorType="agent" actorId={task.agent_id} size={24} />
              ) : (
                <div className="flex items-center justify-center h-6 w-6 rounded-full bg-info/10 text-info">
                  <Bot className="h-3.5 w-3.5" />
                </div>
              )}
              <span className="font-medium text-sm">{agentName}</span>
            </div>

            {statusBadge}

            <div className="inline-flex h-8 items-center rounded-md bg-muted p-[3px] text-xs">
              <button
                type="button"
                onClick={() => setActiveView("execution")}
                aria-pressed={activeView === "execution"}
                className={cn(
                  "inline-flex h-full items-center gap-1.5 rounded px-2.5 text-muted-foreground transition-colors",
                  activeView === "execution" && "bg-background text-foreground shadow-sm",
                )}
              >
                <ScrollText className="h-3.5 w-3.5" />
                {t(($) => $.transcript.execution_view)}
              </button>
              <button
                type="button"
                onClick={() => setActiveView("prompt")}
                aria-pressed={activeView === "prompt"}
                className={cn(
                  "inline-flex h-full items-center gap-1.5 rounded px-2.5 text-muted-foreground transition-colors",
                  activeView === "prompt" && "bg-background text-foreground shadow-sm",
                )}
              >
                <FileInput className="h-3.5 w-3.5" />
                {t(($) => $.transcript.prompt_view)}
              </button>
            </div>

            <div className="ml-auto flex items-center gap-1">
              {activeView === "execution" && topItems.length > 1 && (
                <SortDirectionToggle
                  value={sortDirection}
                  onChange={handleSortDirectionChange}
                  labels={{
                    chronological: t(($) => $.transcript.sort_chronological),
                    newestFirst: t(($) => $.transcript.sort_newest_first),
                    ariaLabel: t(($) => $.transcript.sort_label),
                  }}
                />
              )}
              {activeView === "execution" && filterOptions.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={cn(
                      "flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors",
                      selectedTools.size > 0
                        ? "text-blue-600 dark:text-blue-400 bg-blue-500/10 hover:bg-blue-500/20"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent",
                    )}
                  >
                    <Filter className="h-3 w-3" />
                    {t(($) => $.transcript.filter)}
                    {selectedTools.size > 0 && (
                      <span className="ml-0.5 rounded-full bg-blue-500/20 px-1.5 py-0 text-[10px] font-medium">
                        {selectedTools.size}
                      </span>
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-auto">
                    {filterOptions.map(([value, label]) => (
                      <DropdownMenuCheckboxItem
                        key={value}
                        checked={selectedTools.has(value)}
                        onCheckedChange={() => toggleTool(value)}
                      >
                        {label}
                      </DropdownMenuCheckboxItem>
                    ))}
                    {selectedTools.size > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={clearFilters} className="text-muted-foreground">
                          {t(($) => $.transcript.clear_filters)}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {activeView === "execution" ? (
                <button
                  type="button"
                  onClick={handleCopyAll}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? t(($) => $.transcript.copied) : selectedTools.size > 0 ? t(($) => $.transcript.copy_filtered) : t(($) => $.transcript.copy_all)}
                </button>
              ) : promptQuery.data?.prompt ? (
                <button
                  type="button"
                  onClick={handleCopyPrompt}
                  className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  {promptCopied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {promptCopied ? t(($) => $.transcript.copied) : t(($) => $.transcript.copy_prompt)}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Metadata chips row */}
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {/* Runtime provider */}
            {runtimeInfo?.provider && (
              <MetadataChip icon={<Cpu className="h-3 w-3" />}>
                {formatProvider(runtimeInfo.provider)}
              </MetadataChip>
            )}

            {/* Runtime environment */}
            {runtimeInfo && (
              <MetadataChip
                icon={runtimeInfo.runtime_mode === "cloud" ? <Cloud className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
              >
                {runtimeInfo.name}
                <span className="text-muted-foreground/60 ml-0.5">({runtimeInfo.runtime_mode})</span>
              </MetadataChip>
            )}

            {/* Agent type / description */}
            {agentInfo?.description && (
              <MetadataChip icon={<Bot className="h-3 w-3" />}>
                {agentInfo.description.length > 40 ? agentInfo.description.slice(0, 40) + "..." : agentInfo.description}
              </MetadataChip>
            )}

            {/* Duration */}
            {duration && (
              <MetadataChip icon={<Clock className="h-3 w-3" />}>
                {duration}
              </MetadataChip>
            )}

            {/* Event counts */}
            {toolCount > 0 && (
              <MetadataChip>{t(($) => $.transcript.tool_calls, { count: toolCount })}</MetadataChip>
            )}
            <MetadataChip>
              {selectedTools.size > 0
                ? t(($) => $.transcript.events_filtered, { shown: filteredItems.length, total: topItems.length })
                : t(($) => $.transcript.events, { count: items.length })}
            </MetadataChip>

            {/* Token usage — input→output when the bridge splits them, else the
                ACP context total. cost intentionally omitted (not on the wire). */}
            {usage && (usage.inputTokens || usage.outputTokens || !contextUsage) && (
              <MetadataChip icon={<Coins className="h-3 w-3" />}>
                {usage.inputTokens || usage.outputTokens
                  ? `${formatTokens(usage.inputTokens ?? 0)}→${formatTokens(usage.outputTokens ?? 0)}`
                  : usage.totalTokens
                    ? t(($) => $.transcript.tokens_context, { value: formatTokens(usage.totalTokens) })
                    : null}
              </MetadataChip>
            )}
            {contextUsage && (
              <MetadataChip>
                {t(($) => $.transcript.context_usage, {
                  value: contextUsage.size > 0
                    ? `${formatTokens(contextUsage.used)} / ${formatTokens(contextUsage.size)}`
                    : formatTokens(contextUsage.used),
                })}
              </MetadataChip>
            )}
            <ExecutionModelInfo task={task} traceModel={turn?.model} agentModel={agentInfo?.model} agentThinkingLevel={agentInfo?.thinking_level} />

            {/* Working directory — server-derived display path. Falls back to
                nothing when older backends omit the field rather than rendering
                `work_dir` raw and leaking the user's home directory. The
                absolute `task.work_dir` deliberately never reaches the DOM
                anywhere — only `relative_work_dir` is safe to render / put in
                title / copy to clipboard, because the server has already
                stripped $HOME and the username out of it. The button
                truncates because real workdir paths are routinely long
                enough to push every other chip off the row. */}
            {task.relative_work_dir && (
              <button
                type="button"
                onClick={handleCopyWorkdir}
                title={task.relative_work_dir}
                className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {copiedWorkdir ? (
                  <Check className="h-3 w-3 shrink-0 text-emerald-500" />
                ) : (
                  <Folder className="h-3 w-3 shrink-0" />
                )}
                <span className="truncate font-mono">{task.relative_work_dir}</span>
              </button>
            )}

            {/* Created time */}
            {task.created_at && (
              <MetadataChip>
                {new Date(task.created_at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </MetadataChip>
            )}
          </div>
        </div>

        {headerSlot && <div className="shrink-0 border-b bg-muted/20 px-4 py-3">{headerSlot}</div>}

        {onTraceRetry && activeView === "execution" && (
          <div
            role={traceError || traceRead?.state === "unreachable" ? "alert" : "status"}
            className={cn(
              "flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-1 text-xs text-muted-foreground",
              (traceError || traceRead?.state === "unreachable") && "h-16 max-md:h-[88px]",
            )}
          >
            {traceLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
            <span className="min-w-0 flex-1">
              {traceError ? t(($) => $.transcript.trace_failed) : traceLoading && !traceRead ? t(($) => $.transcript.trace_loading)
                : traceRead?.state === "unreachable"
                  ? t(($) => $.transcript.trace_unreachable, { name: traceRead.runtime_name ?? traceRead.runtime_id ?? "" })
                  : traceRead?.state === "lost" ? t(($) => $.transcript.trace_lost)
                  : traceRead?.state === "not_found" ? t(($) => $.transcript.trace_not_found)
                  : legacyTrace ? null
                  : traceClosed ? t(($) => $.transcript.trace_finished, { count: items.length })
                  : t(($) => $.transcript.trace_live)}
              {traceRead?.state === "unreachable" && traceRead.last_seen_at && (
                <span className="block">{t(($) => $.transcript.trace_last_seen, { time: new Date(traceRead.last_seen_at).toLocaleString() })}</span>
              )}
            </span>
            {(traceError || traceRead?.state === "unreachable") && (
              <button type="button" onClick={onTraceRetry} className="shrink-0 text-foreground underline underline-offset-2">
                {t(($) => $.transcript.trace_retry)}
              </button>
            )}
          </div>
        )}

        {activeView === "prompt" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {promptQuery.isLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t(($) => $.transcript.prompt_loading)}
              </div>
            ) : promptInput && promptShown ? (
              <>
                <div className="shrink-0 border-b px-4 py-2 text-xs text-muted-foreground">
                  {t(($) => $.transcript.prompt_sent_title)}
                </div>
                <div className="min-h-0 flex-1 space-y-4 overflow-auto bg-muted/10 p-4">
                  {promptInput.instructions && <SessionInstructions text={promptInput.instructions} />}
                  {promptInput.sent_prompt === null && (
                    <p className="text-xs text-muted-foreground">{t(($) => $.transcript.prompt_messages_fallback)}</p>
                  )}
                  {promptInput.prompt.trim() !== "" && <PromptText chat={chatPrompt} text={promptInput.prompt} />}
                  <PromptSteers steers={promptSteers} chat={chatPrompt} />
                </div>
              </>
            ) : promptNotRecorded && promptFallback ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-auto bg-muted/10 p-4">
                {promptFallback}
                <PromptSteers steers={promptSteers} chat={chatPrompt} />
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
                <FileInput className="h-5 w-5" />
                <span>
                  {promptNotRecorded
                    ? t(($) => $.transcript.prompt_not_recorded)
                    : t(($) => $.transcript.prompt_load_failed)}
                </span>
              </div>
            )}
          </div>
        ) : (
        <>
        {/* ── Timeline progress bar ─────────────────────────────── */}
        {displayItems.length > 0 && (
          <div className="border-b px-4 py-2.5 shrink-0">
            <TimelineBar
              items={displayItems}
              selectedId={selectedId}
              onSegmentClick={handleSegmentClick}
            />
          </div>
        )}

        {/* ── Final answer (agent's last reply, markdown) ────────── */}
        {finalAnswer && (
          <div className="border-b px-4 py-3 shrink-0 bg-muted/10">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                {t(($) => $.transcript.final_answer)}
              </span>
              <button
                type="button"
                onClick={handleCopyAnswer}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {answerCopied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                {t(($) => $.transcript.copy_answer)}
              </button>
            </div>
            <div className="max-h-48 overflow-auto text-xs">
              <Markdown mode="minimal">{finalAnswer}</Markdown>
            </div>
          </div>
        )}

        {/* ── Plan checklist (latest snapshot) ───────────────────── */}
        {planEntries && planEntries.length > 0 && (
          <div className="border-b px-4 py-3 shrink-0 bg-muted/10">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              {t(($) => $.transcript.plan)}
            </span>
            <div className="mt-1.5">
              <PlanEntries entries={planEntries} />
            </div>
          </div>
        )}

        {/* ── Event list ─────────────────────────────────────────── */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto min-h-0"
        >
          {traceLoading && items.length === 0 ? (
            <div role="status" className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />{t(($) => $.transcript.trace_loading)}
            </div>
          ) : entries.length === 0 && (traceUnavailable || legacyTrace) ? (
            <div className="h-full" aria-hidden="true" />
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {emptyStateLabel ? (
                <div className="flex items-center gap-2">
                  {emptyStateSpins
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <Clock className="h-4 w-4" />}
                  {emptyStateLabel}
                </div>
              ) : (
                t(($) => $.transcript.no_data)
              )}
            </div>
          ) : (
            <div className="divide-y">
              {entries.map((item) => (
                <TranscriptItemRow
                  key={item.id}
                  item={item}
                  childItems={childrenOf.get(item.id) ?? NO_CHILDREN}
                  getChildren={getChildren}
                  selectedId={selectedId}
                  liveFollow={liveFollow}
                  taskTerminal={taskTerminal}
                  registerRow={registerRow}
                />
              ))}
            </div>
          )}
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Text sent to the agent. Chat input is the user's own words, so it reads as text, not as a log. */
function PromptText({ chat, text, steer = false }: { chat: boolean; text: string; steer?: boolean }) {
  const Element = chat ? "div" : "pre";
  return (
    <Element
      data-prompt-part={steer ? "steer" : "prompt"}
      className={cn(
        "whitespace-pre-wrap break-words text-foreground",
        chat ? "text-sm leading-6" : "font-mono text-xs leading-5",
      )}
    >
      {text}
    </Element>
  );
}

/** The steers the agent received during the attempt, in order. */
function PromptSteers({ steers, chat }: { steers: readonly TraceItemOf<"user_message">[]; chat: boolean }) {
  const { t } = useT("agents");
  if (steers.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={t(($) => $.transcript.prompt_steers)}>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t(($) => $.transcript.prompt_steers)}
      </h3>
      {steers.map((steer) => (
        <div key={steer.id} className="border-l-2 border-border pl-3">
          <PromptText chat={chat} text={steer.text} steer />
        </div>
      ))}
    </section>
  );
}

/** Remi's part of the session's AGENTS.md for the attempt, collapsed by default. */
function SessionInstructions({ text }: { text: string }) {
  const { t } = useT("agents");
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border bg-background">
      <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-accent/40">
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        {t(($) => $.transcript.session_instructions)}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 border-t px-3 py-2">
        <p className="text-xs text-muted-foreground">{t(($) => $.transcript.session_instructions_note)}</p>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
          {text}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
