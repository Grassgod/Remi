"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TraceEvent } from "@multiremi/contracts/trace";
import { api, TraceEventSchema, mergeTraceWindow, TRACE_VIEW_WINDOW_SIZE, TRACE_LIVE_WINDOW_SIZE, TRACE_HISTORY_WINDOW_BYTES, TRACE_LIVE_WINDOW_BYTES, type TaskTraceRead } from "@multiremi/core/api";
import { useTraceStreamSubscription } from "@multiremi/core/realtime";
import type { AgentTask } from "@multiremi/core/types/agent";
import { AgentTranscriptDialog } from "./agent-transcript-dialog";
import { buildTraceTimeline, extractContextUsage, extractExecutionModel, type ExecutionModelSnapshot } from "./build-timeline";

const ACTIVE_TASK_STATUSES = new Set(["dispatched", "running", "waiting_local_directory", "awaiting_human"]);
const TRACE_PAGE_SIZE = 200;

export function TaskTraceDialog(props: TaskTraceDialogProps) {
  // Each task owns its pending reads, events and transcript selection state.
  return <TaskTraceDialogView key={props.task.id} {...props} />;
}

interface TaskTraceDialogProps {
  task: AgentTask;
  agentName: string;
  onOpenChange: (open: boolean) => void;
  headerSlot?: React.ReactNode;
  promptFallback?: React.ReactNode;
  initialView?: "execution" | "prompt";
}

function TaskTraceDialogView({
  task,
  agentName,
  onOpenChange,
  headerSlot,
  promptFallback,
  initialView,
}: TaskTraceDialogProps) {
  const [history, setHistory] = useState<TraceEvent[]>([]);
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);
  const [executionModel, setExecutionModel] = useState<ExecutionModelSnapshot | null>(null);
  const events = useMemo(() => mergeTraceWindow(history, liveEvents, TRACE_VIEW_WINDOW_SIZE + TRACE_LIVE_WINDOW_SIZE, TRACE_HISTORY_WINDOW_BYTES + TRACE_LIVE_WINDOW_BYTES), [history, liveEvents]);
  const [result, setResult] = useState<TaskTraceRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const mounted = useRef(true);
  const reading = useRef(false);
  const cursor = useRef(0);
  const closed = useRef(false);
  const [streamFailed, setStreamFailed] = useState(false);
  const [traceClosed, setTraceClosed] = useState(false);
  const [open, setOpen] = useState(true);

  const read = useCallback(async (afterSeq = cursor.current) => {
    if (reading.current || !mounted.current) return;
    reading.current = true;
    setLoading(true);
    setError(false);
    try {
      const page = await api.getTaskTrace(task.id, afterSeq, TRACE_PAGE_SIZE, task.turn_id);
      if (!mounted.current) return;
      if (page.state === "ok" && !page.eof && page.next_after_seq <= afterSeq) {
        throw new Error("Trace cursor did not advance");
      }
      // Only HTTP advances the contiguous history cursor. Live suffixes may
      // arrive before the middle pages have been requested.
      cursor.current = page.next_after_seq;
      closed.current ||= page.closed;
      setTraceClosed(closed.current);
      setResult({ ...page, closed: closed.current });
      setExecutionModel((current) => extractExecutionModel(page.events, current));
      setHistory((current) => mergeTraceWindow(current, page.events));
    } catch {
      if (mounted.current) setError(true);
    } finally {
      reading.current = false;
      if (mounted.current) setLoading(false);
    }
  }, [task.id, task.turn_id]);

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
      if (incoming.length > 0) {
        setExecutionModel((current) => extractExecutionModel(incoming, current));
        setLiveEvents((current) => mergeTraceWindow(current, incoming, TRACE_LIVE_WINDOW_SIZE, TRACE_LIVE_WINDOW_BYTES));
      }
    },
    // Missing history stays on the same bounded paging path. A replay's suffix
    // must never jump over pages the viewer has not loaded yet.
    onAck: (ack) => {
      if (ack.closed && ack.head_seq === 0) {
        closed.current = true;
        setTraceClosed(true);
        setResult((current) => current ? { ...current, closed: true } : current);
      }
      if (ack.gap && (result?.eof ?? false)) void read();
    },
    onGap: () => { if (result?.eof) void read(); },
    onClosed: () => {
      closed.current = true;
      setTraceClosed(true);
      setResult((current) => current ? { ...current, closed: true } : current);
    },
    onError: () => { setStreamFailed(true); setError(true); },
  }, open && ACTIVE_TASK_STATUSES.has(task.status) && !traceClosed && !streamFailed);

  const items = useMemo(() => buildTraceTimeline(events), [events]);
  const contextUsage = useMemo(() => extractContextUsage(events), [events]);
  const coverageHead = Math.max(result?.head ?? 0, events.at(-1)?.seq ?? 0);
  const traceComplete = result?.eof === true && events.length === coverageHead
    && events.every((event, index) => event.seq === index + 1);
  return (
    <AgentTranscriptDialog
      open={open}
      onOpenChange={(value) => { setOpen(value); onOpenChange(value); }}
      task={task}
      items={items}
      contextUsage={contextUsage}
      traceModel={executionModel?.model}
      agentName={agentName}
      isLive={open && ACTIVE_TASK_STATUSES.has(task.status) && !traceClosed && !streamFailed}
      headerSlot={headerSlot}
      promptFallback={promptFallback}
      initialView={initialView}
      traceResult={result}
      traceLoading={loading}
      traceError={error}
      onTraceRetry={() => { setStreamFailed(false); void read(); }}
      onTraceLoadMore={result?.state === "ok" && !result.eof ? () => void read() : undefined}
      onTraceRestart={cursor.current > TRACE_PAGE_SIZE || (history[0]?.seq ?? 1) > 1 ? () => {
        if (reading.current) return;
        cursor.current = 0;
        setHistory([]);
        void read(0);
      } : undefined}
      traceWindowLimit={TRACE_VIEW_WINDOW_SIZE + TRACE_LIVE_WINDOW_SIZE}
      traceComplete={traceComplete}
    />
  );
}
