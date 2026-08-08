"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@multiremi/ui/components/ui/empty";
import { cn } from "@multiremi/ui/lib/utils";

/**
 * The centred zero-state that every list, detail and wiki pane renders when it
 * has nothing to show. It used to be hand-rolled at fourteen sites with
 * byte-identical Tailwind strings; this is the single implementation, built on
 * the shadcn `Empty` primitive so the markup contract lives in the ui package.
 *
 * Two shapes exist in the product and both are kept:
 *
 * - `media` — the "you have not created one yet" state. A muted circle badge
 *   around the icon, a heading-sized title, a wide hint and an optional call to
 *   action. Callers passed an `<h2>` here before, so the title keeps the
 *   heading role explicitly.
 * - `status` — the "this failed / this is missing" state. A bare tinted icon,
 *   a smaller title and a fine-print detail line (an error message, usually),
 *   with the retry/back control as the action.
 *
 * The spacing and type scale are pinned here rather than inherited from
 * `Empty`'s defaults so the fourteen migrations were pixel-for-pixel no-ops.
 */
export function EmptyState({
  icon: Icon,
  variant = "media",
  tone = "muted",
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  variant?: "media" | "status";
  /** Icon tint for the `status` variant; `media` always renders muted. */
  tone?: "muted" | "destructive";
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const isMedia = variant === "media";
  return (
    <Empty
      className={cn(
        "px-6 py-16 text-wrap",
        isMedia ? "gap-0" : "gap-3",
        className
      )}
    >
      <EmptyMedia
        className={cn(
          "mb-0",
          isMedia && "h-12 w-12 rounded-full bg-muted"
        )}
      >
        <Icon
          className={cn(
            isMedia
              ? "h-6 w-6 text-muted-foreground"
              : tone === "destructive"
                ? "h-8 w-8 text-destructive"
                : "h-8 w-8 text-muted-foreground"
          )}
        />
      </EmptyMedia>
      <EmptyHeader className="max-w-none gap-0">
        <EmptyTitle
          className={cn(
            "font-sans tracking-normal",
            isMedia ? "mt-4 text-base font-semibold" : "text-sm font-medium"
          )}
          {...(isMedia ? { role: "heading", "aria-level": 2 } : {})}
        >
          {title}
        </EmptyTitle>
        {description ? (
          <EmptyDescription
            className={cn(
              "mt-1",
              isMedia ? "max-w-md text-sm" : "text-xs"
            )}
          >
            {description}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action}
    </Empty>
  );
}
