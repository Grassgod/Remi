/**
 * Friendly empty state with optional CTA. Used wherever a list is empty.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/70 bg-card/30 px-6 py-12 text-center"
      style={{ animation: "fade-in 0.4s ease-out both" }}
    >
      <div className="mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-muted/40 ring-1 ring-border/60">
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
