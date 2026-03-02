import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  IconDashboardLg, IconMemoryLg, IconSessionsLg, IconAnalyticsLg, IconMoreLg,
  IconProjects, IconAuth, IconScheduler, IconTools, IconConfig, IconMonitor,
} from "./icons";

const primaryTabs = [
  { path: "/", label: "Home", icon: IconDashboardLg },
  { path: "/memory", label: "Memory", icon: IconMemoryLg },
  { path: "/sessions", label: "Sessions", icon: IconSessionsLg },
  { path: "/analytics", label: "Analytics", icon: IconAnalyticsLg },
];

const moreItems = [
  { path: "/projects", label: "Projects", icon: IconProjects },
  { path: "/auth", label: "Auth", icon: IconAuth },
  { path: "/config", label: "Config", icon: IconConfig },
  { path: "/scheduler", label: "Scheduler", icon: IconScheduler },
  { path: "/tools", label: "Tools", icon: IconTools },
  { path: "/monitor", label: "Monitor", icon: IconMonitor },
];

function isActive(path: string, location: string): boolean {
  if (path === "/") return location === "/" || location === "";
  return location.startsWith(path);
}

export function BottomNav() {
  const [location, setLocation] = useLocation();
  const [sheetOpen, setSheetOpen] = useState(false);

  const navigate = useCallback((path: string) => {
    setLocation(path);
    setSheetOpen(false);
  }, [setLocation]);

  const moreActive = moreItems.some(item => isActive(item.path, location));

  return (
    <>
      {/* Backdrop */}
      {sheetOpen && (
        <div
          className="mobile-only fixed inset-0 z-40 bg-black/40"
          onClick={() => setSheetOpen(false)}
          style={{ animation: "fade-in 0.15s ease-out" }}
        />
      )}

      {/* Bottom Sheet */}
      {sheetOpen && (
        <div
          className="mobile-only fixed bottom-[var(--bottom-nav-height)] left-0 right-0 z-50 rounded-t-xl border-t border-border bg-card"
          style={{
            paddingBottom: "var(--safe-bottom)",
            animation: "sheet-up 0.2s ease-out",
          }}
        >
          <div className="mx-auto mb-2 mt-2 h-1 w-8 rounded-full bg-muted-foreground/30" />
          <div className="grid grid-cols-3 gap-1 px-3 pb-3">
            {moreItems.map(item => {
              const active = isActive(item.path, location);
              return (
                <div
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-lg px-2 py-3 transition-colors
                    ${active ? "bg-accent text-foreground" : "text-muted-foreground active:bg-accent/50"}`}
                >
                  <item.icon />
                  <span className="font-mono text-[9px] uppercase tracking-wide">
                    {item.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div
        className="mobile-only fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-sidebar"
        style={{ height: "var(--bottom-nav-height)", paddingBottom: "var(--safe-bottom)" }}
      >
        <div className="flex h-full items-center justify-around">
          {primaryTabs.map(tab => {
            const active = isActive(tab.path, location);
            return (
              <div
                key={tab.path}
                onClick={() => { setSheetOpen(false); setLocation(tab.path); }}
                className={`flex cursor-pointer flex-col items-center gap-1 px-2.5 py-1.5 transition-colors
                  ${active ? "text-foreground" : "text-muted-foreground"}`}
              >
                <tab.icon />
                <span className="font-mono text-[8px] uppercase tracking-wide">
                  {tab.label}
                </span>
              </div>
            );
          })}
          {/* More button */}
          <div
            onClick={() => setSheetOpen(prev => !prev)}
            className={`flex cursor-pointer flex-col items-center gap-1 px-2.5 py-1.5 transition-colors
              ${moreActive || sheetOpen ? "text-foreground" : "text-muted-foreground"}`}
          >
            <IconMoreLg />
            <span className="font-mono text-[8px] uppercase tracking-wide">
              More
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
