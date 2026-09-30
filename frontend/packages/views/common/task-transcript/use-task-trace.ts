"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { TraceEvent } from "@multiremi/contracts/trace";
import { api, TraceEventSchema } from "@multiremi/core/api";
import { useTraceStreamSubscription } from "@multiremi/core/realtime";

function mergeTraceEvents(current: readonly TraceEvent[], incoming: readonly TraceEvent[]): TraceEvent[] {
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function useTaskTrace(taskId: string | null | undefined, enabled = true, live = false): TraceEvent[] {
  const qc = useQueryClient();
  const key = useMemo(() => ["task-trace", taskId] as const, [taskId]);
  const { data } = useQuery({
    queryKey: key,
    enabled: enabled && !!taskId,
    staleTime: Infinity,
    queryFn: async () => {
      if (!taskId) return [];
      let cursor = 0;
      let events: TraceEvent[] = [];
      for (;;) {
        const page = await api.getTaskTrace(taskId, cursor);
        events = mergeTraceEvents(events, page.events);
        if (page.state !== "ok" || page.eof) {
          return mergeTraceEvents(qc.getQueryData<TraceEvent[]>(key) ?? [], events);
        }
        if (page.next_after_seq <= cursor) throw new Error("Trace cursor did not advance");
        cursor = page.next_after_seq;
      }
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
      if (incoming.length) qc.setQueryData<TraceEvent[]>(key, (current) => mergeTraceEvents(current ?? [], incoming));
    },
    onAck: (ack) => { if (ack.gap) void qc.invalidateQueries({ queryKey: key }); },
    onGap: () => { void qc.invalidateQueries({ queryKey: key }); },
  }, enabled && live && !!taskId);
  return data ?? [];
}
