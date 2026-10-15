"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
} from "@multiremi/ui/components/ai-elements/chain-of-thought";
import { AlertCircle, LoaderCircle } from "lucide-react";
import { formatElapsedMs } from "../../common/format";
import { Markdown } from "../../common/markdown";
import { useTurnTrace, type TurnTraceView } from "../../common/task-transcript/use-task-trace";
import { useT } from "../../i18n";
import {
  buildTurnSteps,
  liveBlockKey,
  liveFoldHeader,
  liveLabel,
  type FoldHeader,
  type LiveLabel,
} from "../lib/turn-steps";
import { TurnStepList } from "./turn-step-list";

/** A live label stays up at least this long before the next one replaces it (Codex). */
export const MIN_LIVE_LABEL_MS = 1000;

const isIdle = (label: LiveLabel) => label.kind === "reasoning" || label.kind === "thinking";

/**
 * Hold each live label for at least `minMs` (Codex keeps an active key up for
 * 1000ms), so fast steps do not flash:
 * - an activity holds against the next activity, against thinking that
 *   follows it and against a breaker that starts streaming — while held, the
 *   finished row or group keeps showing it;
 * - a reasoning heading holds against the next heading.
 * Immediate: the same activity with fresher details (command text that
 * arrived late), thinking giving way to an activity or to a streaming
 * breaker, anything after `quiet`, and the end of the run (`null`), which
 * shows the completed summary at once.
 */
export function useStickyLabel(label: LiveLabel | null, minMs = MIN_LIVE_LABEL_MS): LiveLabel | null {
  const signature = label ? JSON.stringify(label) : "";
  const [shown, setShown] = useState<{ signature: string; label: LiveLabel | null }>(() => ({ signature, label }));
  const since = useRef<number | null>(null);
  if (since.current === null) since.current = Date.now();
  const latest = useRef(label);
  latest.current = label;
  useEffect(() => {
    if (signature === shown.signature) return;
    const next = latest.current;
    const show = () => {
      if (next?.id !== shown.label?.id) since.current = Date.now();
      setShown({ signature, label: next });
    };
    const current = shown.label;
    const immediate = next === null || current === null || current.kind === "quiet" || next.id === current.id
      || (isIdle(current) && !isIdle(next));
    if (immediate) {
      show();
      return;
    }
    const wait = since.current! + minMs - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const timer = setTimeout(show, wait);
    return () => clearTimeout(timer);
  }, [signature, shown, minMs]);
  return shown.label;
}

/** `Date.now()`, ticking on the whole seconds after `anchor` while `active`. */
export function useTickingNow(active: boolean, anchor: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const offset = anchor === null ? 0 : ((current - anchor) % 1000 + 1000) % 1000;
      timer = setTimeout(tick, 1000 - offset);
    };
    tick();
    return () => clearTimeout(timer);
  }, [active, anchor]);
  return now;
}

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

function StepsFold({ kind, title, open, onOpenChange, disabled, children }: {
  kind: "live" | "finished";
  title: string;
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

const REPLY = "text-sm leading-relaxed prose prose-sm dark:prose-invert max-w-none";

/**
 * The turn that is still running, below the log: the steps fold and, once it
 * starts, the final reply. While the agent works the fold reads "Working" /
 * "Working for {t}" and stays open; when the first final item starts it
 * reads "Worked for {t}" and folds away, without waiting for the turn to end.
 * A legacy (v1) trace shows nothing.
 */
export function LiveTurnSteps({ trace }: { trace: Pick<TurnTraceView, "turn" | "items"> }) {
  const { turn, items } = trace;
  const steps = useMemo(() => buildTurnSteps(items), [items]);
  const finalStarted = steps.finals.length > 0;
  const running = !!turn && turn.status === "running" && !finalStarted;
  const start = turn ? Date.parse(turn.started_at) : NaN;
  const now = useTickingNow(running, Number.isFinite(start) ? start : null);
  const label = useStickyLabel(running ? liveLabel(steps) : null);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const headerText = useFoldHeaderText();
  if (!turn) return null;
  const open = userOpen ?? !finalStarted;
  const showFold = steps.processCount > 0 || !finalStarted;
  return (
    <div data-chat-live-turn className="space-y-3">
      {showFold && (
        <StepsFold kind="live" title={headerText(liveFoldHeader(turn, steps.finals, now))} open={open} onOpenChange={setUserOpen}>
          <TurnStepList steps={steps} items={items} live={running && label ? { label, blockKey: liveBlockKey(steps, label) } : undefined} />
        </StepsFold>
      )}
      {steps.finals.map((final) => final.text.trim() ? (
        <div key={final.id} data-chat-live-final className={REPLY}><Markdown>{final.text}</Markdown></div>
      ) : null)}
    </div>
  );
}

/**
 * The steps of a finished turn, folded above its reply (or its failure
 * notice) under "Worked for {t}". Renders only for a card that counted process
 * items. Collapsed by default, and the trace is read only once the reader
 * opens it (MUL-472: Chat never reads a finished turn's trace on its own).
 */
export function FinishedTurnSteps({ attemptId, turnId, header, visible, open, onOpenChange, footer }: {
  attemptId: string;
  turnId?: string;
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
  const read = trace.read;
  const unavailable = read && read.state !== "ok"
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
        <TurnStepList steps={steps} items={trace.items} />
      ) : read?.format === "legacy" ? null : (
        <div className="text-sm text-muted-foreground">{t(($) => $.turn_steps.empty)}</div>
      )}
      {footer && trace.loaded && <div className="mt-3">{footer}</div>}
    </StepsFold>
  );
}
