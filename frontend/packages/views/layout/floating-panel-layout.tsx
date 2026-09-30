"use client";

import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

const FloatingPanelLayoutContext = createContext({
  rightRailWidth: 0,
  registerRightRail: (_rail: HTMLDivElement | null): void => {},
});

/** Keep floating windows inside the document area, beside its property rail. */
export function FloatingPanelLayout({ children }: { children: ReactNode }) {
  const [rail, registerRightRail] = useState<HTMLDivElement | null>(null);
  const [rightRailWidth, setRightRailWidth] = useState(0);
  useLayoutEffect(() => {
    if (!rail) { setRightRailWidth(0); return; }
    const measure = () => setRightRailWidth(rail.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [rail]);
  const value = useMemo(() => ({ rightRailWidth, registerRightRail }), [rightRailWidth]);
  return <FloatingPanelLayoutContext.Provider value={value}>{children}</FloatingPanelLayoutContext.Provider>;
}

export function useFloatingPanelLayout() {
  return useContext(FloatingPanelLayoutContext);
}
