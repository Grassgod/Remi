"use client";

import { useState } from "react";
import { AlertCircle, Brain, Check, ChevronRight } from "lucide-react";
import { cn } from "@multiremi/ui/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@multiremi/ui/components/ui/collapsible";
import { Markdown } from "../markdown";
import type { TimelineItem } from "./build-timeline";
import {
  colorClasses,
  formatEventTime,
  getEventColor,
  getEventLabel,
  getEventSummary,
} from "./event-format";
import { useT } from "../../i18n";

interface TranscriptEventRowProps {
  item: TimelineItem;
  isSelected: boolean;
}

export const TranscriptEventRow = ({
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
  const { t } = useT("agents");
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
      {answers.length > 0 && <div><span className="text-foreground">{t(($) => $.transcript.human_answer_label)}</span> {answers.map(String).join(", ")}</div>}
      {(chosen || status || respondedBy) && (
        <div className="flex gap-3 pt-1 border-t border-border/50">
          {status && <span>{t(($) => $.transcript.human_status, { value: status })}</span>}
          {respondedBy && <span>{t(($) => $.transcript.human_responded_by, { value: respondedBy })}</span>}
        </div>
      )}
    </div>
  );
}
