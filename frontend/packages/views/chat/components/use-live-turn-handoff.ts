"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { turnOutcomeShown, type LiveTurnRef, type TurnLogRow } from "../lib/turn-card";

/** How long a finished turn's live view waits for its outcome to reach the log. */
export const LIVE_TURN_HANDOFF_MS = 4000;

interface HandoffState {
  sessionId: string;
  live: LiveTurnRef | null;
  held: readonly LiveTurnRef[];
}

/**
 * The finished turns of `sessionId` whose live view stays up, oldest first.
 *
 * The pending task moves on (chat-done, a stop, the next queued turn) before
 * the log holds the turn's card and reply: those arrive as stream frames, and
 * the in-memory replica reads each row through the read route. A turn shown
 * live whose outcome is not in `rows` when it leaves is kept until
 * `turnOutcomeShown` finds it (it goes in the render that shows the rows, so
 * the two never show together) or `timeoutMs` passes. A turn that becomes the
 * live one again leaves the list, and another chat starts with none. The
 * caller renders the held turns from their cached trace, above the live one
 * and under the same keys.
 */
export function useLiveTurnHandoff(
  sessionId: string,
  live: LiveTurnRef | null,
  rows: readonly TurnLogRow[],
  timeoutMs = LIVE_TURN_HANDOFF_MS,
): readonly LiveTurnRef[] {
  const [state, setState] = useState<HandoffState>({ sessionId, live, held: [] });
  let current = state;
  if (state.sessionId !== sessionId) {
    current = { sessionId, live, held: [] };
    setState(current);
  } else if (state.live?.taskId !== live?.taskId || state.live?.turnId !== live?.turnId) {
    const left = state.live && state.live.taskId !== live?.taskId && !turnOutcomeShown(rows, state.live, true) ? state.live : null;
    current = {
      sessionId, live,
      held: [...state.held.filter((turn) => turn.taskId !== live?.taskId && turn.taskId !== left?.taskId), ...(left ? [left] : [])],
    };
    setState(current);
  }
  const held = current.held;
  const shown = useMemo(() => held.filter((turn) => !turnOutcomeShown(rows, turn, true)), [held, rows]);

  // A turn whose outcome landed leaves for good: rows that go again later do
  // not bring its live view back.
  useEffect(() => {
    if (shown.length === held.length) return;
    setState((value) => value.held === held ? { ...value, held: shown } : value);
  }, [held, shown]);

  const since = useRef(new Map<string, number>());
  useEffect(() => {
    const now = Date.now();
    const started = since.current;
    for (const taskId of [...started.keys()]) if (!held.some((turn) => turn.taskId === taskId)) started.delete(taskId);
    for (const turn of held) if (!started.has(turn.taskId)) started.set(turn.taskId, now);
    if (!started.size) return;
    const timer = setTimeout(() => {
      const at = Date.now();
      setState((value) => {
        const kept = value.held.filter((turn) => (started.get(turn.taskId) ?? at) + timeoutMs > at);
        return kept.length === value.held.length ? value : { ...value, held: kept };
      });
    }, Math.max(0, Math.min(...started.values()) + timeoutMs - now));
    return () => clearTimeout(timer);
  }, [held, timeoutMs]);

  return shown;
}
