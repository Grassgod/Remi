"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@multiremi/ui/components/ai-elements/chain-of-thought";
import { lateSubagents } from "@multiremi/shared/turn-trace";
import { useChatStore } from "@multiremi/core/chat";
import { cn } from "@multiremi/ui/lib/utils";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { formatElapsedMs } from "../../common/format";
import { Markdown } from "../../common/markdown";
import { useTurnTrace, type TurnTraceView } from "../../common/task-transcript/use-task-trace";
import { useT } from "../../i18n";
import { backgroundRunningCount } from "../lib/subagents";
import {
  buildTurnSteps,
  liveBlockKey,
  liveFoldHeader,
  liveLabel,
  type FoldHeader,
} from "../lib/turn-steps";
import { useStickyLabel, useTickingNow } from "./live-hooks";
import { SUBAGENT_SPIN, SubagentTraceContext, type SubagentTraceSource } from "./subagent-context";
import { SubagentCompletionRows } from "./subagent-completion-row";
import { scrollToSubagentRow } from "./subagent-step-row";
import { TurnStepList } from "./turn-step-list";

export { MIN_LIVE_LABEL_MS, useStickyLabel, useTickingNow } from "./live-hooks";

const elapsed = (ms: number) => formatElapsedMs(ms, { rounding: "floor", hours: true });

export function useFoldHeaderText(): (header: FoldHeader) => string {
  const { t } = useT("chat");
  return (header) => {
    switch (header.kind) {
      case "working": return t(($) => $.turn_steps.working);
      case "working_for": return t(($) => $.turn_steps.working_for, { elapsed: elapsed(header.ms) });
      case "worked_for": return t(($) => $.turn_steps.worked_for, { elapsed: elapsed(header.ms) });
      case "stopped_after": return t(($) => $.turn_steps.stopped_after, { elapsed: elapsed(header.ms) });
      default: return t(($) => $.turn_steps.steps);
    }
  };
}

export function StepsFold({ kind, title, open, onOpenChange, disabled, children }: {
  kind: "live" | "finished";
  title: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ChainOfThought open={open} onOpenChange={onOpenChange} data-chat-steps={kind}>
      <ChainOfThoughtHeader disabled={disabled} data-chat-steps-header>{title}</ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        <div className="pt-3 pb-1">{children}</div>
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}

export const REPLY = "text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none";

/** 「· ◐ N 个后台子代理运行中」 after the fold header while background subagents run (PR 5 §6.3). */
function BackgroundRunningSuffix({ count }: { count: number }) {
  const { t } = useT("chat");
  return (
    <span data-fold-background-running>
      <span aria-hidden="true"> · </span>
      <LoaderCircle className={cn("mr-1 -mt-0.5 inline size-3 align-middle text-violet-600 dark:text-violet-300", SUBAGENT_SPIN)} aria-hidden="true" />
      {t(($) => $.turn_steps.background_running, { count })}
    </span>
  );
}

/**
 * The live fold opens and scrolls to a subagent row when the running strip
 * asks for it (a chip click). Only requests made after this fold mounted
 * count: a request left in the store must not re-open the fold and pull the
 * list away from the bottom each time the chat is shown again.
 */
function useRevealRequests(attemptId: string, open: () => void) {
  const reveal = useChatStore((s) => s.subagentReveal);
  const [mountNonce] = useState(() => useChatStore.getState().subagentReveal?.nonce ?? 0);
  useEffect(() => {
    if (!reveal || reveal.nonce <= mountNonce || reveal.attemptId !== attemptId) return;
    open();
    return scrollToSubagentRow(reveal.itemId);
    // `open` is a state setter wrapper; the request (its nonce) drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal, attemptId, mountNonce]);
}

function RevealListener({ attemptId, onReveal }: { attemptId: string; onReveal: () => void }) {
  useRevealRequests(attemptId, onReveal);
  return null;
}

/**
 * The turn that is still running, below the log: the steps fold and, once it
 * starts, the final reply. While the agent works the fold reads "Working" /
 * "Working for {t}" and stays open; when the first final item starts it
 * reads "Worked for {t}" and folds away, without waiting for the turn to end.
 * While background subagents run the header adds 「· N 个后台子代理运行中」
 * (not forced open), and subagents that end after the reply started get a
 * completion row under it. A legacy (v1) trace shows nothing.
 */
export function LiveTurnSteps({ trace, sessionId = null }: { trace: Pick<TurnTraceView, "turn" | "items">; sessionId?: string | null }) {
  const { turn, items } = trace;
  const steps = useMemo(() => buildTurnSteps(items), [items]);
  const finalStarted = steps.finals.length > 0;
  const running = !!turn && turn.status === "running" && !finalStarted;
  const start = turn ? Date.parse(turn.started_at) : NaN;
  const now = useTickingNow(running, Number.isFinite(start) ? start : null);
  const label = useStickyLabel(running ? liveLabel(steps) : null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const headerText = useFoldHeaderText();
  const finalStartedAt = steps.finals[0]?.started_at ?? null;
  const late = useMemo(() => lateSubagents(items, finalStartedAt, Number.MAX_SAFE_INTEGER), [items, finalStartedAt]);
  const hasSubagents = useMemo(() => items.some((item) => item.type === "subagent"), [items]);
  const source = useMemo<SubagentTraceSource | null>(() => turn
    ? { sessionId, attemptId: turn.id, turnId: turn.turn_id ?? undefined, live: true } : null, [sessionId, turn?.id, turn?.turn_id]);
  if (!turn || !source) return null;
  const open = userOpen ?? !finalStarted;
  const showFold = steps.processCount > 0 || !finalStarted;
  const background = backgroundRunningCount(items, finalStarted);
  const header = headerText(liveFoldHeader(turn, steps.finals, now));
  return (
    <SubagentTraceContext.Provider value={source}>
      <div data-chat-live-turn className="space-y-3">
        {hasSubagents && <RevealListener attemptId={turn.id} onReveal={() => setUserOpen(true)} />}
        {showFold && (
          <StepsFold kind="live" open={open} onOpenChange={setUserOpen}
            title={background > 0 ? <>{header}<BackgroundRunningSuffix count={background} /></> : header}>
            <TurnStepList steps={steps} items={items} live={running && label ? { label, blockKey: liveBlockKey(steps, label) } : undefined} />
          </StepsFold>
        )}
        {steps.finals.map((final) => final.text.trim() ? (
          <div key={final.id} data-chat-live-final className={REPLY}><Markdown>{final.text}</Markdown></div>
        ) : null)}
        {late.length > 0 && <SubagentCompletionRows late={late} source={{ ...source, attemptId: turn.id }} />}
      </div>
    </SubagentTraceContext.Provider>
  );
}

/**
 * The steps of a finished turn, folded above its reply (or its failure
 * notice) under "Worked for {t}". Renders only for a card that counted process
 * items. Collapsed by default, and the trace is read only once the reader
 * opens it (MUL-472: Chat never reads a finished turn's trace on its own).
 */
export function FinishedTurnSteps({ attemptId, turnId, sessionId = null, header, visible, open, onOpenChange, footer }: {
  attemptId: string;
  turnId?: string;
  /** The chat the turn belongs to: its subagent rows open the panel there. */
  sessionId?: string | null;
  header: FoldHeader;
  visible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rendered under the steps once they load: the execution-log button. */
  footer?: ReactNode;
}) {
  const { t } = useT("chat");
  const { t: ta } = useT("agents");
  const headerText = useFoldHeaderText();
  const trace = useTurnTrace(attemptId, { enabled: visible && open, live: false, turnId });
  const steps = useMemo(() => buildTurnSteps(trace.items), [trace.items]);
  const source = useMemo<SubagentTraceSource>(() => ({ sessionId, attemptId, turnId, live: false }), [sessionId, attemptId, turnId]);
  const read = trace.read;
  // The cache can hold the live phase's first read, which may have landed before
  // the daemon had a trace (`not_found`) while the stream supplied every item.
  const unavailable = read && read.state !== "ok" && !trace.items.length
    ? read.state === "unreachable" ? ta(($) => $.transcript.trace_unreachable, { name: read.runtime_name ?? read.runtime_id ?? "" })
      : read.state === "lost" ? ta(($) => $.transcript.trace_lost) : ta(($) => $.transcript.trace_not_found)
    : null;
  return (
    <StepsFold kind="finished" title={headerText(header)} open={open} onOpenChange={onOpenChange} disabled={!visible}>
      {trace.error ? (
        <div role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="size-4" aria-hidden="true" />
          {t(($) => $.turn_steps.load_failed)}
          <button type="button" onClick={trace.retry} className="underline underline-offset-2 hover:text-foreground">
            {t(($) => $.turn_steps.retry)}
          </button>
        </div>
      ) : !trace.loaded ? (
        <div role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {t(($) => $.turn_steps.loading)}
        </div>
      ) : unavailable ? (
        <div className="text-sm text-muted-foreground">{unavailable}</div>
      ) : steps.blocks.length > 0 ? (
        <SubagentTraceContext.Provider value={source}>
          <TurnStepList steps={steps} items={trace.items} />
        </SubagentTraceContext.Provider>
      ) : read?.format === "legacy" ? null : (
        <div className="text-sm text-muted-foreground">{t(($) => $.turn_steps.empty)}</div>
      )}
      {footer && trace.loaded && <div className="mt-3">{footer}</div>}
    </StepsFold>
  );
}
