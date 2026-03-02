import type { ReactNode } from "react";

interface PanelProps {
  title: string;
  icon?: ReactNode;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
  maxHeight?: number;
}

export function Panel({ title, icon, action, children, maxHeight = 360 }: PanelProps) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border bg-card"
      style={{ animation: "fade-in 0.3s ease-out both" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-foreground">
          {icon}
          {title}
        </div>
        {action && (
          <button
            onClick={action.onClick}
            className="rounded-md border border-border bg-transparent px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {action.label}
          </button>
        )}
      </div>
      {/* Content */}
      <div style={{ maxHeight }} className="overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

// Backward-compatible alias
export { Panel as HudPanel };
