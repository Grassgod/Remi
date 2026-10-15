"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@multiremi/ui/lib/utils";
import { UnicodeSpinner } from "@multiremi/ui/components/common/unicode-spinner";
import type { AgentAvailability } from "@multiremi/core/agents";
import type { ChatPendingTask } from "@multiremi/core/types";
import type { TraceItem } from "@multiremi/contracts/trace";
import { formatElapsedSecs } from "../../common/format";
import { isAwaitingHuman } from "../lib/turn-steps";
import { useT } from "../../i18n";

interface Props {
  /** Server-authoritative pending-task snapshot (`created_at` anchors the timer). */
  pendingTask: ChatPendingTask;
  /** The live trace's items; the last top-level one decides the running stage. */
  items: readonly TraceItem[];
  /** Resolved presence; pass `undefined` to suppress availability hints. */
  availability: AgentAvailability | undefined;
}

interface Stage {
  label: string;
  static?: boolean;
}

type StageKey =
  | "offline"
  | "reconnecting"
  | "queued"
  | "waiting_local_directory"
  | "awaiting_human"
  | "starting_up"
  | "thinking"
  | "typing";

type ToolKey =
  | "running_command"
  | "reading_files"
  | "searching_code"
  | "making_edits"
  | "searching_web"
  | "fallback";

// Pure stage decision returning translation keys. The hook below maps these
// keys into localized labels — keeping the decision pure makes it easy to
// follow the priority rules without translation noise.
export function pickStageKeys(
  status: string | undefined,
  items: readonly TraceItem[],
  availability: AgentAvailability | undefined,
): { stageKey: StageKey; toolKey?: ToolKey; static?: boolean } {
  if (
    (status === "queued" || status === "dispatched") &&
    availability === "offline"
  ) {
    return { stageKey: "offline", static: true };
  }
  if (
    (status === "queued" || status === "dispatched") &&
    availability === "unstable"
  ) {
    return { stageKey: "reconnecting" };
  }
  // Daemon-emitted hold state for the local_directory flow: the project is
  // pinned to a path that another task currently owns. The daemon publishes
  // this status string when it dequeues a task but can't acquire the path
  // lock; the renderer surfaces a dedicated label so the user understands
  // why a queued task isn't moving.
  if (status === "waiting_local_directory") {
    return { stageKey: "waiting_local_directory", static: true };
  }
  // Agent parked on a permission prompt / AskUserQuestion; the interactive
  // card lives in HumanRequestDock — the pill only names the wait state.
  if (status === "awaiting_human") {
    return { stageKey: "awaiting_human", static: true };
  }
  if (status === "queued") return { stageKey: "queued" };
  if (status === "dispatched") return { stageKey: "starting_up" };

  // running: the last top-level item decides the label. A tool names its
  // work while it runs; once it is done the agent is thinking again.
  let last: TraceItem | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.parent_id === null && item.type !== "user_message") { last = item; break; }
  }
  if (!last) return { stageKey: "thinking" };
  if (last.type === "agent_message") return { stageKey: last.status === "in_progress" ? "typing" : "thinking" };
  if (last.status !== "in_progress") return { stageKey: "thinking" };
  const toolKey = toolStage(last);
  return toolKey ? { stageKey: "thinking", toolKey } : { stageKey: "thinking" };
}

function toolStage(item: TraceItem): ToolKey | null {
  switch (item.type) {
    case "command": {
      const kinds = new Set(item.actions.map((action) => action.type));
      if (kinds.size === 1 && kinds.has("read")) return "reading_files";
      if (kinds.size > 0 && [...kinds].every((kind) => kind === "search" || kind === "list_files")) return "searching_code";
      return "running_command";
    }
    case "file_change": return "making_edits";
    case "web_search": return "searching_web";
    case "tool":
    case "subagent": return "fallback";
    default: return null;
  }
}

function useResolveStage(): (
  status: string | undefined,
  items: readonly TraceItem[],
  availability: AgentAvailability | undefined,
) => Stage {
  const { t } = useT("chat");
  return (status, items, availability) => {
    const decision = pickStageKeys(status, items, availability);
    if (decision.toolKey) {
      return {
        label: t(($) => $.status_pill.tools[decision.toolKey!]),
      };
    }
    return {
      label: t(($) => $.status_pill.stages[decision.stageKey]),
      static: decision.static,
    };
  };
}

export function TaskStatusPill({
  pendingTask,
  items,
  availability,
}: Props) {
  const resolveStage = useResolveStage();
  // Anchor: locked on first render. Once set we never reassign — otherwise
  // the timer would visibly snap backwards when an optimistic-seeded
  // `Date.now()` anchor is later replaced by a server-side created_at that
  // happened a few hundred ms earlier. Monotonic elapsed > strict accuracy.
  const anchorRef = useRef<number | null>(null);
  if (anchorRef.current === null) {
    if (pendingTask.created_at) {
      const t = Date.parse(pendingTask.created_at);
      anchorRef.current = Number.isFinite(t) ? t : Date.now();
    } else {
      anchorRef.current = Date.now();
    }
  }
  const anchor = anchorRef.current;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Effective status — defense-in-depth derive on top of the cache. A wait on
  // a person comes first: the server's `awaiting_human`, or a permission or
  // question the trace shows open (the turn's own input item must not flip it
  // to running). Otherwise, once the trace holds any item the daemon has by
  // definition started running; we trust that over a stale cache.
  const status = pendingTask.status === "awaiting_human" || isAwaitingHuman(items) ? "awaiting_human"
    : items.length > 0 ? "running" : pendingTask.status;
  const elapsedSecs = Math.max(0, Math.floor((now - anchor) / 1000));
  const queuedWaitReason = status === "queued" && typeof pendingTask.wait_reason === "string"
    ? pendingTask.wait_reason.trim() : "";
  // A task-specific explanation takes priority over coarse agent availability.
  const stage = queuedWaitReason
    ? { ...resolveStage(status, items, undefined), static: true }
    : resolveStage(status, items, availability);
  const preparationSummary = items.length === 0 && !stage.static
    && (status === "running" || status === "dispatched")
    && typeof pendingTask.progress_summary === "string"
    ? pendingTask.progress_summary.trim() : "";

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 px-1 text-xs text-muted-foreground"
      aria-live="polite"
    >
      {!stage.static && (
        <UnicodeSpinner name="breathe" className="opacity-70" />
      )}
      <span className="truncate">
        <span className={cn(!stage.static && "animate-chat-text-shimmer")}>
          {preparationSummary || stage.label}
        </span>
        <span className="opacity-70"> · {formatElapsedSecs(elapsedSecs)}</span>
      </span>
      {queuedWaitReason && (
        <span className="basis-full min-w-0 break-words">{queuedWaitReason}</span>
      )}
    </div>
  );
}
