import { isTraceEvent, type TraceEventLine, type TraceItem } from "@multiremi/contracts/trace.js";
import { applyTurnTraceEvents, EMPTY_TURN_TRACE, type TurnTraceState } from "@shared/turn-trace.js";

/** Fold the stored lines of a daemon trace (`TraceStore.read().events`) with the shared reducer. */
export function foldTraceLines(events: readonly TraceEventLine[]): TurnTraceState {
  return applyTurnTraceEvents(EMPTY_TURN_TRACE, events.filter(isTraceEvent));
}

/** The folded items of a daemon trace, in first-seen order. */
export function traceItems(events: readonly TraceEventLine[]): readonly TraceItem[] {
  return foldTraceLines(events).items;
}

/** Text of every agent message item, in order. */
export function agentTexts(events: readonly TraceEventLine[]): string[] {
  return traceItems(events).flatMap((item) => item.type === "agent_message" ? [item.text] : []);
}
