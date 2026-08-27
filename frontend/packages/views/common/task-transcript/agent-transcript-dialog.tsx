"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
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
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@multiremi/ui/lib/utils";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { Dialog, DialogContent, DialogTitle } from "@multiremi/ui/components/ui/dialog";
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
import { redactString } from "./redact";
import { buildEntries, countToolCalls, nestEntries, type TimelineItem } from "./build-timeline";
import { useT } from "../../i18n";
import {
  formatProvider,
  getEventLabel,
  getEventSummary,
  usageSnapshotFromTask,
} from "./event-format";
import { MetadataChip } from "./metadata-chip";
import { SortDirectionToggle } from "./sort-direction-toggle";
import { TimelineBar } from "./timeline-bar";
import { TranscriptEventRow } from "./transcript-event-row";
import { TranscriptStepRow } from "./transcript-step-row";

interface AgentTranscriptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  task: AgentTask;
  items: TimelineItem[];
  agentName: string;
  isLive?: boolean;
  /**
   * Optional content rendered between the header chips and the event list.
   * Used by autopilot run rows to surface the inbound webhook trigger
   * payload so it's visible regardless of whether the agent echoes it.
   * The dialog stays generic — slot content is the caller's concern.
   */
  headerSlot?: React.ReactNode;
}

// ─── Color mapping for timeline segments ────────────────────────────────────

/** Task states after which no step can still be running. */
const TERMINAL_TASK_STATUS = new Set<string>(["completed", "failed", "cancelled"]);

// ─── Main dialog ────────────────────────────────────────────────────────────

export function AgentTranscriptDialog({
  open,
  onOpenChange,
  task,
  items,
  agentName,
  isLive = false,
  headerSlot,
}: AgentTranscriptDialogProps) {
  const { t } = useT("agents");
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState("");
  const [copied, setCopied] = useState(false);
  const [copiedWorkdir, setCopiedWorkdir] = useState(false);
  const [activeView, setActiveView] = useState<"execution" | "prompt">("execution");
  const [promptCopied, setPromptCopied] = useState(false);
  const [agentInfo, setAgentInfo] = useState<Agent | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<AgentRuntime | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const sortDirection = useTranscriptViewStore((s) => s.sortDirection);
  const setSortDirection = useTranscriptViewStore((s) => s.setSortDirection);
  const eventRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const promptQuery = useQuery({
    queryKey: ["task-prompt", task.id],
    queryFn: () => api.getTaskPrompt(task.id),
    enabled: open && activeView === "prompt",
    retry: false,
    staleTime: Infinity,
  });
  const promptNotRecorded = Boolean(
    promptQuery.error
    && typeof promptQuery.error === "object"
    && "status" in promptQuery.error
    && promptQuery.error.status === 404,
  );

  // Derive filter options from each item:
  //   tool_use / tool_result → filter value = tool, display = "tool:Bash"
  //   other types → display from getEventLabel
  const filterOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const item of items) {
      if (item.tool && (item.type === "tool_use" || item.type === "tool_result")) {
        const key = `tool:${item.tool}`;
        if (!options.has(key)) options.set(key, key);
      } else {
        const value = item.type;
        if (!options.has(value)) {
          options.set(value, getEventLabel(item));
        }
      }
    }
    return Array.from(options.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);

  // Resolve filter key for each item — mirrors filterOptions derivation exactly
  const itemFilterKey = (item: TimelineItem) =>
    item.tool && (item.type === "tool_use" || item.type === "tool_result")
      ? `tool:${item.tool}`
      : item.type;

  // Strict filter
  const filteredItems = useMemo(() => {
    if (selectedTools.size === 0) return items;
    return items.filter((item) => selectedTools.has(itemFilterKey(item)));
  }, [items, selectedTools]);

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

  const handleSegmentClick = useCallback((seq: number) => {
    setSelectedSeq(seq);
    eventRefs.current.get(seq)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  // Live-follow: the transcript is tailing a running task. Also gates the
  // auto-expansion of running subagent groups.
  const liveFollow = isLive && sortDirection === "chronological";
  // A finished task can't have running steps; `isLive` wins so a task whose
  // status has landed while the stream is still open keeps its spinners.
  const taskTerminal = !isLive && TERMINAL_TASK_STATUS.has(task.status);

  // Follow the newest events while a task is live, but only when the user is
  // already parked near the bottom — scrolling up to read history pauses the
  // auto-follow (standard log-tail behavior). Only in chronological order.
  const lastItemSeq = displayItems.length > 0 ? displayItems[displayItems.length - 1]!.seq : null;
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
    // Flat chronological order, with subagent steps indented one level — same
    // fail-open rule as nestEntries: an unknown parent id stays flush left.
    const stepIds = new Set(displayItems.map((item) => item.toolCallId).filter(Boolean));
    const text = displayItems
      .map((item) => {
        const label = getEventLabel(item);
        const summary = getEventSummary(item);
        const parentId = item.meta?.parent_tool_call_id;
        const nested = typeof parentId === "string" && parentId !== item.toolCallId && stepIds.has(parentId);
        return `${nested ? "  " : ""}[${label}] ${summary}`;
      })
      .join("\n");
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [displayItems]);

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

  const toolCount = countToolCalls(items);

  // Header token rollup (server-provided) + the agent's final reply, surfaced
  // above the event list so the outcome isn't buried in a one-line summary.
  const usage = useMemo(() => usageSnapshotFromTask(task), [task]);
  const [answerCopied, setAnswerCopied] = useState(false);
  const finalAnswer = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      // Skip subagent prose: it is the last text on the wire but not this
      // agent's answer (bridges >= 0.66 forward it with a parent id).
      if (it?.meta?.parent_tool_call_id) continue;
      if (it?.type === "text" && it.content?.trim()) return it.content;
    }
    return null;
  }, [items]);
  const handleCopyAnswer = useCallback(() => {
    if (!finalAnswer) return;
    void copyText(redactString(finalAnswer)).then((ok) => {
      if (!ok) return;
      setAnswerCopied(true);
      setTimeout(() => setAnswerCopied(false), 2000);
    });
  }, [finalAnswer]);

  // Pair tool_use/tool_result into step cards (Batch 2 gives us tool_call_id);
  // the final answer, usage, and plan are surfaced in their own sections.
  // buildEntries pairs chronologically; apply the display sort to the entries
  // afterward so newest-first doesn't corrupt the pairing.
  const entries = useMemo(() => {
    // Nest before the display sort so a subagent's steps stay chronological
    // inside their group while the top level follows the chosen direction.
    const paired = nestEntries(buildEntries(filteredItems));
    return sortDirection === "newest_first" ? [...paired].reverse() : paired;
  }, [filteredItems, sortDirection]);
  const planEntries = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      // "plan" isn't in TimelineItem's narrow union but flows through from the
      // wire; compare as string.
      if ((it?.type as string) === "plan" && Array.isArray(it?.meta?.entries)) {
        return it!.meta!.entries as Array<Record<string, unknown>>;
      }
    }
    return null;
  }, [items]);

  const statusDisplay = task.status === "queued"
    ? { label: t(($) => $.transcript.status_queued), icon: Clock, tone: "bg-muted text-muted-foreground", spins: false }
    : task.status === "dispatched"
      ? { label: t(($) => $.transcript.status_dispatched), icon: Loader2, tone: "bg-info/15 text-info", spins: true }
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
      {StatusIcon ? <StatusIcon className={cn("h-3 w-3", statusDisplay.spins && "animate-spin")} /> : null}
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
  const emptyStateSpins = task.status === "dispatched" || (task.status === "running" && isLive);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!max-w-4xl !w-[calc(100vw-4rem)] !max-h-[calc(100vh-4rem)] !h-[calc(100vh-4rem)] flex flex-col !p-0 !gap-0 overflow-hidden"
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
              {activeView === "execution" && items.length > 1 && (
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
                ? t(($) => $.transcript.events_filtered, { shown: filteredItems.length, total: items.length })
                : t(($) => $.transcript.events, { count: items.length })}
            </MetadataChip>

            {/* Token usage — input→output when the bridge splits them, else the
                ACP context total. cost intentionally omitted (not on the wire). */}
            {usage && (
              <MetadataChip icon={<Coins className="h-3 w-3" />}>
                {usage.inputTokens || usage.outputTokens
                  ? `${formatTokens(usage.inputTokens ?? 0)}→${formatTokens(usage.outputTokens ?? 0)}`
                  : usage.totalTokens
                    ? t(($) => $.transcript.tokens_context, { value: formatTokens(usage.totalTokens) })
                    : null}
                {usage.model && <span className="text-muted-foreground/60 ml-1">{usage.model}</span>}
              </MetadataChip>
            )}

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

        {activeView === "prompt" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {promptQuery.isLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t(($) => $.transcript.prompt_loading)}
              </div>
            ) : promptQuery.data ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
                  <span className="rounded border bg-muted/50 px-2 py-0.5 font-medium uppercase text-foreground">
                    {promptQuery.data.mode}
                  </span>
                  <span>{new Date(promptQuery.data.assembled_at).toLocaleString()}</span>
                  <span className="ml-auto max-w-56 truncate font-mono" title={promptQuery.data.sha256}>
                    {t(($) => $.transcript.prompt_hash, { hash: promptQuery.data.sha256.slice(0, 12) })}
                  </span>
                </div>
                <div className="min-h-0 flex-1 overflow-auto bg-muted/10 p-4">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground">
                    {promptQuery.data.prompt}
                  </pre>
                </div>
              </>
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
              selectedSeq={selectedSeq}
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
              <Markdown mode="minimal">{redactString(finalAnswer)}</Markdown>
            </div>
          </div>
        )}

        {/* ── Plan checklist (latest snapshot) ───────────────────── */}
        {planEntries && planEntries.length > 0 && (
          <div className="border-b px-4 py-3 shrink-0 bg-muted/10">
            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              {t(($) => $.transcript.plan)}
            </span>
            <div className="mt-1.5 space-y-1">
              {planEntries.map((p, i) => {
                const status = String(p.status ?? "pending");
                return (
                  <div key={i} className="flex items-start gap-1.5 text-xs">
                    {status === "completed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-500" />
                    ) : status === "in_progress" ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-blue-500 animate-spin" />
                    ) : (
                      <div className="h-3.5 w-3.5 shrink-0 mt-0.5 rounded-full border border-muted-foreground/40" />
                    )}
                    <span className={cn(status === "completed" && "text-muted-foreground line-through")}>
                      {redactString(String(p.content ?? p.activeForm ?? ""))}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Optional header slot (e.g. webhook payload preview) ── */}
        {headerSlot && (
          <div className="border-b px-4 py-3 shrink-0 bg-muted/20">
            {headerSlot}
          </div>
        )}

        {/* ── Event list ─────────────────────────────────────────── */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto min-h-0"
        >
          {entries.length === 0 ? (
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
              {entries.map((entry) =>
                entry.kind === "step" ? (
                  <TranscriptStepRow
                    key={`s-${entry.toolCallId}`}
                    ref={(el) => {
                      // Nested children have no row of their own while the group
                      // is collapsed — register the group for their seqs too, so
                      // timeline-bar navigation still lands on them.
                      for (const seq of [entry.seq, ...(entry.children ?? []).map((c) => c.seq)]) {
                        if (el) eventRefs.current.set(seq, el);
                        else eventRefs.current.delete(seq);
                      }
                    }}
                    step={entry}
                    selectedSeq={selectedSeq}
                    liveFollow={liveFollow}
                    taskTerminal={taskTerminal}
                  />
                ) : (
                  <TranscriptEventRow
                    key={`e-${entry.seq}`}
                    ref={(el) => {
                      if (el) eventRefs.current.set(entry.seq, el);
                      else eventRefs.current.delete(entry.seq);
                    }}
                    item={entry.item}
                    isSelected={selectedSeq === entry.seq}
                  />
                ),
              )}
            </div>
          )}
        </div>
        </>
        )}
      </DialogContent>
    </Dialog>
  );
}
