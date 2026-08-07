"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import {
  Bot,
  ChevronRight,
  CircleDashed,
  Brain,
  AlertCircle,
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
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
} from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { copyText } from "@multiremi/ui/lib/clipboard";
import { Dialog, DialogContent, DialogTitle } from "@multiremi/ui/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { Markdown } from "@multiremi/ui/markdown/Markdown";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
} from "@multiremi/ui/components/ui/dropdown-menu";
import { ActorAvatar } from "../actor-avatar";
import { api } from "@multiremi/core/api";
import { useTranscriptViewStore, type TranscriptSortDirection } from "@multiremi/core/agents/stores";
import type { AgentTask, Agent, AgentRuntime } from "@multiremi/core/types/agent";
import { redactString } from "./redact";
import { buildEntries, isStepRunning, nestEntries, type TimelineItem, type TranscriptEntry, type UsageSnapshot } from "./build-timeline";
import {
  collabAgentStates,
  collabReceiverThreadIds,
  formatToolInputSummary,
  isBashCommandMissing,
  isCollabInput,
  toolIcon,
} from "./tool-summaries";
import { useT } from "../../i18n";

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

type EventColor = "agent" | "thinking" | "tool" | "result" | "error";

function getEventColor(item: TimelineItem): EventColor {
  switch (item.type) {
    case "text":
      return "agent";
    case "thinking":
      return "thinking";
    case "tool_use":
      return "tool";
    case "tool_result":
      return "result";
    case "error":
      return "error";
    default:
      return "result";
  }
}

const colorClasses: Record<EventColor, { bg: string; bgActive: string; label: string }> = {
  agent: { bg: "bg-emerald-400/60", bgActive: "bg-emerald-500", label: "bg-emerald-500" },
  thinking: { bg: "bg-violet-400/60", bgActive: "bg-violet-500", label: "bg-violet-500/20 text-violet-700 dark:text-violet-300" },
  tool: { bg: "bg-blue-400/60", bgActive: "bg-blue-500", label: "bg-blue-500/20 text-blue-700 dark:text-blue-300" },
  result: { bg: "bg-slate-300/60 dark:bg-slate-600/60", bgActive: "bg-slate-400 dark:bg-slate-500", label: "bg-muted text-muted-foreground" },
  error: { bg: "bg-red-400/60", bgActive: "bg-red-500", label: "bg-red-500/20 text-red-700 dark:text-red-300" },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getEventLabel(item: TimelineItem): string {
  switch (item.type) {
    case "text":
      return "Agent";
    case "thinking":
      return "Thinking";
    case "tool_use":
      return item.tool ?? "Tool";
    case "tool_result":
      return item.tool ? `${item.tool}` : "Result";
    case "error":
      return "Error";
    case "permission_request":
      return "Permission";
    case "permission_response":
      return "Permission";
    case "question_request":
      return "Question";
    case "question_response":
      return "Answer";
    default:
      // Unknown/new message kinds render their raw type rather than a generic
      // "Event" — the old default paired with an empty summary produced the
      // uninformative "Event (empty)" rows. (`type` is exhaustive for the
      // current union, so this is future-proofing for widened payloads.)
      return (item.type as string) ? String(item.type).replace(/_/g, " ") : "Event";
  }
}

function getEventSummary(item: TimelineItem): string {
  switch (item.type) {
    case "text":
      return item.content?.split("\n").find((l) => l.trim().length > 0) ?? "";
    case "thinking":
      return item.content?.slice(0, 200) ?? "";
    case "tool_use": {
      if (!item.input) return "";
      const inp = item.input as Record<string, string>;
      if (inp.query) return inp.query;
      if (inp.file_path) return shortenPath(inp.file_path);
      if (inp.path) return shortenPath(inp.path);
      if (inp.pattern) return inp.pattern;
      if (inp.description) return String(inp.description);
      if (inp.command) {
        const cmd = String(inp.command);
        return cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
      }
      if (inp.prompt) {
        const p = String(inp.prompt);
        return p.length > 120 ? p.slice(0, 120) + "..." : p;
      }
      if (inp.skill) return String(inp.skill);
      for (const v of Object.values(inp)) {
        if (typeof v === "string" && v.length > 0 && v.length < 120) return v;
      }
      return "";
    }
    case "tool_result":
      return item.output?.slice(0, 200) ?? "";
    case "error":
      return item.content ?? "";
    case "permission_request":
    case "question_request": {
      // daemon already writes a human-readable line into content
      // ("Permission requested: Bash" / the question text); append a count of
      // the options / questions carried in input.
      const base = item.content ?? getEventLabel(item);
      const inp = item.input as Record<string, unknown> | undefined;
      const options = Array.isArray(inp?.options) ? (inp!.options as unknown[]).length : 0;
      const questions = Array.isArray(inp?.questions) ? (inp!.questions as unknown[]).length : 0;
      const n = options || questions;
      return n > 0 ? `${base} (${n})` : base;
    }
    case "permission_response":
    case "question_response": {
      const inp = item.input as Record<string, unknown> | undefined;
      const chosen = inp?.option_id ?? (Array.isArray(inp?.answers) ? (inp!.answers as unknown[]).join(", ") : undefined);
      const status = inp?.status;
      return [chosen, status].filter(Boolean).map(String).join(" · ") || (item.content ?? "");
    }
    default:
      // Any other kind: first non-empty line of content, else output.
      return (
        item.content?.split("\n").find((l) => l.trim().length > 0) ??
        item.output?.slice(0, 200) ??
        ""
      );
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-2).join("/");
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

function formatElapsedMs(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

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
  const [agentInfo, setAgentInfo] = useState<Agent | null>(null);
  const [runtimeInfo, setRuntimeInfo] = useState<AgentRuntime | null>(null);
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const sortDirection = useTranscriptViewStore((s) => s.sortDirection);
  const setSortDirection = useTranscriptViewStore((s) => s.setSortDirection);
  const eventRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

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
    const update = () => setElapsed(formatElapsedMs(Date.now() - new Date(startRef).getTime()));
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
      ? formatDuration(task.started_at, task.completed_at)
      : isLive
        ? elapsed
        : null;

  const toolCount = items.filter((i) => i.type === "tool_use").length;

  // Header token rollup (server-provided) + the agent's final reply, surfaced
  // above the event list so the outcome isn't buried in a one-line summary.
  const usage = useMemo(() => usageSnapshotFromTask(task), [task]);
  const [answerCopied, setAnswerCopied] = useState(false);
  const finalAnswer = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
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

  // Status display
  const statusBadge = isLive ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-info/15 px-2 py-0.5 text-xs font-medium text-info">
      <Loader2 className="h-3 w-3 animate-spin" />
      {t(($) => $.transcript.status_running)}
    </span>
  ) : task.status === "completed" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
      <CheckCircle2 className="h-3 w-3" />
      {t(($) => $.transcript.status_completed)}
    </span>
  ) : task.status === "failed" ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
      <XCircle className="h-3 w-3" />
      {t(($) => $.transcript.status_failed)}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground capitalize">
      {task.status}
    </span>
  );

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
          <div className="flex items-center gap-3">
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

            <div className="ml-auto flex items-center gap-1">
              {items.length > 1 && (
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
              {filterOptions.length > 0 && (
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
              <button
                type="button"
                onClick={handleCopyAll}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? t(($) => $.transcript.copied) : selectedTools.size > 0 ? t(($) => $.transcript.copy_filtered) : t(($) => $.transcript.copy_all)}
              </button>
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
                  ? `${formatTokenCount(usage.inputTokens ?? 0)}→${formatTokenCount(usage.outputTokens ?? 0)}`
                  : usage.totalTokens
                    ? t(($) => $.transcript.tokens_context, { value: formatTokenCount(usage.totalTokens) })
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
              {isLive ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t(($) => $.transcript.waiting_events)}
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
      </DialogContent>
    </Dialog>
  );
}

// ─── Sort direction toggle ──────────────────────────────────────────────────

interface SortDirectionToggleProps {
  value: TranscriptSortDirection;
  onChange: (dir: TranscriptSortDirection) => void;
  labels: { chronological: string; newestFirst: string; ariaLabel: string };
}

function SortDirectionToggle({ value, onChange, labels }: SortDirectionToggleProps) {
  return (
    <div
      role="group"
      aria-label={labels.ariaLabel}
      className="inline-flex items-center rounded border bg-muted/40 p-0.5 text-xs"
    >
      <button
        type="button"
        aria-pressed={value === "chronological"}
        title={labels.chronological}
        onClick={() => onChange("chronological")}
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
          value === "chronological"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <ArrowDownNarrowWide className="h-3 w-3" />
        <span className="hidden sm:inline">{labels.chronological}</span>
      </button>
      <button
        type="button"
        aria-pressed={value === "newest_first"}
        title={labels.newestFirst}
        onClick={() => onChange("newest_first")}
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors",
          value === "newest_first"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <ArrowUpNarrowWide className="h-3 w-3" />
        <span className="hidden sm:inline">{labels.newestFirst}</span>
      </button>
    </div>
  );
}

// ─── Metadata chip ──────────────────────────────────────────────────────────

function MetadataChip({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground">
      {icon}
      {children}
    </span>
  );
}

function formatProvider(provider: string): string {
  const map: Record<string, string> = {
    claude: "Claude Code",
    "claude-code": "Claude Code",
    codex: "Codex",
    pi: "Pi",
  };
  return map[provider.toLowerCase()] ?? provider;
}

// ─── Timeline bar (colored segments) ────────────────────────────────────────

function TimelineBar({
  items,
  selectedSeq,
  onSegmentClick,
}: {
  items: TimelineItem[];
  selectedSeq: number | null;
  onSegmentClick: (seq: number) => void;
}) {
  const segments: { startIdx: number; endIdx: number; color: EventColor; count: number }[] = [];
  let currentColor: EventColor | null = null;
  let currentStart = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const color = getEventColor(item);
    if (color !== currentColor) {
      if (currentColor !== null) {
        segments.push({ startIdx: currentStart, endIdx: i - 1, color: currentColor, count: i - currentStart });
      }
      currentColor = color;
      currentStart = i;
    }
  }
  if (currentColor !== null) {
    segments.push({ startIdx: currentStart, endIdx: items.length - 1, color: currentColor, count: items.length - currentStart });
  }

  return (
    <div className="flex gap-0.5 h-5 rounded overflow-hidden" role="navigation" aria-label="Timeline">
      {segments.map((seg) => {
        const isSelected = selectedSeq !== null && items.slice(seg.startIdx, seg.endIdx + 1).some((i) => i.seq === selectedSeq);
        const color = colorClasses[seg.color];
        const widthPercent = (seg.count / items.length) * 100;

        return (
          <button
            type="button"
            key={seg.startIdx}
            className={cn(
              "h-full transition-all duration-150 hover:opacity-80 relative group",
              isSelected ? color.bgActive : color.bg,
              "min-w-[4px]",
            )}
            style={{ width: `${Math.max(widthPercent, 0.5)}%` }}
            onClick={() => onSegmentClick(items[seg.startIdx]!.seq)}
            title={`${getEventLabel(items[seg.startIdx]!)}${seg.count > 1 ? ` (+${seg.count - 1} more)` : ""}`}
          >
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10 pointer-events-none">
              <div className="rounded bg-popover border px-2 py-1 text-[10px] text-popover-foreground shadow-md whitespace-nowrap">
                {getEventLabel(items[seg.startIdx]!)}
                {seg.count > 1 && <span className="text-muted-foreground ml-1">+{seg.count - 1}</span>}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Transcript event row ───────────────────────────────────────────────────

interface TranscriptEventRowProps {
  item: TimelineItem;
  isSelected: boolean;
}

const TranscriptEventRow = ({
  ref,
  item,
  isSelected,
}: TranscriptEventRowProps & { ref?: React.Ref<HTMLDivElement> }) => {
  const [expanded, setExpanded] = useState(false);
  const color = getEventColor(item);
  const label = getEventLabel(item);
  const summary = getEventSummary(item);

  const hasInput = Boolean(item.input && Object.keys(item.input).length > 0);
  const hasContent = Boolean(item.content && item.content.length > 0);
  const hasDetail =
    (item.type === "tool_use" && hasInput) ||
    (item.type === "tool_result" && Boolean(item.output && item.output.length > 0)) ||
    (item.type === "thinking" && hasContent) ||
    (item.type === "text" && hasContent) ||
    (item.type === "error" && hasContent) ||
    // permission / question rows carry structured input worth expanding
    (item.type.startsWith("permission_") && hasInput) ||
    (item.type.startsWith("question_") && hasInput) ||
    // any other kind: expandable if it has content or output
    (hasContent || Boolean(item.output && item.output.length > 0));

  return (
    <div
      ref={ref}
      className={cn(
        "group transition-colors",
        isSelected && "bg-accent/50",
      )}
    >
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="flex items-start gap-2 px-4 py-2">
          {/* Type label badge */}
          <span
            className={cn(
              "inline-flex items-center shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium mt-0.5 min-w-[60px] justify-center",
              colorClasses[color].label,
            )}
          >
            {item.type === "thinking" && <Brain className="h-3 w-3 mr-1 shrink-0" />}
            {item.type === "error" && <AlertCircle className="h-3 w-3 mr-1 shrink-0" />}
            {label}
          </span>

          {/* Summary */}
          <CollapsibleTrigger
            className={cn(
              "flex-1 text-left text-xs min-w-0 py-0.5 transition-colors",
              hasDetail ? "cursor-pointer hover:text-foreground" : "cursor-default",
              item.type === "error" ? "text-destructive" : "text-muted-foreground",
            )}
            disabled={!hasDetail}
          >
            <div className="flex items-start gap-1.5">
              {hasDetail && (
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/50 transition-transform",
                    expanded && "rotate-90",
                  )}
                />
              )}
              <span className="truncate">{summary || "(empty)"}</span>
            </div>
          </CollapsibleTrigger>

          {/* Timestamp + seq number */}
          <span className="shrink-0 flex items-center gap-1.5 text-[10px] text-muted-foreground/50 tabular-nums mt-1">
            {item.createdAt && <span>{formatEventTime(item.createdAt)}</span>}
            <span>#{item.seq}</span>
          </span>
        </div>

        {/* Expanded detail */}
        {hasDetail && (
          <CollapsibleContent>
            <div className="px-4 pb-3">
              <div className="ml-[72px] rounded bg-muted/40 border">
                <EventDetailContent item={item} />
              </div>
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
};

// ─── Paired tool-call step card ─────────────────────────────────────────────

interface TranscriptStepRowProps {
  step: Extract<TranscriptEntry, { kind: "step" }>;
  selectedSeq: number | null;
  liveFollow: boolean;
  /** The task itself has finished, so a step still marked running never will. */
  taskTerminal: boolean;
}

/** Agent / Task (legacy) steps delegate to a subagent — they own children and report Markdown. */
function isSubagentStep(tool?: string): boolean {
  return tool === "Agent" || tool === "Task";
}

const TranscriptStepRow = ({
  ref,
  step,
  selectedSeq,
  liveFollow,
  taskTerminal,
}: TranscriptStepRowProps & { ref?: React.Ref<HTMLDivElement> }) => {
  const { t } = useT("agents");
  const [expanded, setExpanded] = useState(false);
  const autoExpanded = useRef(false);
  const Icon = toolIcon(step.tool);
  const summary = formatToolInputSummary(step.tool ?? "", step.input);
  const commandMissing = isBashCommandMissing(step.tool, step.input);
  const running = isStepRunning(step.status);
  // Codex sometimes abandons a call and re-issues it under a new id; the orphan
  // never gets a terminal frame. Once the task is done it cannot still be
  // running, so show it as unfinished rather than spinning forever.
  const abandoned = running && taskTerminal;
  const failed = step.status === "failed";
  const children = step.children ?? [];
  const isSelected = selectedSeq === step.seq || children.some((child) => child.seq === selectedSeq);
  // Codex collab steps render their own structured pane; whatever CollabDetail
  // doesn't show still goes through the generic JSON block.
  const collabInput = isCollabInput(step.input) ? step.input : undefined;
  const residualInput = collabInput ? omitKeys(collabInput, COLLAB_RENDERED_KEYS) : step.input;
  const hasDetail =
    (step.input && Object.keys(step.input).length > 0) ||
    Boolean(step.output && step.output.length > 0) ||
    children.length > 0;

  // Open a running subagent group once while the dialog tails the task, so its
  // steps appear as they arrive. Only once — a later collapse stays collapsed.
  useEffect(() => {
    if (autoExpanded.current) return;
    if (!liveFollow || !running || !isSubagentStep(step.tool)) return;
    autoExpanded.current = true;
    setExpanded(true);
  }, [liveFollow, running, step.tool]);

  return (
    <div ref={ref} className={cn("group transition-colors", isSelected && "bg-accent/50")}>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="flex items-start gap-2 px-4 py-2">
          {/* status dot */}
          <span className="mt-1 shrink-0">
            {abandoned ? (
              <CircleDashed className="h-3.5 w-3.5 text-muted-foreground/60" />
            ) : running ? (
              <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />
            ) : failed ? (
              <XCircle className="h-3.5 w-3.5 text-destructive" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            )}
          </span>
          <span className="inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium mt-0.5 bg-blue-500/15 text-blue-700 dark:text-blue-300">
            <Icon className="h-3 w-3" />
            {step.tool ?? "Tool"}
          </span>
          {children.length > 0 && (
            <span className="inline-flex items-center shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium mt-0.5 bg-muted text-muted-foreground">
              {t(($) => $.transcript.nested_steps, { count: children.length })}
            </span>
          )}
          {abandoned && (
            <span className="inline-flex items-center shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium mt-0.5 bg-muted text-muted-foreground">
              {t(($) => $.transcript.step_not_finished)}
            </span>
          )}
          <CollapsibleTrigger
            className={cn(
              "flex-1 text-left text-xs min-w-0 py-0.5 transition-colors text-muted-foreground",
              hasDetail ? "cursor-pointer hover:text-foreground" : "cursor-default",
            )}
            disabled={!hasDetail}
          >
            <div className="flex items-start gap-1.5">
              {hasDetail && (
                <ChevronRight
                  className={cn(
                    "h-3 w-3 shrink-0 mt-0.5 text-muted-foreground/50 transition-transform",
                    expanded && "rotate-90",
                  )}
                />
              )}
              {commandMissing ? (
                <span className="truncate italic text-muted-foreground/70">
                  {t(($) => $.transcript.command_not_recorded)}
                </span>
              ) : (
                <span className="truncate font-mono">{summary}</span>
              )}
            </div>
          </CollapsibleTrigger>
          <span className="shrink-0 flex items-center gap-1.5 text-[10px] text-muted-foreground/50 tabular-nums mt-1">
            {step.durationMs != null && <span>{formatStepDuration(step.durationMs)}</span>}
            <span>#{step.seq}</span>
          </span>
        </div>
        {hasDetail && (
          <CollapsibleContent>
            <div className="px-4 pb-3 ml-[72px] space-y-2">
              {collabInput && <CollabDetail input={collabInput} />}
              {residualInput && Object.keys(residualInput).length > 0 && (
                <pre className="max-h-52 overflow-auto rounded bg-muted/40 border p-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
                  {JSON.stringify(residualInput, null, 2)}
                </pre>
              )}
              {children.length > 0 && (
                <div className="border-l-2 border-border pl-2 divide-y">
                  {children.map((child) =>
                    child.kind === "step" ? (
                      <TranscriptStepRow
                        key={`s-${child.toolCallId}`}
                        step={child}
                        selectedSeq={selectedSeq}
                        liveFollow={liveFollow}
                        taskTerminal={taskTerminal}
                      />
                    ) : null,
                  )}
                </div>
              )}
              {step.output &&
                (isSubagentStep(step.tool) ? (
                  // The subagent's final report — Markdown, not a JSON dump.
                  <div className="max-h-96 overflow-auto rounded bg-muted/40 border p-3 text-xs">
                    <Markdown mode="minimal">{step.output}</Markdown>
                  </div>
                ) : (
                  <StepOutput output={step.output} meta={step.meta} />
                ))}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
};

// ─── Codex collab (subagent delegation) detail ──────────────────────────────

/** Keys CollabDetail renders itself — kept out of the generic JSON block. */
const COLLAB_RENDERED_KEYS = ["prompt", "senderThreadId", "receiverThreadIds", "agentsStates"];

function omitKeys(input: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([k]) => !keys.includes(k)));
}

/** Thread ids are UUIDs — show a recognizable head, never the full id inline. */
function shortThreadId(id: string): string {
  return id.slice(0, 8);
}

/**
 * A collab step's payload lives entirely in its input: the prompt, the per-agent
 * states, and — on a completed `wait` — each subagent's final answer in
 * `agentsStates[*].message`. The frames carry no output at all, so this is the
 * only place a delegation's result can come from.
 */
function CollabDetail({ input }: { input: Record<string, unknown> }) {
  const { t } = useT("agents");
  const prompt = typeof input.prompt === "string" && input.prompt ? input.prompt : undefined;
  const states = collabAgentStates(input);
  const receivers = collabReceiverThreadIds(input);

  return (
    <div className="space-y-2">
      {prompt && (
        <div className="max-h-52 overflow-auto rounded bg-muted/40 border p-3 text-xs">
          <Markdown mode="minimal">{prompt}</Markdown>
        </div>
      )}

      {states.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {states.map((state) => (
            <span
              key={state.threadId}
              title={state.threadId}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                // Only `completed` is terminal; every other value (pendingInit,
                // inProgress, anything new) reads as in-progress.
                state.status === "completed" ? "bg-success/15 text-success" : "bg-info/15 text-info",
              )}
            >
              <span className="font-mono">{shortThreadId(state.threadId)}</span>
              {state.status}
            </span>
          ))}
        </div>
      )}

      {states
        .filter((state) => state.message)
        .map((state) => (
          <div key={`msg-${state.threadId}`} className="rounded bg-muted/40 border p-3 text-xs">
            <div className="mb-1 font-mono text-[10px] text-muted-foreground">{shortThreadId(state.threadId)}</div>
            <div className="max-h-72 overflow-auto">
              <Markdown mode="minimal">{state.message ?? ""}</Markdown>
            </div>
          </div>
        ))}

      {receivers.length > 0 && (
        <div className="text-[10px] text-muted-foreground/70 font-mono break-all">
          {receivers.map((id) => (
            <div key={id}>{id}</div>
          ))}
        </div>
      )}

      {/* The ceiling, stated on the card: codex-acp drops subAgentActivity, so
          the subagent's own steps never reach this transcript. */}
      <div className="text-[10px] text-muted-foreground/70 italic">
        {t(($) => $.transcript.collab_activity_hidden)}
      </div>
    </div>
  );
}

// Render a tool result: diff blocks (from meta.content_blocks) get +/- line
// coloring; everything else is JSON-pretty-printed or shown raw.
function StepOutput({ output, meta }: { output: string; meta?: Record<string, unknown> }) {
  const blocks = Array.isArray(meta?.content_blocks) ? (meta!.content_blocks as Array<Record<string, unknown>>) : [];
  const diff = blocks.find((b) => b.type === "diff");
  if (diff && (typeof diff.newText === "string" || typeof diff.new_text === "string")) {
    const text = String(diff.newText ?? diff.new_text ?? "");
    return (
      <pre className="max-h-52 overflow-auto rounded bg-muted/40 border p-3 text-[11px] font-mono whitespace-pre-wrap break-all">
        {text.split("\n").map((line, i) => (
          <div
            key={i}
            className={cn(
              line.startsWith("+") && "text-emerald-600 dark:text-emerald-400",
              line.startsWith("-") && "text-red-600 dark:text-red-400",
            )}
          >
            {line}
          </div>
        ))}
      </pre>
    );
  }
  let body = output;
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object") body = JSON.stringify(parsed, null, 2);
  } catch { /* plain text */ }
  return (
    <pre className="max-h-52 overflow-auto rounded bg-muted/40 border p-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
      {body.length > 4000 ? body.slice(0, 4000) + "\n… (truncated)" : body}
    </pre>
  );
}

function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Event detail content ───────────────────────────────────────────────────

function EventDetailContent({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "tool_use":
      // input already recursively redacted in buildTimeline
      return (
        <pre className="max-h-60 overflow-auto p-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {item.input ? JSON.stringify(item.input, null, 2) : ""}
        </pre>
      );
    case "tool_result": {
      const out = item.output ?? "";
      // Pretty-print JSON results; leave plain text as-is.
      let body = out;
      try {
        const parsed = JSON.parse(out);
        if (parsed && typeof parsed === "object") body = JSON.stringify(parsed, null, 2);
      } catch { /* not JSON */ }
      return (
        <pre className="max-h-60 overflow-auto p-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {body.length > 4000 ? body.slice(0, 4000) + "\n... (truncated)" : body}
        </pre>
      );
    }
    case "thinking":
    case "text":
      // Agent prose is markdown — render code blocks / tables / lists instead
      // of a flat <pre>. Content is already redacted upstream.
      return (
        <div className="max-h-96 overflow-auto p-3 text-xs">
          <Markdown mode="minimal">{item.content ?? ""}</Markdown>
        </div>
      );
    case "error":
      return (
        <pre className="max-h-60 overflow-auto p-3 text-[11px] text-destructive whitespace-pre-wrap break-words">
          {item.content ?? ""}
        </pre>
      );
    case "permission_request":
    case "permission_response":
    case "question_request":
    case "question_response":
      return <HumanInteractionDetail item={item} />;
    default:
      // Unknown kinds: show content, else the raw (redacted) input/meta.
      if (item.content) {
        return (
          <pre className="max-h-60 overflow-auto p-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-words">
            {item.content}
          </pre>
        );
      }
      return (
        <pre className="max-h-60 overflow-auto p-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all">
          {JSON.stringify(item.input ?? item.meta ?? {}, null, 2)}
        </pre>
      );
  }
}

// Permission / question requests and their responses carry structured input
// (options, chosen option, questions, answers) that the daemon writes as JSON.
// Render it as a small key/value block rather than dumping raw JSON.
function HumanInteractionDetail({ item }: { item: TimelineItem }) {
  const inp = (item.input ?? {}) as Record<string, unknown>;
  const options = Array.isArray(inp.options) ? (inp.options as Array<Record<string, unknown>>) : [];
  const questions = Array.isArray(inp.questions) ? (inp.questions as Array<Record<string, unknown>>) : [];
  const answers = Array.isArray(inp.answers) ? (inp.answers as unknown[]) : [];
  const chosen = inp.option_id ? String(inp.option_id) : undefined;
  const status = inp.status ? String(inp.status) : undefined;
  const respondedBy = inp.responded_by ? String(inp.responded_by) : undefined;

  return (
    <div className="max-h-72 overflow-auto p-3 text-[11px] text-muted-foreground space-y-2">
      {item.content && <div className="text-foreground">{item.content}</div>}
      {options.length > 0 && (
        <div className="space-y-1">
          {options.map((opt, i) => {
            const id = String(opt.optionId ?? opt.option_id ?? opt.id ?? i);
            const name = String(opt.name ?? opt.label ?? opt.title ?? id);
            const isChosen = chosen != null && id === chosen;
            return (
              <div key={id} className={cn("flex items-center gap-1.5", isChosen && "text-emerald-600 dark:text-emerald-400 font-medium")}>
                {isChosen ? <Check className="h-3 w-3 shrink-0" /> : <span className="inline-block w-3 shrink-0" />}
                <span>{name}</span>
                {opt.kind ? <span className="text-muted-foreground/60">({String(opt.kind)})</span> : null}
              </div>
            );
          })}
        </div>
      )}
      {questions.map((q, i) => (
        <div key={i} className="space-y-0.5">
          <div className="text-foreground">{String(q.question ?? q.header ?? "")}</div>
          {Array.isArray(q.options) && (
            <div className="pl-3">{(q.options as Array<Record<string, unknown>>).map((o, j) => (
              <div key={j}>· {String(o.label ?? o.name ?? "")}</div>
            ))}</div>
          )}
        </div>
      ))}
      {answers.length > 0 && <div><span className="text-foreground">Answer:</span> {answers.map(String).join(", ")}</div>}
      {(chosen || status || respondedBy) && (
        <div className="flex gap-3 pt-1 border-t border-border/50">
          {status && <span>status: {status}</span>}
          {respondedBy && <span>by: {respondedBy}</span>}
        </div>
      )}
    </div>
  );
}

function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Fold the server-side per-provider usage rollup (camelCase on the wire) into a
// single header snapshot. Terminal tasks carry this; live fallback (last usage
// message) is a Batch 3 concern.
function usageSnapshotFromTask(task: AgentTask): UsageSnapshot | null {
  const entries = task.usage;
  if (!entries || entries.length === 0) return null;
  const acc: UsageSnapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let any = false;
  for (const e of entries) {
    if (e.inputTokens) { acc.inputTokens = (acc.inputTokens ?? 0) + e.inputTokens; any = true; }
    if (e.outputTokens) { acc.outputTokens = (acc.outputTokens ?? 0) + e.outputTokens; any = true; }
    if (e.totalTokens) { acc.totalTokens = (acc.totalTokens ?? 0) + e.totalTokens; any = true; }
    if (e.model) acc.model = e.model;
  }
  return any ? acc : null;
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
