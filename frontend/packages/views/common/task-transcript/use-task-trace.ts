"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import type { TraceEvent } from "@multiremi/contracts/trace";
import { api, TraceEventSchema, mergeTraceWindow, TRACE_LIVE_WINDOW_SIZE, TRACE_LIVE_WINDOW_BYTES } from "@multiremi/core/api";
import { useTraceStreamSubscription } from "@multiremi/core/realtime";

/** Bounded recent activity for live cards; complete execution is read in the dialog. */
export function useTaskTrace(taskId: string | null | undefined, enabled = true, live = false): TraceEvent[] {
  return useTaskTraceState(taskId, enabled, live).events;
}

export function useTaskTraceState(taskId: string | null | undefined, enabled = true, live = false): {
  events: TraceEvent[]; closed: boolean; error: boolean;
} {
  const qc = useQueryClient();
  const key = useMemo(() => ["task-trace", taskId] as const, [taskId]);
  const currentTask = useRef(taskId);
  currentTask.current = taskId;
  const [terminal, setTerminal] = useState<{ taskId: string; closed: boolean; error: boolean } | null>(null);
  const stop = (closed: boolean, error: boolean) => { if (taskId) setTerminal({ taskId, closed, error }); };
  const { data, isError } = useQuery({
    queryKey: key,
    enabled: enabled && !!taskId,
    staleTime: Infinity,
    queryFn: async () => {
      if (!taskId) return [];
      const head = await api.getTaskTrace(taskId, 0, 1);
      const page = head.state === "ok" && head.head > 1
        ? await api.getTaskTrace(taskId, Math.max(0, head.head - TRACE_LIVE_WINDOW_SIZE), TRACE_LIVE_WINDOW_SIZE)
        : head;
      if (page.closed && currentTask.current === taskId) setTerminal({ taskId, closed: true, error: false });
      return mergeTraceWindow(page.events, qc.getQueryData<TraceEvent[]>(key) ?? [], TRACE_LIVE_WINDOW_SIZE, TRACE_LIVE_WINDOW_BYTES);
    },
  });
  useTraceStreamSubscription(taskId, {
    onFrames: (frames) => {
      const incoming: TraceEvent[] = [];
      for (const frame of frames) {
        if (frame.kind !== "trace") continue;
        const parsed = TraceEventSchema.safeParse(frame.payload);
        if (parsed.success) incoming.push(parsed.data);
      }
      if (incoming.length) qc.setQueryData<TraceEvent[]>(key, (current) => mergeTraceWindow(current ?? [], incoming, TRACE_LIVE_WINDOW_SIZE, TRACE_LIVE_WINDOW_BYTES));
    },
    onAck: (ack) => {
      if (ack.closed && ack.head_seq === 0) stop(true, false);
      if (ack.gap) void qc.invalidateQueries({ queryKey: key });
    },
    onGap: () => { void qc.invalidateQueries({ queryKey: key }); },
    onClosed: () => { stop(true, false); },
    onError: () => { stop(false, true); void qc.invalidateQueries({ queryKey: key }); },
  }, enabled && live && !!taskId && terminal?.taskId !== taskId);
  return { events: data ?? [], closed: terminal !== null && terminal.taskId === taskId && terminal.closed,
    error: isError || (terminal !== null && terminal.taskId === taskId && terminal.error) };
}
