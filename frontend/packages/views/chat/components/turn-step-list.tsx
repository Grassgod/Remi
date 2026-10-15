"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommandAction, FileChange, TraceItem } from "@multiremi/contracts/trace";
import type { StepDescriptor } from "@multiremi/shared/trace-step-copy";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { cn } from "@multiremi/ui/lib/utils";
import {
  BookOpen,
  Bot,
  ChevronRight,
  CircleAlert,
  CircleStop,
  Folder,
  Globe,
  ListChecks,
  Pencil,
  Search,
  SquareTerminal,
  TextSelect,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { Markdown } from "../../common/markdown";
import { CommandDetail, DiffDetail, TRACE_DETAIL_MONO } from "../../common/task-transcript/trace-item-detail";
import { useT } from "../../i18n";
import {
  buildChildSteps,
  groupIcon,
  groupSummary,
  joinSummary,
  type LiveLabel,
  type StepBlock,
  type StepIconKind,
  type StepRow,
  type TurnSteps,
} from "../lib/turn-steps";

// The rows of a Chat turn's steps fold, after the Codex app (PLAN §2.5-2.6):
// 14px text, 16px icons 6px from the text, 14px chevrons, 16px between rows
// and 4px inside a group, an expanded group at most 224px with 24px fades, and
// 300ms `cubic-bezier(.19,1,.22,1)` panels. Runs of rows fold under one
// summary; a running row shows a static icon and a cadenced shimmer.

const ICONS: Record<StepIconKind, LucideIcon> = {
  read: BookOpen,
  search: Search,
  list: Folder,
  command: SquareTerminal,
  stopped: CircleStop,
  edit: Pencil,
  web: Globe,
  tool: Wrench,
  subagent: Bot,
  compaction: TextSelect,
  plan: ListChecks,
  notice: CircleAlert,
};

/** Height + fade on Base UI's panel variable; reduced motion switches at once. */
export const STEP_PANEL_MOTION = "h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-300 ease-[cubic-bezier(.19,1,.22,1)] data-[ending-style]:h-0 data-[ending-style]:opacity-0 data-[starting-style]:h-0 data-[starting-style]:opacity-0 motion-reduce:transition-none";
const ROW_TRIGGER = "group/step flex w-full min-w-0 items-center gap-1.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-disabled:cursor-default aria-disabled:hover:text-muted-foreground";
const CHEVRON = "size-3.5 shrink-0 opacity-0 transition-[opacity,transform] duration-300 group-hover/step:opacity-100 group-focus-visible/step:opacity-100 group-data-[panel-open]/step:rotate-90 group-data-[panel-open]/step:opacity-100 motion-reduce:transition-none";
const MONO = TRACE_DETAIL_MONO;

export function StepIcon({ kind, className }: { kind: StepIconKind; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}

/** Translate step copy and group summaries with the current locale's table. */
export function useStepCopy() {
  const { t } = useT("chat");
  return useMemo(() => {
    const step = (descriptor: StepDescriptor): string =>
      t(($) => $.steps[descriptor.key], descriptor.args);
    const summary = (rows: readonly StepRow[]): string => joinSummary(
      groupSummary(rows),
      (fragment) => t(($) => $.steps[fragment.key], { count: fragment.count }),
      t(($) => $.turn_steps.summary_separator),
      t(($) => $.steps.summary_empty),
    );
    const live = (label: LiveLabel): string => label.kind === "step" ? step(label.descriptor)
      : label.kind === "reasoning" ? label.text : label.kind === "quiet" ? "" : t(($) => $.steps.reasoning_active);
    return { step, summary, live };
  }, [t]);
}

/** Running text: static color plus the cadenced sweep (off under reduced motion). */
function LiveText({ children }: { children: ReactNode }) {
  return <span data-step-live className="min-w-0 truncate animate-step-shimmer">{children}</span>;
}

export interface TurnStepListProps {
  steps: TurnSteps;
  /** Every item of the trace, at any depth: subagent details read their children from it. */
  items: readonly TraceItem[];
  /** Present while the turn runs: the label and the block that shows it (null: a trailing line). */
  live?: { label: LiveLabel; blockKey: string | null };
}

export function TurnStepList({ steps, items, live }: TurnStepListProps) {
  const copy = useStepCopy();
  // The label sits on the block that holds its row (even a finished row whose
  // label is still held); thinking goes on a trailing line; `quiet` nowhere.
  const trailing = live && live.blockKey === null && live.label.kind !== "quiet";
  return (
    <div data-turn-step-list className="flex flex-col gap-4">
      {steps.blocks.map((block) => {
        const label = live && live.blockKey === block.key ? live.label : undefined;
        switch (block.kind) {
          case "group": return <StepGroup key={block.key} rows={block.rows} active={block.active} label={label} />;
          case "row": return <StepRowView key={block.key} row={block.row} label={label} />;
          default: return <BreakerView key={block.key} block={block} items={items} />;
        }
      })}
      {trailing && (
        <div data-step-live-line className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          {live.label.kind === "step" && <StepIcon kind={live.label.icon} />}
          <LiveText>{copy.live(live.label)}</LiveText>
        </div>
      )}
    </div>
  );
}

/** A scroll box that fades the edge it can still scroll towards (24px). */
function FadeScroll({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop > 0;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((current) => current.top === top && current.bottom === bottom ? current : { top, bottom });
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [measure]);
  const fade = "#000 24px";
  const mask = edges.top && edges.bottom ? `linear-gradient(to bottom, transparent, ${fade}, #000 calc(100% - 24px), transparent)`
    : edges.top ? `linear-gradient(to bottom, transparent, ${fade})`
      : edges.bottom ? "linear-gradient(to bottom, #000 calc(100% - 24px), transparent)" : undefined;
  return (
    <div ref={ref} onScroll={measure} data-fade-top={edges.top || undefined} data-fade-bottom={edges.bottom || undefined}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      className={cn("-mx-2 max-h-56 overflow-y-auto px-2", className)}>
      {children}
    </div>
  );
}

function StepGroup({ rows, active, label }: { rows: StepRow[]; active: boolean; label?: LiveLabel }) {
  const copy = useStepCopy();
  const [open, setOpen] = useState(false);
  // The live label holds the header while the turn runs; a group whose rows
  // are done reads its summary at once.
  const runningRow = active ? [...rows].reverse().find((r) => r.active) : undefined;
  const live = active || !!label;
  const icon = label?.kind === "step" ? label.icon : runningRow?.icon ?? groupIcon(rows);
  const text = label ? copy.live(label) : runningRow ? copy.step(runningRow.descriptor) : copy.summary(rows);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-step-group={live ? "active" : "done"}>
      <CollapsibleTrigger className={ROW_TRIGGER}>
        <StepIcon kind={icon} />
        {live ? <LiveText>{text}</LiveText> : <span className="min-w-0 truncate">{text}</span>}
        <ChevronRight className={CHEVRON} aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className={STEP_PANEL_MOTION}>
        <FadeScroll className="mt-1">
          <div className="flex flex-col gap-1 py-0.5">
            {rows.map((row) => <StepRowView key={row.key} row={row} grouped />)}
          </div>
        </FadeScroll>
      </CollapsibleContent>
    </Collapsible>
  );
}

function hasRowDetail(row: StepRow): boolean {
  switch (row.item.type) {
    // A single-action read without command text (Codex) has nothing to show.
    case "command": return !!row.item.output || !!((row.part as CommandAction | undefined)?.command ?? row.item.command);
    case "file_change": return !!row.part || row.item.changes.length > 0;
    case "web_search": return !!row.item.output || !!row.item.url;
    case "tool": return !!row.item.output || !!row.item.input;
  }
}

function StepRowView({ row, label, grouped = false }: { row: StepRow; label?: LiveLabel; grouped?: boolean }) {
  const copy = useStepCopy();
  const [open, setOpen] = useState(false);
  const detail = hasRowDetail(row);
  const text = label ? copy.live(label) : copy.step(row.descriptor);
  const fileChange = row.item.type === "file_change" ? (row.part as FileChange | undefined) ?? row.item.changes[0] : undefined;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-step-row={row.key} data-step-state={row.descriptor.state}>
      <CollapsibleTrigger disabled={!detail} className={ROW_TRIGGER}>
        <StepIcon kind={label?.kind === "step" ? label.icon : row.icon} />
        {row.active || label ? <LiveText>{text}</LiveText> : <span className="min-w-0 truncate" title={titleOf(row)}>{text}</span>}
        {fileChange && (fileChange.added > 0 || fileChange.removed > 0) && (
          <span className="flex shrink-0 gap-1 text-xs tabular-nums">
            {fileChange.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{fileChange.added}</span>}
            {fileChange.removed > 0 && <span className="text-red-600 dark:text-red-400">-{fileChange.removed}</span>}
          </span>
        )}
        {detail && <ChevronRight className={CHEVRON} aria-hidden="true" />}
      </CollapsibleTrigger>
      {detail && (
        <CollapsibleContent className={STEP_PANEL_MOTION}>
          <div className={cn(grouped ? "pt-1" : "pt-2 pb-1")}>
            <RowDetail row={row} />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function titleOf(row: StepRow): string | undefined {
  if (row.item.type === "file_change") return (row.part as FileChange | undefined)?.path;
  if (row.item.type === "command") {
    const part = row.part as CommandAction | undefined;
    return (part?.type === "read" ? part.path : part?.command) ?? row.item.command ?? undefined;
  }
  return undefined;
}

function RowDetail({ row }: { row: StepRow }) {
  const item = row.item;
  switch (item.type) {
    case "command": {
      const part = row.part as CommandAction | undefined;
      return <CommandDetail command={part?.command ?? item.command} output={item.output} status={item.status} exitCode={item.exit_code}
        truncated={item.output_truncated === true} />;
    }
    case "file_change": {
      const change = (row.part as FileChange | undefined) ?? item.changes[0];
      return change ? <DiffDetail change={change} /> : null;
    }
    case "web_search":
      return <TextDetail head={item.url ?? item.query} body={item.output} />;
    case "tool":
      return <TextDetail head={item.input ? JSON.stringify(item.input, null, 2) : null} body={item.output} />;
  }
}

function TextDetail({ head, body }: { head: string | null; body: string | null }) {
  const { t } = useT("chat");
  return (
    <div className="overflow-hidden rounded-md border bg-muted/30">
      {head && <pre className={cn(MONO, "max-h-36 overflow-auto whitespace-pre-wrap break-all px-2 py-2 text-foreground")}>{head}</pre>}
      <pre className={cn(MONO, "max-h-36 overflow-auto whitespace-pre-wrap break-words px-2 py-2 text-muted-foreground", head && "border-t")}>
        {body || t(($) => $.turn_steps.no_output)}
      </pre>
    </div>
  );
}

// ── Breakers ────────────────────────────────────────────────────────────────

function BreakerView({ block, items }: { block: Extract<StepBlock, { kind: "breaker" }>; items: readonly TraceItem[] }) {
  const copy = useStepCopy();
  const item = block.item;
  if (item.type === "agent_message") {
    return (
      <div data-step-message className="text-sm leading-[22.75px] text-foreground prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
        <Markdown>{item.text}</Markdown>
      </div>
    );
  }
  const active = item.status === "in_progress";
  const text = copy.step(block.descriptor);
  const detail = breakerDetail(item, items);
  return <BreakerRow icon={block.icon} text={text} active={active} danger={item.type === "notice" && item.severity === "error"}
    itemId={item.id} detail={detail} />;
}

function BreakerRow({ icon, text, active, danger, itemId, detail }: {
  icon: StepIconKind | null; text: string; active: boolean; danger: boolean; itemId: string; detail: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-step-breaker={itemId}>
      <CollapsibleTrigger disabled={!detail} className={cn(ROW_TRIGGER, danger && "text-destructive hover:text-destructive aria-disabled:hover:text-destructive")}>
        {icon && <StepIcon kind={icon} />}
        {active ? <LiveText>{text}</LiveText> : <span className="min-w-0 truncate">{text}</span>}
        {detail && <ChevronRight className={CHEVRON} aria-hidden="true" />}
      </CollapsibleTrigger>
      {detail && (
        <CollapsibleContent className={STEP_PANEL_MOTION}>
          <div className="pt-2 pb-1">{detail}</div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function SubagentDetail({ item, items }: { item: Extract<TraceItem, { type: "subagent" }>; items: readonly TraceItem[] }) {
  const { t } = useT("chat");
  const children = useMemo(() => buildChildSteps(items, item.id), [items, item.id]);
  return (
    <div className="space-y-2">
      {item.prompt && (
        <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
          <div className="mb-1 text-muted-foreground">{t(($) => $.turn_steps.subagent_prompt)}</div>
          <div className="max-h-36 overflow-auto"><Markdown mode="minimal">{item.prompt}</Markdown></div>
        </div>
      )}
      {children.blocks.length > 0 && (
        <div className="border-l pl-3">
          <TurnStepList steps={children} items={items} />
        </div>
      )}
      {item.output && (
        <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs">
          <div className="mb-1 text-muted-foreground">{t(($) => $.turn_steps.subagent_output)}</div>
          <div className="max-h-60 overflow-auto"><Markdown mode="minimal">{item.output}</Markdown></div>
        </div>
      )}
    </div>
  );
}

function breakerDetail(item: TraceItem, items: readonly TraceItem[]): ReactNode {
  switch (item.type) {
    case "subagent":
      return item.prompt || item.output || items.some((child) => child.parent_id === item.id)
        ? <SubagentDetail item={item} items={items} /> : null;
    case "plan":
      return item.entries.length ? (
        <ul className="space-y-1 text-sm">
          {item.entries.map((entry, index) => (
            <li key={index} className="flex items-start gap-1.5">
              <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full border",
                entry.status === "completed" && "border-emerald-500 bg-emerald-500",
                entry.status === "in_progress" && "border-blue-500")} />
              <span className={cn(entry.status === "completed" && "text-muted-foreground line-through")}>{entry.content}</span>
            </li>
          ))}
        </ul>
      ) : null;
    case "compaction":
      return item.summary || item.error ? (
        <div className="max-h-36 overflow-auto rounded-md border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground whitespace-pre-wrap">
          {item.error ?? item.summary}
        </div>
      ) : null;
    case "notice":
      return item.description ? (
        <div className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground whitespace-pre-wrap">{item.description}</div>
      ) : null;
    default:
      return null;
  }
}
