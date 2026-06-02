import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { AuthIndicator } from "../components/AuthIndicator";

interface BoardLayoutProps {
  title: string;
  subtitle?: string;
  slug?: string;
  children: ReactNode;
}

export function BoardLayout({ title, subtitle, slug, children }: BoardLayoutProps) {
  const [, navigate] = useLocation();

  return (
    <div className="flex h-dvh flex-col">
      {/* Minimal header */}
      <header className="flex h-[52px] flex-shrink-0 items-center justify-between border-b border-border bg-card px-5">
        <div className="flex items-center gap-3">
          {slug && (
            <button
              onClick={() => navigate(`/board/${slug}`)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              ← Board
            </button>
          )}
          {slug && subtitle && <span className="text-border">|</span>}
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {subtitle && (
            <span className="text-xs text-muted-foreground">{subtitle}</span>
          )}
        </div>
        <AuthIndicator />
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {children}
      </div>
    </div>
  );
}
