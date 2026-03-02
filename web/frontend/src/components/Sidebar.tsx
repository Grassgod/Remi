import { useLocation } from "wouter";
import {
  IconDashboard, IconMemory, IconSessions, IconAuth,
  IconScheduler, IconTools, IconConfig, IconMonitor, IconProjects, IconAnalytics,
  IconTraces, IconLogs,
} from "./icons";

const navItems = [
  { group: "Core", items: [
    { path: "/", label: "Dashboard", icon: IconDashboard },
  ]},
  { group: "Data", items: [
    { path: "/memory", label: "Memory", icon: IconMemory },
    { path: "/sessions", label: "Sessions", icon: IconSessions },
    { path: "/projects", label: "Projects", icon: IconProjects },
    { path: "/analytics", label: "Analytics", icon: IconAnalytics },
    { path: "/traces", label: "Traces", icon: IconTraces },
    { path: "/logs", label: "Logs", icon: IconLogs },
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
    <aside className="desktop-only w-[var(--sidebar-width)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
      {/* Brand */}
      <div className="flex h-[var(--header-height)] items-center gap-3 border-b border-sidebar-border px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-full border border-border">
          <span className="text-xs font-bold text-foreground">R</span>
        </div>
        <span className="text-sm font-semibold tracking-widest text-foreground">
          Remi
        </span>
        <span className="ml-auto font-mono text-[9px] text-muted-foreground">
          0.1.0
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        {navItems.map(group => (
          <div key={group.group}>
            <div className="px-3 pb-1 pt-4 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
              {group.group}
            </div>
            {group.items.map(item => {
              const active = isActive(item.path, location);
              return (
                <div
                  key={item.path}
                  onClick={() => setLocation(item.path)}
                  className={`
                    relative flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2
                    text-sm font-medium transition-colors
                    ${active
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
                    }
                  `}
                >
                  {active && (
                    <div className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-foreground" />
                  )}
                  <span className={active ? "opacity-100" : "opacity-60"}>
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
      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
          <div className={`h-1.5 w-1.5 rounded-full ${daemonPid ? "bg-success" : "bg-destructive"}`} />
          <span>{daemonPid ? `PID ${daemonPid}` : "Daemon offline"}</span>
        </div>
      </div>
    </aside>
  );
}
