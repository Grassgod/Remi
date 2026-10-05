/** Pure display and answer rules shared by live and replayed trace consumers. */
export interface TraceSemanticEvent {
  type: string;
  content?: string | null;
  meta?: Record<string, unknown> | null;
}

export function traceTextPhase(event: TraceSemanticEvent): "final" | "commentary" | undefined {
  const phase = event.meta?.phase;
  if (phase === "final" || phase === "final_answer") return "final";
  return phase === "commentary" ? "commentary" : undefined;
}

export function traceParentToolCallId(event: TraceSemanticEvent): string | undefined {
  const parent = event.meta?.parent_tool_call_id;
  return typeof parent === "string" && parent ? parent : undefined;
}

export function isTerminalTraceToolStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Metadata snapshots may be skipped by the caller, but never cross ownership or phase. */
export function canMergeTraceText(previous: TraceSemanticEvent, next: TraceSemanticEvent): boolean {
  return (previous.type === "text" || previous.type === "thinking")
    && previous.type === next.type
    && traceParentToolCallId(previous) === traceParentToolCallId(next)
    && traceTextPhase(previous) === traceTextPhase(next);
}

const CANDIDATE_FLUSH_TYPES = new Set([
  "thinking", "tool_use", "permission_request", "question_request", "plan", "compaction",
]);

/** Retains answer text only; output/usage events never become an answer. */
export class TraceFinalReplyAccumulator {
  private final = "";
  private candidate = "";

  add(event: TraceSemanticEvent): void {
    if (traceParentToolCallId(event)) return;
    if (event.type !== "text") {
      if (CANDIDATE_FLUSH_TYPES.has(event.type)) this.candidate = "";
      return;
    }
    const phase = traceTextPhase(event);
    if (phase === "final") this.final += event.content ?? "";
    else if (phase === "commentary") this.candidate = "";
    else this.candidate += event.content ?? "";
  }

  answer(): string | null { return this.final.trim() || this.candidate.trim() || null; }
}

export function extractTraceFinalAnswer(events: readonly TraceSemanticEvent[]): string | null {
  const reply = new TraceFinalReplyAccumulator();
  for (const event of events) reply.add(event);
  return reply.answer();
}
