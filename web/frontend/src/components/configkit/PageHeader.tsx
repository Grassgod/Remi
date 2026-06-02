/**
 * Standard page header used by every config page.
 * Layout: title + subtitle on the left, optional badge/count, optional action row on the right.
 * Renders with a subtle fade-in so route transitions feel intentional.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "../ui/badge";

export interface PageHeaderProps {
  icon?: LucideIcon;
  title: string;
  subtitle?: string;
  count?: number;
  countLabel?: string; // e.g. "items", "agents"
  actions?: ReactNode;
}

export function PageHeader({ icon: Icon, title, subtitle, count, countLabel, actions }: PageHeaderProps) {
  return (
    <div
      className="mb-4 flex flex-wrap items-end justify-between gap-3"
      style={{ animation: "fade-in 0.45s ease-out both" }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {Icon && (
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-muted/40 ring-1 ring-border/60">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
            </span>
          )}
          <h1 className="text-[15px] font-semibold tracking-tight text-foreground">{title}</h1>
          {typeof count === "number" && (
            <Badge variant="secondary" className="text-[10px] tabular-nums">
              {count}
              {countLabel ? ` ${countLabel}` : ""}
            </Badge>
          )}
        </div>
        {subtitle && <p className="ml-9 mt-0.5 text-[12px] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
