import type { ReactNode } from "react";
import { useLocation } from "wouter";

interface EvalLayoutProps {
  children: ReactNode;
}

const TABS = [
  { path: "/eval", label: "Dashboard" },
  { path: "/eval/cases", label: "Cases" },
  { path: "/eval/run", label: "Run" },
];

export function EvalLayout({ children }: EvalLayoutProps) {
  const [location, navigate] = useLocation();

  const isActive = (path: string) => {
    if (path === "/eval") return location === "/eval";
    return location.startsWith(path);
  };

  return (
    <div className="flex h-dvh flex-col">
      {/* Header */}
      <header className="flex h-[52px] flex-shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate("/")}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; Home
          </button>
          <span className="text-border">|</span>
          <span className="text-sm font-semibold text-foreground">
            Eval Center
          </span>
        </div>

        {/* Tab nav */}
        <nav className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive(tab.path)
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">{children}</div>
    </div>
  );
}
