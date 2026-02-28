import { useLocation, useRoute } from "wouter";
import {
  IconDashboard, IconMemory, IconSessions, IconAuth,
  IconScheduler, IconTools, IconConfig, IconMonitor,
} from "./icons";

const navItems = [
  { group: "Core", items: [
    { path: "/", label: "Dashboard", icon: IconDashboard },
  ]},
  { group: "Data", items: [
    { path: "/memory", label: "Memory", icon: IconMemory },
    { path: "/sessions", label: "Sessions", icon: IconSessions },
  ]},
  { group: "System", items: [
    { path: "/auth", label: "Auth", icon: IconAuth },
    { path: "/scheduler", label: "Scheduler", icon: IconScheduler },
    { path: "/tools", label: "Tools", icon: IconTools },
    { path: "/config", label: "Config", icon: IconConfig },
    { path: "/monitor", label: "Monitor", icon: IconMonitor },
  ]},
];

function isActive(path: string, location: string): boolean {
  if (path === "/") return location === "/" || location === "";
  return location.startsWith(path);
}

export function Sidebar({ daemonPid }: { daemonPid: number | null }) {
  const [location, setLocation] = useLocation();

  return (
    <aside className="desktop-only" style={{
      width: "var(--sidebar-width)",
      background: "var(--bg-surface)",
      borderRight: "1px solid var(--border-glow)",
      flexDirection: "column",
      flexShrink: 0,
      backdropFilter: "blur(20px)",
    }}>
      {/* Brand */}
      <div style={{
        height: "var(--header-height)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        borderBottom: "1px solid var(--border-glow)",
        gap: 10,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: "50%",
          border: "1.5px solid var(--glow-primary)",
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "ring-pulse 3s ease-in-out infinite",
          boxShadow: "0 0 12px rgba(var(--glow-primary-rgb), 0.3), inset 0 0 8px rgba(var(--glow-primary-rgb), 0.1)",
        }}>
          <span style={{
            fontFamily: "var(--font-display)", fontSize: 11,
            fontWeight: 700, color: "var(--glow-primary)", letterSpacing: 1,
          }}>R</span>
        </div>
        <span style={{
          fontFamily: "var(--font-display)", fontSize: 14, fontWeight: 600,
          color: "var(--glow-primary)", letterSpacing: 3, textTransform: "uppercase",
        }}>Remi</span>
        <span style={{
          fontFamily: "var(--font-mono)", fontSize: 9,
          color: "var(--text-muted)", marginLeft: "auto",
        }}>0.1.0</span>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: "8px 6px", overflowY: "auto" }}>
        {navItems.map(group => (
          <div key={group.group}>
            <div style={{
              fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 2,
              textTransform: "uppercase", color: "var(--text-dim)",
              padding: "14px 12px 5px",
            }}>{group.group}</div>
            {group.items.map(item => {
              const active = isActive(item.path, location);
              return (
                <div
                  key={item.path}
                  onClick={() => setLocation(item.path)}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    padding: "8px 12px", borderRadius: 4, cursor: "pointer",
                    fontFamily: "var(--font-body)", fontSize: 13.5, fontWeight: 500,
                    letterSpacing: 0.5, position: "relative",
                    color: active ? "var(--glow-primary)" : "var(--text-muted)",
                    background: active ? "rgba(var(--glow-primary-rgb), 0.06)" : "transparent",
                    border: `1px solid ${active ? "rgba(var(--glow-primary-rgb), 0.2)" : "transparent"}`,
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={e => {
                    if (!active) {
                      e.currentTarget.style.color = "var(--text-primary)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.borderColor = "var(--border-glow)";
                    }
                  }}
                  onMouseLeave={e => {
                    if (!active) {
                      e.currentTarget.style.color = "var(--text-muted)";
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.borderColor = "transparent";
                    }
                  }}
                >
                  {active && (
                    <div style={{
                      position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
                      width: 2, height: 16, background: "var(--glow-primary)",
                      boxShadow: "0 0 8px rgba(var(--glow-primary-rgb), 0.6)",
                      borderRadius: "0 1px 1px 0",
                    }} />
                  )}
                  <span style={{ opacity: active ? 1 : 0.5, flexShrink: 0 }}>
                    <item.icon />
                  </span>
                  {item.label}
                </div>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ padding: "10px 14px", borderTop: "1px solid var(--border-glow)" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)",
        }}>
          <div style={{
            width: 6, height: 6, borderRadius: "50%",
            background: daemonPid ? "var(--glow-green)" : "var(--glow-red)",
            boxShadow: daemonPid
              ? "0 0 8px rgba(var(--glow-green-rgb), 0.6)"
              : "0 0 8px rgba(var(--glow-red-rgb), 0.6)",
            animation: daemonPid ? "pulse-dot 2s ease-in-out infinite" : "none",
          }} />
          <span>{daemonPid ? `DAEMON PID ${daemonPid}` : "DAEMON OFFLINE"}</span>
        </div>
      </div>
    </aside>
  );
}
