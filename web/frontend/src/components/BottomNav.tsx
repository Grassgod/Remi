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
    <div className="mobile-only" style={{
      position: "fixed", bottom: 0, left: 0, right: 0,
      height: "var(--bottom-nav-height)",
      paddingBottom: "var(--safe-bottom)",
      background: "var(--bg-surface)",
      borderTop: "1px solid var(--border-glow)",
      backdropFilter: "blur(20px)",
      zIndex: 30,
      display: "block",
    }}>
      <div style={{
        display: "flex", height: "100%",
        alignItems: "center", justifyContent: "space-around",
      }}>
        {tabs.map(tab => {
          const active = tab.path === "/"
            ? (location === "/" || location === "")
            : location.startsWith(tab.path);
          return (
            <div
              key={tab.path}
              onClick={() => setLocation(tab.path)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "center",
                gap: 3, padding: "6px 10px", cursor: "pointer",
                color: active ? "var(--glow-primary)" : "var(--text-dim)",
                transition: "color 0.15s",
              }}
            >
              <tab.icon />
              <span style={{
                fontFamily: "var(--font-mono)", fontSize: 8,
                letterSpacing: 1, textTransform: "uppercase",
              }}>{tab.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
