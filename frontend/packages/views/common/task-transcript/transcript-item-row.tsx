"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { TraceItem, TraceItemOf } from "@multiremi/contracts/trace";
import {
  AlertCircle,
  BookOpen,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  CircleHelp,
  FileText,
  Globe,
  ListChecks,
  Loader2,
  MessageSquare,
  MessageSquareMore,
  Pencil,
  ShieldQuestion,
  SquareTerminal,
  TextSelect,
  Wrench,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { Markdown } from "../markdown";
import { useT } from "../../i18n";
import { colorClasses, formatEventTime, formatStepDuration, getItemColor, getItemLabel, getItemSummary, itemDurationMs } from "./event-format";
import { CommandDetail, DiffDetail, TRACE_DETAIL_MONO } from "./trace-item-detail";

interface TranscriptItemRowProps {
  item: TraceItem;
  /** The items this one owns (a subagent's steps), from the dialog's index. */
  childItems: readonly TraceItem[];
  /** Children of any item, for nested subagents; a stable function so memoized rows stay put. */
  getChildren: (id: string) => readonly TraceItem[];
  selectedId: string | null;
  liveFollow: boolean;
  /** The task itself has finished, so an item still marked running never will. */
  taskTerminal: boolean;
  /** Registers this row's element for its own id and its children's (timeline navigation). */
  registerRow?: (id: string, element: HTMLDivElement | null) => void;
}


function itemIcon(item: TraceItem): LucideIcon {
  switch (item.type) {
    case "user_message": return item.origin === "steer" ? MessageSquareMore : MessageSquare;
    case "agent_message": return MessageSquare;
    case "reasoning": return Brain;
    case "command": return item.actions.length > 0 && item.actions.every((action) => action.type === "read") ? BookOpen : SquareTerminal;
    case "file_change": return Pencil;
    case "web_search": return Globe;
    case "tool": return Wrench;
    case "subagent": return Bot;
    case "plan": return ListChecks;
    case "permission": return ShieldQuestion;
    case "question": return CircleHelp;
    case "compaction": return TextSelect;
    case "notice": return item.severity === "error" ? AlertCircle : FileText;
  }
}

function hasDetail(item: TraceItem, childCount: number): boolean {
  switch (item.type) {
    case "user_message":
    case "agent_message":
    case "reasoning":
      return item.text.length > 0;
    case "command":
    case "file_change":
      return true;
    case "web_search":
      return !!item.output || !!item.url || !!item.query;
    case "tool":
      return !!item.output || !!item.input;
    case "subagent":
      return !!item.prompt || !!item.output || childCount > 0;
    case "plan":
      return item.entries.length > 0;
    case "permission":
    case "question":
      return true;
    case "compaction":
      return !!item.summary || !!item.error || item.pre_tokens != null;
    case "notice":
      return !!item.description || !!item.category || !!item.error_kind;
  }
}

/**
 * One item of the execution dialog: status, type badge, summary, timing;
 * expands to its full record. Memoized: a live frame re-renders only the rows
 * whose item (or children) it changed.
 */
export const TranscriptItemRow = memo(function TranscriptItemRow({
  item,
  childItems: children,
  getChildren,
  selectedId,
  liveFollow,
  taskTerminal,
  registerRow,
}: TranscriptItemRowProps) {
  const { t } = useT("agents");
  const [expanded, setExpanded] = useState(false);
  const autoExpanded = useRef(false);
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (!registerRow) return;
    registerRow(item.id, element);
    for (const child of children) registerRow(child.id, element);
  }, [registerRow, item.id, children]);
  const running = item.status === "in_progress";
  // An item the finished task never closed: not running, just unfinished.
  const abandoned = running && taskTerminal;
  const detail = hasDetail(item, children.length);
  const Icon = itemIcon(item);
  const color = getItemColor(item);
  const summary = getItemSummary(item);
  const duration = itemDurationMs(item);
  const isSelected = selectedId === item.id || children.some((child) => child.id === selectedId);

  // Open a running subagent once while the dialog tails the task, so its steps
  // appear as they arrive. Only once: a later collapse stays collapsed.
  useEffect(() => {
    if (autoExpanded.current) return;
    if (!liveFollow || !running || item.type !== "subagent") return;
    autoExpanded.current = true;
    setExpanded(true);
  }, [liveFollow, running, item.type]);

  return (
    <div ref={ref} data-transcript-item={item.id} className={cn("group transition-colors", isSelected && "bg-accent/50")}>
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <div className="flex items-start gap-2 px-4 py-2">
          <span className="mt-1 shrink-0">
            {abandoned ? <CircleDashed className="h-3.5 w-3.5 text-muted-foreground/60" />
              : running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-500" />
                : item.status === "failed" ? <XCircle className="h-3.5 w-3.5 text-destructive" />
                  : item.status === "stopped" || item.status === "declined" ? <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
          </span>
          <span className={cn("mt-0.5 inline-flex min-w-[60px] shrink-0 items-center justify-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium", colorClasses[color].label)}>
            <Icon className="h-3 w-3 shrink-0" />
            {getItemLabel(item)}
          </span>
          {children.length > 0 && (
            <span className="mt-0.5 inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t(($) => $.transcript.nested_steps, { count: children.length })}
            </span>
          )}
          {abandoned && (
            <span className="mt-0.5 inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t(($) => $.transcript.step_not_finished)}
            </span>
          )}
          {item.type === "user_message" && item.steer?.result?.via === "none" && (
            // Recorded after the force-answer grace expired: the agent never saw it (ADR 0020).
            <span className="mt-0.5 inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t(($) => $.transcript.steer_not_delivered)}
            </span>
          )}
          <CollapsibleTrigger disabled={!detail}
            className={cn("min-w-0 flex-1 py-0.5 text-left text-xs text-muted-foreground transition-colors",
              detail ? "cursor-pointer hover:text-foreground" : "cursor-default",
              item.type === "notice" && item.severity === "error" && "text-destructive",
              item.type === "user_message" && item.origin === "steer" && "font-medium text-foreground")}>
            <div className="flex items-start gap-1.5">
              {detail && <ChevronRight className={cn("mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-90")} />}
              <span className={cn("truncate", (item.type === "command" || item.type === "tool") && "font-mono")}>
                {summary || "(empty)"}
              </span>
            </div>
          </CollapsibleTrigger>
          <span className="mt-1 flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-muted-foreground/50">
            {duration != null && <span>{formatStepDuration(duration)}</span>}
            <span>{formatEventTime(item.started_at)}</span>
          </span>
        </div>
        {detail && (
          <CollapsibleContent>
            <div className="ml-[72px] space-y-2 px-4 pb-3">
              <ItemDetail item={item} />
              {children.length > 0 && (
                <div className="divide-y border-l-2 border-border pl-2">
                  {children.map((child) => (
                    <TranscriptItemRow key={child.id} item={child} childItems={getChildren(child.id)}
                      getChildren={getChildren} selectedId={selectedId} liveFollow={liveFollow} taskTerminal={taskTerminal} />
                  ))}
                </div>
              )}
              {item.type === "subagent" && item.output && (
                // The subagent's final report — Markdown, not a JSON dump.
                <div className="max-h-96 overflow-auto rounded border bg-muted/40 p-3 text-xs">
                  <Markdown mode="minimal">{item.output}</Markdown>
                </div>
              )}
            </div>
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
});

const PRE = cn(TRACE_DETAIL_MONO, "max-h-60 overflow-auto rounded border bg-muted/40 p-3 text-[11px] text-muted-foreground whitespace-pre-wrap break-all");

function prettyOutput(output: string): string {
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
  } catch { /* plain text */ }
  return output;
}

function ItemDetail({ item }: { item: TraceItem }) {
  switch (item.type) {
    case "user_message":
    case "agent_message":
    case "reasoning":
      return (
        <div className="max-h-96 overflow-auto rounded border bg-muted/40 p-3 text-xs">
          <Markdown mode="minimal">{item.text}</Markdown>
        </div>
      );
    case "command":
      return <CommandDetail command={item.command} output={item.output} status={item.status} exitCode={item.exit_code}
        truncated={item.output_truncated === true} />;
    case "file_change":
      return item.changes.length ? (
        <div className="space-y-2">{item.changes.map((change, index) => <DiffDetail key={`${change.path}:${index}`} change={change} />)}</div>
      ) : item.output ? <pre className={PRE}>{item.output}</pre> : null;
    case "web_search":
      return (
        <>
          {(item.url || item.query) && <div className="break-all text-xs text-foreground">{item.url ?? item.query}</div>}
          {item.output && <pre className={PRE}>{prettyOutput(item.output)}</pre>}
        </>
      );
    case "tool":
      return (
        <>
          {item.input && Object.keys(item.input).length > 0 && <pre className={PRE}>{JSON.stringify(item.input, null, 2)}</pre>}
          {item.output && <pre className={PRE}>{prettyOutput(item.output)}</pre>}
        </>
      );
    case "subagent":
      return item.prompt ? (
        <div className="max-h-60 overflow-auto rounded border bg-muted/40 p-3 text-xs">
          <Markdown mode="minimal">{item.prompt}</Markdown>
        </div>
      ) : null;
    case "plan":
      return <PlanEntries entries={item.entries} />;
    case "permission":
      return <PermissionDetail item={item} />;
    case "question":
      return <QuestionDetail item={item} />;
    case "compaction":
      return (
        <div className="space-y-1 rounded border bg-muted/40 p-3 text-[11px] text-muted-foreground">
          {item.trigger && <div>{item.trigger}</div>}
          {item.pre_tokens != null && item.post_tokens != null && <div className="tabular-nums">{item.pre_tokens} → {item.post_tokens}</div>}
          {item.error && <div className="text-destructive">{item.error}</div>}
          {item.summary && <div className="whitespace-pre-wrap text-foreground">{item.summary}</div>}
        </div>
      );
    case "notice":
      return (
        <div className="space-y-1 rounded border bg-muted/40 p-3 text-[11px] text-muted-foreground">
          {item.description && <div className="whitespace-pre-wrap text-foreground">{item.description}</div>}
          {(item.category || item.error_kind) && <div>{[item.category, item.error_kind].filter(Boolean).join(" · ")}</div>}
        </div>
      );
  }
}

export function PlanEntries({ entries }: { entries: TraceItemOf<"plan">["entries"] }) {
  return (
    <div className="space-y-1">
      {entries.map((entry, index) => (
        <div key={index} className="flex items-start gap-1.5 text-xs">
          {entry.status === "completed" ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
            : entry.status === "in_progress" ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
              : <div className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border border-muted-foreground/40" />}
          <span className={cn(entry.status === "completed" && "text-muted-foreground line-through")}>{entry.content}</span>
        </div>
      ))}
    </div>
  );
}

// Permission / question exchanges: the options or questions asked and what was
// decided, by whom. The live dock handles answering; this only records it.
function PermissionDetail({ item }: { item: TraceItemOf<"permission"> }) {
  const { t } = useT("agents");
  return (
    <div className="max-h-72 space-y-2 overflow-auto rounded border bg-muted/40 p-3 text-[11px] text-muted-foreground">
      <div className="text-foreground">{item.title}</div>
      {item.options.length > 0 && (
        <div className="space-y-1">
          {item.options.map((option) => {
            const chosen = item.decision?.option_id === option.option_id;
            return (
              <div key={option.option_id} className={cn("flex items-center gap-1.5", chosen && "font-medium text-emerald-600 dark:text-emerald-400")}>
                {chosen ? <Check className="h-3 w-3 shrink-0" /> : <span className="inline-block w-3 shrink-0" />}
                <span>{option.name}</span>
                <span className="text-muted-foreground/60">({option.kind})</span>
              </div>
            );
          })}
        </div>
      )}
      {(item.outcome || item.responded_by) && (
        <div className="flex gap-3 border-t border-border/50 pt-1">
          {item.outcome && <span>{t(($) => $.transcript.human_status, { value: item.outcome })}</span>}
          {item.responded_by && <span>{t(($) => $.transcript.human_responded_by, { value: item.responded_by })}</span>}
        </div>
      )}
    </div>
  );
}

function QuestionDetail({ item }: { item: TraceItemOf<"question"> }) {
  const { t } = useT("agents");
  const answers = item.answers ? Object.entries(item.answers) : [];
  return (
    <div className="max-h-72 space-y-2 overflow-auto rounded border bg-muted/40 p-3 text-[11px] text-muted-foreground">
      {item.message && <div className="whitespace-pre-wrap text-foreground">{item.message}</div>}
      {item.questions.map((question, index) => {
        const q = question && typeof question === "object" ? question as Record<string, unknown> : {};
        const options = Array.isArray(q.options) ? q.options as Array<Record<string, unknown>> : [];
        return (
          <div key={index} className="space-y-0.5">
            <div className="text-foreground">{String(q.question ?? q.header ?? "")}</div>
            {options.length > 0 && <div className="pl-3">{options.map((option, j) => <div key={j}>· {String(option.label ?? option.name ?? "")}</div>)}</div>}
          </div>
        );
      })}
      {answers.length > 0 && (
        <div>
          <span className="text-foreground">{t(($) => $.transcript.human_answer_label)}</span>{" "}
          {answers.map(([, answer]) => answer).join(", ")}
        </div>
      )}
      {item.responded_by && (
        <div className="border-t border-border/50 pt-1">{t(($) => $.transcript.human_responded_by, { value: item.responded_by })}</div>
      )}
    </div>
  );
}
