"use client";

import { useEffect, useRef, useState } from "react";
import { Brain, CheckCircle2, ChevronRight, CircleDashed, Loader2, XCircle } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { Markdown } from "../markdown";
import type { TimelineItem, TranscriptEntry } from "./build-timeline";
import { isStepRunning } from "./build-timeline";
import {
  formatStepDuration,
  isSubagentStep,
  omitKeys,
} from "./event-format";
import {
  formatToolInputSummary,
  formatRunningToolSummary,
  isBashCommandMissing,
  isCollabInput,
  isSubagentActivityInput,
  toolIcon,
} from "./tool-summaries";
import {
  COLLAB_RENDERED_KEYS,
  CollabDetail,
  SUBAGENT_ACTIVITY_KEYS,
  SubagentActivityDetail,
} from "./collab-detail";
import { useT } from "../../i18n";

interface TranscriptStepRowProps {
  step: Extract<TranscriptEntry, { kind: "step" }>;
  selectedSeq: number | null;
  liveFollow: boolean;
  /** The task itself has finished, so a step still marked running never will. */
  taskTerminal: boolean;
}

export const TranscriptStepRow = ({
  ref,
  step,
  selectedSeq,
  liveFollow,
  taskTerminal,
}: TranscriptStepRowProps & { ref?: React.Ref<HTMLDivElement> }) => {
  const { t } = useT("agents");
  const [expanded, setExpanded] = useState(false);
  const autoExpanded = useRef(false);
  const Icon = toolIcon(step.tool, step.input);
  const summary = formatToolInputSummary(step.tool ?? "", step.input);
  const running = isStepRunning(step.status);
  const runningSummary = running && !summary ? formatRunningToolSummary(step.tool, step.meta) : "";
  const commandMissing = isBashCommandMissing(step.tool, step.input, running);
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
  const activityInput = isSubagentActivityInput(step.input) ? step.input : undefined;
  const residualInput = collabInput
    ? omitKeys(collabInput, COLLAB_RENDERED_KEYS)
    : activityInput
      ? omitKeys(activityInput, SUBAGENT_ACTIVITY_KEYS)
      : step.input;
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
                <span className="truncate font-mono">
                  {summary || runningSummary || (running ? t(($) => $.transcript.tool_running) : "")}
                </span>
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
              {activityInput && <SubagentActivityDetail input={activityInput} />}
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
                    ) : (
                      // The subagent's own narrative, interleaved with its tool
                      // steps in the order it happened.
                      <SubagentProse key={`e-${child.seq}`} item={child.item} />
                    ),
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

/**
 * A subagent's prose inside its Agent group. Text reads as prose (Markdown, the
 * same treatment the agent's own replies get); thinking keeps the muted
 * thinking styling used for top-level thought rows.
 */
function SubagentProse({ item }: { item: TimelineItem }) {
  const thinking = item.type === "thinking";
  const body = item.content ?? "";
  if (!body) return null;
  return (
    <div className="px-4 py-1.5 text-xs">
      {thinking ? (
        <div className="flex items-start gap-1.5 text-muted-foreground">
          <Brain className="h-3 w-3 shrink-0 mt-0.5" />
          <span className="whitespace-pre-wrap break-words">{body}</span>
        </div>
      ) : (
        <Markdown mode="minimal">{body}</Markdown>
      )}
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
