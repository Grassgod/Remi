import { useState, useCallback } from "react";
import { useLocation } from "wouter";
import {
  LayoutDashboard, MessageSquare, KanbanSquare, Brain,
  BookOpen, BarChart3, Activity, FileText, Clock,
  FolderOpen, Menu, MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";

const primaryTabs = [
  { path: "/", label: "Home", icon: LayoutDashboard },
  { path: "/conversations", label: "Chats", icon: MessageSquare },
  { path: "/missions", label: "Missions", icon: KanbanSquare },
  { path: "/memory", label: "Memory", icon: Brain },
];

const moreItems = [
  { path: "/wiki", label: "Wiki", icon: BookOpen },
  { path: "/analytics", label: "Analytics", icon: BarChart3 },
  { path: "/traces", label: "Traces", icon: Activity },
  { path: "/logs", label: "Logs", icon: FileText },
  { path: "/scheduler", label: "Scheduler", icon: Clock },
  { path: "/projects", label: "Projects", icon: FolderOpen },
  { path: "/bot-menu", label: "Bot Menu", icon: Menu },
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
          className="mobile-only fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
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
          <div className="grid grid-cols-4 gap-1 px-3 pb-3">
            {moreItems.map(item => {
              const active = isActive(item.path, location);
              const Icon = item.icon;
              return (
                <div
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={cn(
                    "flex cursor-pointer flex-col items-center gap-1.5 rounded-lg px-2 py-3 transition-colors",
                    active ? "bg-accent text-foreground" : "text-muted-foreground active:bg-accent/50"
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-[9px] font-medium">{item.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div
        className="mobile-only fixed bottom-0 left-0 right-0 z-30 border-t border-border bg-card/95 backdrop-blur-md"
        style={{ height: "var(--bottom-nav-height)", paddingBottom: "var(--safe-bottom)" }}
      >
        <div className="flex h-full items-center justify-around">
          {primaryTabs.map(tab => {
            const active = isActive(tab.path, location);
            const Icon = tab.icon;
            return (
              <div
                key={tab.path}
                onClick={() => { setSheetOpen(false); setLocation(tab.path); }}
                className={cn(
                  "flex cursor-pointer flex-col items-center gap-1 px-3 py-1.5 transition-colors",
                  active ? "text-foreground" : "text-muted-foreground"
                )}
              >
                <Icon className={cn("h-5 w-5", active && "text-primary")} />
                <span className="text-[9px] font-medium">{tab.label}</span>
              </div>
            );
          })}
          {/* More button */}
          <div
            onClick={() => setSheetOpen(prev => !prev)}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-1 px-3 py-1.5 transition-colors",
              moreActive || sheetOpen ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <MoreHorizontal className="h-5 w-5" />
            <span className="text-[9px] font-medium">More</span>
          </div>
        </div>
      </div>
    </>
  );
}
