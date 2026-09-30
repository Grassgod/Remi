"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TraceEvent } from "@multiremi/contracts/trace";
import { api, TraceEventSchema, type TaskTraceRead } from "@multiremi/core/api";
import { useTraceStreamSubscription } from "@multiremi/core/realtime";
import type { AgentTask } from "@multiremi/core/types/agent";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import { buildTraceTimeline } from "./build-timeline";

const ACTIVE_TASK_STATUSES = new Set(["dispatched", "running", "waiting_local_directory", "awaiting_human"]);

function mergeEvents(current: TraceEvent[], incoming: readonly TraceEvent[]): TraceEvent[] {
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function TaskTraceDialog({
  task,
  agentName,
  onOpenChange,
  headerSlot,
}: {
  task: AgentTask;
  agentName: string;
  onOpenChange: (open: boolean) => void;
  headerSlot?: React.ReactNode;
}) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [result, setResult] = useState<TaskTraceRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mounted = useRef(true);

  const read = useCallback(async (afterSeq = 0) => {
    setLoading(true);
    setError(false);
    try {
      let cursor = afterSeq;
      for (;;) {
        const page = await api.getTaskTrace(task.id, cursor);
        if (!mounted.current) return;
        setResult(page);
        setEvents((current) => mergeEvents(current, page.events));
        if (page.state !== "ok" || page.eof) break;
        if (page.next_after_seq <= cursor) throw new Error("Trace cursor did not advance");
        cursor = page.next_after_seq;
      }
    } catch {
      if (mounted.current) setError(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [task.id]);

  useEffect(() => {
    mounted.current = true;
    void read();
    return () => { mounted.current = false; };
  }, [read]);

  useTraceStreamSubscription(task.id, {
    onFrames: (frames) => {
      const incoming: TraceEvent[] = [];
      for (const frame of frames) {
        if (frame.kind !== "trace") continue;
        const parsed = TraceEventSchema.safeParse(frame.payload);
        if (parsed.success) incoming.push(parsed.data);
      }
      if (incoming.length > 0) setEvents((current) => mergeEvents(current, incoming));
    },
    onAck: (ack) => { if (ack.gap) void read(Math.max(0, ack.gap.from - 1)); },
    onGap: (gap) => { void read(Math.max(0, gap.from - 1)); },
  }, ACTIVE_TASK_STATUSES.has(task.status) && !result?.closed);

  const items = useMemo(() => buildTraceTimeline(events), [events]);
  return (
    <AgentTranscriptDialog
      open
      onOpenChange={onOpenChange}
      task={task}
      items={items}
      agentName={agentName}
      isLive={ACTIVE_TASK_STATUSES.has(task.status) && !result?.closed}
      headerSlot={headerSlot}
      traceResult={result}
      traceLoading={loading}
      traceError={error}
      onTraceRetry={() => void read(0)}
    />
  );
}
