import { useLocation } from "wouter";
import {
  LayoutDashboard, MessageSquare, KanbanSquare, Brain, BookOpen,
  BarChart3, Activity, FileText, Clock, FolderOpen, Menu, Zap, Bot, Shield, Plug,
  Database, Settings, Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "./ui/scroll-area";

const navItems = [
  { group: "Overview", items: [
    { path: "/", label: "Dashboard", icon: LayoutDashboard },
  ]},
  { group: "Workspace", items: [
    { path: "/conversations", label: "Conversations", icon: MessageSquare },
    { path: "/missions", label: "Missions", icon: KanbanSquare },
    { path: "/memory", label: "Memory", icon: Brain },
    { path: "/wiki", label: "Wiki", icon: BookOpen },
  ]},
  { group: "AI Engine", items: [
    { path: "/agents", label: "Agents", icon: Bot },
    { path: "/skills", label: "Skills", icon: Zap },
    { path: "/mcp", label: "MCP", icon: Plug },
  ]},
  { group: "Observability", items: [
    { path: "/analytics", label: "Analytics", icon: BarChart3 },
    { path: "/traces", label: "Traces", icon: Activity },
    { path: "/logs", label: "Logs", icon: FileText },
    { path: "/scheduler", label: "Scheduler", icon: Clock },
  ]},
  { group: "System", items: [
    { path: "/database", label: "Database", icon: Database },
    { path: "/symlinks", label: "Symlinks", icon: Link2 },
    { path: "/projects", label: "Projects", icon: FolderOpen },
    { path: "/config", label: "Config", icon: Settings },
    { path: "/bot-menu", label: "Bot Menu", icon: Menu },
    { path: "/auth", label: "1Passport", icon: Shield },
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
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary">
          <span className="text-xs font-bold text-primary-foreground">R</span>
        </div>
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-foreground">Remi</span>
          <span className="text-[10px] text-muted-foreground">AI Workspace</span>
        </div>
      </div>

      {/* Nav */}
      <ScrollArea className="flex-1 px-3 py-2">
        {navItems.map(group => (
          <div key={group.group} className="mb-1">
            <div className="px-2 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {group.group}
            </div>
            {group.items.map(item => {
              const active = isActive(item.path, location);
              const Icon = item.icon;
              return (
                <div
                  key={item.path}
                  onClick={() => {
                    if (active) {
                      // Force re-navigation to reset page state (e.g. detail → list)
                      setLocation("/");
                      setTimeout(() => setLocation(item.path), 0);
                    } else {
                      setLocation(item.path);
                    }
                  }}
                  className={cn(
                    "relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-accent text-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground"
                  )}
                >
                  {active && (
                    <div className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-primary" />
                  )}
                  <Icon className={cn("h-4 w-4", active ? "opacity-100" : "opacity-60")} />
                  {item.label}
                </div>
              );
            })}
          </div>
        ))}
      </ScrollArea>

      {/* Footer */}
      <div className="border-t border-sidebar-border px-4 py-3">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <div className={cn("h-2 w-2 rounded-full", daemonPid ? "bg-success" : "bg-destructive")} />
          <span>{daemonPid ? `PID ${daemonPid}` : "Daemon offline"}</span>
        </div>
      </div>
    </aside>
  );
}
