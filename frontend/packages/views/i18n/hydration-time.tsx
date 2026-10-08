"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

const RenderTimeContext = createContext<number | null>(null);
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** The server supplies this timestamp in the same payload as the rendered tree. */
export function HydrationTimeProvider({ now, children }: { now: number; children: ReactNode }) {
  return <RenderTimeContext.Provider value={now}>{children}</RenderTimeContext.Provider>;
}

/** Each streamed subtree uses the server clock until its own hydration finishes. */
export function useHydrationTime(): number | null {
  const renderedAt = useContext(RenderTimeContext);
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return !hydrated ? renderedAt : null;
}
