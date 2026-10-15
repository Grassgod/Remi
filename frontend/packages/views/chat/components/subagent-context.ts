"use client";

import { createContext, useContext } from "react";

/**
 * Which trace a steps list draws (PR 5 §6.8), so every subagent entry point
 * opens the panel on the same attempt and stream: the live fold, a finished
 * fold and the panel's own detail provide it. Without an attempt (lists drawn
 * elsewhere) subagent rows do not open anything.
 */
export interface SubagentTraceSource {
  /** The chat the turn belongs to; the panel only shows in that chat. */
  sessionId: string | null;
  attemptId: string | null;
  turnId?: string;
  /** The trace is the running turn's: the panel follows its socket. */
  live: boolean;
}

export const SubagentTraceContext = createContext<SubagentTraceSource>({ sessionId: null, attemptId: null, live: false });

export function useSubagentTraceSource(): SubagentTraceSource {
  return useContext(SubagentTraceContext);
}

/** The spinner cadence the sidebar uses: 60 steps per 2s, still under reduced motion. */
export const SUBAGENT_SPIN = "animate-[spin_2s_steps(60,end)_infinite] motion-reduce:animate-none";
