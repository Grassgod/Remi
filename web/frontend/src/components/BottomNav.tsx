import { useLocation } from "wouter";
import {
  IconDashboardLg, IconMemoryLg, IconSessionsLg,
  IconConfigLg, IconMonitorLg,
} from "./icons";

const tabs = [
  { path: "/", label: "Home", icon: IconDashboardLg },
  { path: "/memory", label: "Memory", icon: IconMemoryLg },
  { path: "/sessions", label: "Sessions", icon: IconSessionsLg },
  { path: "/config", label: "System", icon: IconConfigLg },
  { path: "/monitor", label: "Monitor", icon: IconMonitorLg },
];

export function BottomNav() {
  const [location, setLocation] = useLocation();

  return (
    <div
      className="mobile-only fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-sidebar"
      style={{ height: "var(--bottom-nav-height)", paddingBottom: "var(--safe-bottom)" }}
    >
      <div className="flex h-full items-center justify-around">
        {tabs.map(tab => {
          const active = tab.path === "/"
            ? (location === "/" || location === "")
            : location.startsWith(tab.path);
          return (
            <div
              key={tab.path}
              onClick={() => setLocation(tab.path)}
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
      </div>
    </div>
  );
}
