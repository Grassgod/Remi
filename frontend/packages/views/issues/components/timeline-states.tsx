"use client";

import { AlertCircle, MessagesSquare } from "lucide-react";
import { Button } from "@multiremi/ui/components/ui/button";
import { Skeleton } from "@multiremi/ui/components/ui/skeleton";
import { useT } from "../../i18n";

export function TimelineSkeleton() {
  return (
    <div className="mt-4 flex flex-col gap-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex gap-3 p-4">
          <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A session that has never been used at all. Distinct from
 * `TimelineUnavailable`: nothing failed here, there is simply nothing yet, and
 * the two ways to change that both live one click away.
 */
export function SessionEmptyState() {
  const { t } = useT("issues");
  return (
    <div className="mt-4 flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <MessagesSquare className="h-6 w-6 text-muted-foreground" />
      <p className="text-sm font-medium">{t(($) => $.detail.session_empty_title)}</p>
      <p className="text-xs text-muted-foreground">
        {t(($) => $.detail.session_empty_hint)}
      </p>
    </div>
  );
}

/**
 * Every comment and activity hangs off a Session, so an issue whose session
 * list fails (or comes back empty) has no timeline to query at all. Without
 * this state the whole activity area would just stay blank forever, with no
 * hint that anything went wrong and no way to try again.
 */
export function TimelineUnavailable({
  onRetry,
  retrying,
}: {
  onRetry: () => void;
  retrying: boolean;
}) {
  const { t } = useT("issues");
  return (
    <div className="mt-4 flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-10 text-center">
      <AlertCircle className="h-6 w-6 text-destructive" />
      <div>
        <p className="text-sm font-medium">
          {t(($) => $.detail.timeline_unavailable_title)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(($) => $.detail.timeline_unavailable_hint)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        disabled={retrying}
      >
        {t(($) => $.detail.timeline_retry)}
      </Button>
    </div>
  );
}
